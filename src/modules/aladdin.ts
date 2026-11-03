import type { Db } from '../kernel/db.ts';
import { addSeconds, audit, nowIso, tx } from '../kernel/db.ts';
import { appendAnchor, latestAnchor } from '../kernel/anchor.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { assertNonEmptyString } from '../kernel/crypto.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { bps, formatBRL } from '../kernel/money.ts';
import { listBalances, postGroup } from '../domain/ledger.ts';
import {
  ALADDIN_MAX_LOAN_CENTS,
  ALADDIN_MAX_VAR_BPS,
  ALADDIN_MIN_SCORE,
  creditScoreFrom,
  maxLoanForScore,
  proofDigest,
  riskDigest,
  simulateMonteCarlo,
} from '../domain/aladdin.ts';
import type { RiskInputs } from '../domain/aladdin.ts';
import { ZK_CIRCUIT, proveNetWorth, verifyNetWorthProof } from './zk-snark.ts';

const RISK_SOURCES = ['MONTE_CARLO', 'ORACLE_FUSION', 'OPERATOR'] as const;
const MAX_PRINCIPAL = ALADDIN_MAX_LOAN_CENTS;
const MAX_TTL_SECONDS = 86_400;

type RiskSource = (typeof RISK_SOURCES)[number];

interface RiskRow {
  id: string;
  merchant_id: string;
  var_bps: number;
  volatility_bps: number;
  credit_score: number;
  model: string;
  source: RiskSource;
  sample_size: number;
  observed_at: string;
  expires_at: string;
  digest: string;
  created_at: string;
}

interface ProofRow {
  id: string;
  merchant_id: string;
  circuit: string;
  commitment: string;
  threshold_cents: number;
  proof_hash: string;
  public_signals: string;
  proof_json: string;
  verified: number;
  verifier: string;
  consumed_by: string | null;
  created_at: string;
  verified_at: string | null;
}

interface LoanRow {
  id: string;
  borrower_id: string;
  principal_cents: number;
  outstanding_cents: number;
  interest_bps: number;
  risk_metric_id: string;
  zk_proof_id: string;
  score: number;
  var_bps: number;
  status: 'OPEN' | 'REPAID';
  due_at: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  commitment?: string | null;
}

function positiveInt(value: unknown, field: string, max = MAX_PRINCIPAL): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw Errors.validation(`${field} deve ser um inteiro positivo até ${max}.`);
  }
  return value;
}

function boundedInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw Errors.validation(`${field} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function merchantIdOf(value: unknown, field = 'merchantId'): string {
  const id = assertNonEmptyString(value, field, 80);
  if (!/^[A-Za-z0-9_.:@-]{3,80}$/.test(id)) throw Errors.validation(`${field} contém caracteres inválidos.`);
  return id;
}

function publicRisk(row: RiskRow, nowMs: number = Date.now()) {
  const valid = Date.parse(row.expires_at) > nowMs;
  return {
    id: row.id,
    merchantId: row.merchant_id,
    varBps: row.var_bps,
    varPct: row.var_bps / 100,
    volatilityBps: row.volatility_bps,
    volatilityPct: row.volatility_bps / 100,
    creditScore: row.credit_score,
    model: row.model,
    source: row.source,
    sampleSize: row.sample_size,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    valid,
    digest: row.digest,
    createdAt: row.created_at,
  };
}

function publicProof(row: ProofRow) {
  let publicSignals: string[] = [];
  try {
    const parsed = JSON.parse(row.public_signals) as unknown;
    if (Array.isArray(parsed)) publicSignals = parsed.map(String);
  } catch {
    publicSignals = [];
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    circuit: row.circuit,
    commitment: row.commitment,
    thresholdCents: row.threshold_cents,
    thresholdFormatted: formatBRL(row.threshold_cents),
    proofHash: row.proof_hash,
    publicSignals,
    verified: row.verified === 1,
    verifier: row.verifier,
    consumedBy: row.consumed_by,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

function publicLoan(row: LoanRow, nowMs: number = Date.now()) {
  const total = row.principal_cents + bps(row.principal_cents, row.interest_bps);
  const paid = total - Math.max(0, row.outstanding_cents);
  return {
    id: row.id,
    borrowerId: row.borrower_id,
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    outstandingCents: row.outstanding_cents,
    outstandingFormatted: formatBRL(row.outstanding_cents),
    interestBps: row.interest_bps,
    score: row.score,
    varBps: row.var_bps,
    riskMetricId: row.risk_metric_id,
    zkProofId: row.zk_proof_id,
    commitment: row.commitment ?? null,
    status: row.status,
    overdue: row.status === 'OPEN' && Date.parse(row.due_at) < nowMs,
    dueAt: row.due_at,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    progressPct: total === 0 ? 100 : Math.min(100, Math.max(0, Math.round((paid * 100) / total))),
  };
}

/**
 * Motor Aladdin: risco quantitativo injetado por IA, prova Groth16 de patrimônio e
 * crédito algorítmico com dupla checagem (score/VaR + prova verificada) e partidas dobradas.
 */
export class AladdinEngine {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  simulateRisk(input: {
    merchantId: string;
    volatilityBps?: number;
    driftBps?: number;
    samples?: number;
    confidenceBps?: number;
    ttlSeconds?: number;
    hasCollateral?: boolean;
    onTimeRatioBps?: number;
    now?: number;
  }) {
    const merchant = merchantIdOf(input.merchantId);
    this.ensureMerchant(merchant);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const day = now.slice(0, 10);
    const simulation = simulateMonteCarlo({
      seedParts: [merchant, day, input.volatilityBps ?? 250, input.confidenceBps ?? 9_900],
      samples: input.samples,
      confidenceBps: input.confidenceBps,
      driftBps: input.driftBps,
      volatilityBps: input.volatilityBps,
    });
    const score = creditScoreFrom({
      varBps: simulation.varBps,
      volatilityBps: simulation.volatilityBps,
      liquidityCents: this.merchantAvailable(merchant),
      hasCollateral: input.hasCollateral,
      onTimeRatioBps: input.onTimeRatioBps,
    });
    return this.storeRisk({
      merchantId: merchant,
      varBps: simulation.varBps,
      volatilityBps: simulation.volatilityBps,
      creditScore: score,
      model: 'aladdin-monte-carlo-v1',
      source: 'MONTE_CARLO',
      sampleSize: simulation.sampleSize,
      ttlSeconds: input.ttlSeconds,
      now: nowMs,
    });
  }

  recordRisk(input: {
    merchantId: string;
    varBps: number;
    volatilityBps: number;
    creditScore: number;
    model?: string;
    source?: string;
    sampleSize?: number;
    ttlSeconds?: number;
    now?: number;
  }) {
    const merchant = merchantIdOf(input.merchantId);
    this.ensureMerchant(merchant);
    const source = String(input.source ?? 'OPERATOR').toUpperCase() as RiskSource;
    if (!RISK_SOURCES.includes(source) || source === 'MONTE_CARLO') {
      throw Errors.validation('source deve ser ORACLE_FUSION ou OPERATOR.');
    }
    return this.storeRisk({
      merchantId: merchant,
      varBps: boundedInt(input.varBps, 'varBps', 0, 10_000),
      volatilityBps: boundedInt(input.volatilityBps, 'volatilityBps', 0, 100_000),
      creditScore: boundedInt(input.creditScore, 'creditScore', 0, 10_000),
      model: assertNonEmptyString(input.model ?? 'oracle-fusion-v1', 'model', 80),
      source,
      sampleSize: boundedInt(input.sampleSize ?? 0, 'sampleSize', 0, 50_000),
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
  }

  private storeRisk(input: {
    merchantId: string;
    varBps: number;
    volatilityBps: number;
    creditScore: number;
    model: string;
    source: RiskSource;
    sampleSize: number;
    ttlSeconds?: number;
    now?: number;
  }) {
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const ttl = input.ttlSeconds === undefined ? 3_600 : positiveInt(input.ttlSeconds, 'ttlSeconds', MAX_TTL_SECONDS);
    if (ttl < 60) throw Errors.validation('ttlSeconds mínimo é 60.');
    const expiresAt = addSeconds(now, ttl);
    const digest = riskDigest({
      merchantId: input.merchantId,
      model: input.model,
      source: input.source,
      observedAt: now,
      expiresAt,
      sampleSize: input.sampleSize,
      varBps: input.varBps,
      volatilityBps: input.volatilityBps,
      creditScore: input.creditScore,
    });
    const id = newId('rsq');
    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO aladdin_risk_metrics
             (id, merchant_id, var_bps, volatility_bps, credit_score, model, source, sample_size,
              observed_at, expires_at, digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.merchantId,
          input.varBps,
          input.volatilityBps,
          input.creditScore,
          input.model,
          input.source,
          input.sampleSize,
          now,
          expiresAt,
          digest,
          now,
        );
      const anchor = appendAnchor(
        this.db,
        {
          type: 'ALADDIN_RISK',
          merchantId: input.merchantId,
          metricId: id,
          varBps: input.varBps,
          volatilityBps: input.volatilityBps,
          creditScore: input.creditScore,
          digest,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'aladdin.risk',
        type: 'MetricaRisco',
        key: input.merchantId,
        payload: { metricId: id, varBps: input.varBps, creditScore: input.creditScore, anchorHeight: anchor.height },
      });
      audit(this.db, input.merchantId, 'ALADDIN_RISK', id, {
        varBps: input.varBps,
        volatilityBps: input.volatilityBps,
        creditScore: input.creditScore,
        source: input.source,
      });
      return { risk: publicRisk(this.riskRow(id), nowMs), anchorHeight: anchor.height };
    });
  }

  listRisk(merchantId: string, limit = 20) {
    const merchant = merchantIdOf(merchantId);
    const rows = this.db
      .prepare('SELECT * FROM aladdin_risk_metrics WHERE merchant_id = ? ORDER BY observed_at DESC LIMIT ?')
      .all(merchant, Math.min(Math.max(limit, 1), 200)) as unknown as RiskRow[];
    return rows.map((row) => publicRisk(row));
  }

  latestRisk(merchantId: string, nowMs: number = Date.now()): RiskRow {
    const row = this.db
      .prepare('SELECT * FROM aladdin_risk_metrics WHERE merchant_id = ? ORDER BY observed_at DESC LIMIT 1')
      .get(merchantId) as RiskRow | undefined;
    if (!row) throw new AppError('ALADDIN_RISK_MISSING', 'Sem métrica de risco para o titular.', 422);
    if (Date.parse(row.expires_at) <= nowMs) {
      throw new AppError('ALADDIN_RISK_STALE', 'Métrica de risco expirada; recalcule antes de operar.', 422, {
        metricId: row.id,
        expiresAt: row.expires_at,
      });
    }
    return row;
  }

  async prove(input: { netWorthCents: number; salt: string; thresholdCents: number }) {
    return proveNetWorth(input);
  }

  async submitProof(input: {
    merchantId: string;
    circuit?: string;
    thresholdCents: number;
    proof: unknown;
    publicSignals: unknown;
    expectedCommitment?: string;
    now?: number;
  }) {
    const merchant = merchantIdOf(input.merchantId);
    this.ensureMerchant(merchant);
    const circuit = String(input.circuit ?? ZK_CIRCUIT);
    if (circuit !== ZK_CIRCUIT) throw Errors.validation(`circuit deve ser ${ZK_CIRCUIT}.`);
    const threshold = positiveInt(input.thresholdCents, 'thresholdCents', Number.MAX_SAFE_INTEGER);
    const verification = await verifyNetWorthProof({
      proof: input.proof,
      publicSignals: input.publicSignals,
      expectedThresholdCents: threshold,
      expectedCommitment: input.expectedCommitment,
    });
    if (!verification.verified) {
      throw new AppError('ZK_PROOF_INVALID', 'A prova Groth16 não foi aceita pelo verificador.', 422);
    }
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const signals = (input.publicSignals as string[]).map(String);
    const digest = proofDigest(input.proof, signals);

    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 AS found FROM zk_snark_proofs WHERE proof_hash = ?').get(digest)) {
        throw Errors.conflict('Prova já registrada (anti-replay por hash de prova).');
      }
      const id = newId('zkp');
      this.db
        .prepare(
          `INSERT INTO zk_snark_proofs
             (id, merchant_id, circuit, commitment, threshold_cents, proof_hash, public_signals, proof_json,
              verified, verifier, consumed_by, created_at, verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          merchant,
          circuit,
          verification.commitment ?? signals[0] ?? '',
          threshold,
          digest,
          JSON.stringify(signals),
          JSON.stringify(input.proof),
          'groth16-bn254/networth-v1',
          now,
          now,
        );
      const anchor = appendAnchor(
        this.db,
        {
          type: 'ALADDIN_ZK_PROOF',
          merchantId: merchant,
          proofId: id,
          commitment: verification.commitment,
          thresholdCents: threshold,
          proofHash: digest,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'aladdin.zk.verified',
        type: 'ProvaZK',
        key: merchant,
        payload: { proofId: id, thresholdCents: threshold, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'ALADDIN_ZK_PROOF', id, { thresholdCents: threshold });
      return { proof: publicProof(this.proofRow(id)), anchorHeight: anchor.height };
    });
  }

  listProofs(merchantId: string, limit = 20) {
    const merchant = merchantIdOf(merchantId);
    const rows = this.db
      .prepare('SELECT * FROM zk_snark_proofs WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(merchant, Math.min(Math.max(limit, 1), 200)) as unknown as ProofRow[];
    return rows.map(publicProof);
  }

  openLoan(input: {
    borrowerId: string;
    principalCents: number;
    zkProofId: string;
    interestBps?: number;
    durationDays?: number;
    now?: number;
  }) {
    const borrower = merchantIdOf(input.borrowerId, 'borrowerId');
    this.ensureMerchant(borrower);
    const principal = positiveInt(input.principalCents, 'principalCents');
    const proofId = assertNonEmptyString(input.zkProofId, 'zkProofId', 80);
    const interestBps = boundedInt(input.interestBps ?? 1_800, 'interestBps', 0, 20_000);
    const durationDays = boundedInt(input.durationDays ?? 60, 'durationDays', 30, 360);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    const risk = this.latestRisk(borrower, nowMs);
    if (risk.credit_score < ALADDIN_MIN_SCORE) {
      throw new AppError('ALADDIN_SCORE_LOW', 'Score de crédito abaixo do mínimo do motor.', 422, {
        creditScore: risk.credit_score,
        minScore: ALADDIN_MIN_SCORE,
      });
    }
    if (risk.var_bps > ALADDIN_MAX_VAR_BPS) {
      throw new AppError('ALADDIN_VAR_HIGH', 'VaR acima do limite corporativo.', 422, {
        varBps: risk.var_bps,
        maxVarBps: ALADDIN_MAX_VAR_BPS,
      });
    }
    const maxByScore = maxLoanForScore(risk.credit_score);
    if (principal > maxByScore) {
      throw new AppError('ALADDIN_LIMIT_EXCEEDED', 'Principal acima da linha liberada pelo score.', 422, {
        principalCents: principal,
        maxPrincipalCents: maxByScore,
      });
    }

    const proof = this.proofRow(proofId);
    if (proof.merchant_id !== borrower) throw Errors.forbidden('Prova de outro titular.');
    if (proof.verified !== 1) throw new AppError('ZK_PROOF_INVALID', 'Prova não verificada.', 422);
    if (proof.consumed_by) throw new AppError('ZK_PROOF_CONSUMED', 'Prova já vinculada a um empréstimo.', 409);
    if (proof.threshold_cents < principal) {
      throw new AppError('ZK_THRESHOLD_LOW', 'Patrimônio comprovado abaixo do principal solicitado.', 422, {
        thresholdCents: proof.threshold_cents,
        principalCents: principal,
      });
    }

    const interestCents = bps(principal, interestBps);
    const outstanding = principal + interestCents;

    return tx(this.db, () => {
      const active = this.db
        .prepare("SELECT id FROM aladdin_loans WHERE borrower_id = ? AND status = 'OPEN' LIMIT 1")
        .get(borrower) as { id: string } | undefined;
      if (active) {
        throw new AppError('ALADDIN_LOAN_ACTIVE', 'Já existe empréstimo algorítmico em aberto.', 409, {
          loanId: active.id,
        });
      }
      const claimed = this.db
        .prepare('UPDATE zk_snark_proofs SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL')
        .run('pending', proof.id);
      if (claimed.changes !== 1) throw new AppError('ZK_PROOF_CONSUMED', 'Prova já consumida.', 409);

      const id = newId('ald');
      postGroup(this.db, {
        groupId: id,
        groupKind: 'ALADDIN_DISBURSEMENT',
        createdAt: now,
        entries: [
          { kind: 'CASH', direction: 'DEBIT', amountCents: principal, memo: `Empréstimo algorítmico ${id}` },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: borrower,
            direction: 'CREDIT',
            amountCents: principal,
            memo: 'Crédito Aladdin',
          },
        ],
      });
      this.db
        .prepare(
          `INSERT INTO aladdin_loans
             (id, borrower_id, principal_cents, outstanding_cents, interest_bps, risk_metric_id, zk_proof_id,
              score, var_bps, status, due_at, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL)`,
        )
        .run(
          id,
          borrower,
          principal,
          outstanding,
          interestBps,
          risk.id,
          proof.id,
          risk.credit_score,
          risk.var_bps,
          addSeconds(now, durationDays * 86_400),
          now,
          now,
        );
      this.db.prepare('UPDATE zk_snark_proofs SET consumed_by = ? WHERE id = ?').run(id, proof.id);
      const anchor = appendAnchor(
        this.db,
        {
          type: 'ALADDIN_LOAN_OPEN',
          loanId: id,
          borrower,
          principalCents: principal,
          outstandingCents: outstanding,
          score: risk.credit_score,
          varBps: risk.var_bps,
          proofId: proof.id,
          commitment: proof.commitment,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'aladdin.loan.opened',
        type: 'EmprestimoAlgoritmico',
        key: borrower,
        payload: {
          loanId: id,
          principalCents: principal,
          score: risk.credit_score,
          varBps: risk.var_bps,
          anchorHeight: anchor.height,
        },
      });
      audit(this.db, borrower, 'ALADDIN_LOAN_OPEN', id, {
        principal,
        score: risk.credit_score,
        varBps: risk.var_bps,
        proofId: proof.id,
      });
      return { loan: publicLoan(this.loanRow(id), nowMs), anchorHeight: anchor.height };
    });
  }

  listLoans(borrowerId: string, limit = 20) {
    const borrower = merchantIdOf(borrowerId, 'borrowerId');
    const rows = this.db
      .prepare(
        `SELECT l.*, p.commitment AS commitment
           FROM aladdin_loans l
           JOIN zk_snark_proofs p ON p.id = l.zk_proof_id
          WHERE l.borrower_id = ?
          ORDER BY l.created_at DESC LIMIT ?`,
      )
      .all(borrower, Math.min(Math.max(limit, 1), 200)) as unknown as LoanRow[];
    return rows.map((row) => publicLoan(row));
  }

  getLoan(loanId: string, borrowerId?: string) {
    const row = this.loanRow(loanId);
    if (borrowerId && row.borrower_id !== borrowerId) throw Errors.forbidden('Empréstimo de outro titular.');
    return publicLoan(row);
  }

  repayLoan(input: { loanId: string; borrowerId: string; amountCents?: number; now?: number }) {
    const borrower = merchantIdOf(input.borrowerId, 'borrowerId');
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    return tx(this.db, () => {
      const loan = this.loanRow(input.loanId);
      if (loan.borrower_id !== borrower) throw Errors.forbidden('Empréstimo de outro titular.');
      if (loan.status !== 'OPEN') throw Errors.conflict('Empréstimo já encerrado.');
      const amount =
        input.amountCents === undefined ? loan.outstanding_cents : positiveInt(input.amountCents, 'amountCents');
      if (amount > loan.outstanding_cents) throw Errors.validation('Pagamento excede o saldo devedor.');
      if (this.merchantAvailable(borrower) < amount) {
        throw new AppError('ALADDIN_INSUFFICIENT_CASH', 'Saldo disponível insuficiente para a parcela.', 422);
      }
      postGroup(this.db, {
        groupId: newId('alr'),
        groupKind: 'ALADDIN_REPAYMENT',
        createdAt: now,
        entries: [
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: borrower,
            direction: 'DEBIT',
            amountCents: amount,
            memo: `Parcela Aladdin ${loan.id}`,
          },
          { kind: 'CASH', direction: 'CREDIT', amountCents: amount, memo: `Recebimento Aladdin ${loan.id}` },
        ],
      });
      const remaining = loan.outstanding_cents - amount;
      const closed = remaining === 0;
      this.db
        .prepare(
          `UPDATE aladdin_loans SET outstanding_cents = ?, status = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
        )
        .run(remaining, closed ? 'REPAID' : 'OPEN', now, closed ? now : null, loan.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'ALADDIN_LOAN_REPAY', loanId: loan.id, borrower, amountCents: amount, remainingCents: remaining, closed },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'aladdin.loan.repaid',
        type: 'ParcelaAladdin',
        key: borrower,
        payload: { loanId: loan.id, amountCents: amount, remainingCents: remaining, closed, anchorHeight: anchor.height },
      });
      audit(this.db, borrower, 'ALADDIN_LOAN_REPAY', loan.id, { amount, remaining });
      return { loan: publicLoan(this.loanRow(loan.id), nowMs), anchorHeight: anchor.height };
    });
  }

  overview(merchantId: string, nowMs: number = Date.now()) {
    const merchant = merchantIdOf(merchantId);
    const latest = this.db
      .prepare('SELECT * FROM aladdin_risk_metrics WHERE merchant_id = ? ORDER BY observed_at DESC LIMIT 1')
      .get(merchant) as RiskRow | undefined;
    const loans = this.db
      .prepare(
        `SELECT l.*, p.commitment AS commitment FROM aladdin_loans l
           JOIN zk_snark_proofs p ON p.id = l.zk_proof_id
          WHERE l.borrower_id = ? ORDER BY l.created_at DESC LIMIT 50`,
      )
      .all(merchant) as unknown as LoanRow[];
    const proofs = this.db
      .prepare('SELECT COUNT(*) AS count FROM zk_snark_proofs WHERE merchant_id = ?')
      .get(merchant) as { count: number };
    const open = loans.filter((loan) => loan.status === 'OPEN');
    const outstanding = open.reduce((sum, loan) => sum + loan.outstanding_cents, 0);
    return {
      merchantId: merchant,
      risk: latest ? publicRisk(latest, nowMs) : null,
      policy: {
        minScore: ALADDIN_MIN_SCORE,
        maxVarBps: ALADDIN_MAX_VAR_BPS,
        maxLoanCents: ALADDIN_MAX_LOAN_CENTS,
        maxLoanFormatted: formatBRL(ALADDIN_MAX_LOAN_CENTS),
        circuit: ZK_CIRCUIT,
        verifier: 'groth16-bn254',
      },
      loans: {
        total: loans.length,
        open: open.length,
        outstandingCents: outstanding,
        outstandingFormatted: formatBRL(outstanding),
        items: loans.slice(0, 10).map((loan) => publicLoan(loan, nowMs)),
      },
      proofs: { total: proofs.count },
      anchors: this.anchorSummary(),
      generatedAt: nowIso(nowMs),
    };
  }

  private anchorSummary() {
    const anchor = latestAnchor(this.db);
    return anchor ? { height: anchor.height, latestHash: anchor.anchorHash } : { height: 0, latestHash: null };
  }

  private riskRow(id: string): RiskRow {
    const row = this.db.prepare('SELECT * FROM aladdin_risk_metrics WHERE id = ?').get(id) as RiskRow | undefined;
    if (!row) throw Errors.notFound('Métrica de risco não encontrada.');
    return row;
  }

  private proofRow(id: string): ProofRow {
    const row = this.db.prepare('SELECT * FROM zk_snark_proofs WHERE id = ?').get(id) as ProofRow | undefined;
    if (!row) throw Errors.notFound('Prova ZK não encontrada.');
    return row;
  }

  private loanRow(id: string): LoanRow {
    const row = this.db
      .prepare(
        `SELECT l.*, p.commitment AS commitment FROM aladdin_loans l
           JOIN zk_snark_proofs p ON p.id = l.zk_proof_id
          WHERE l.id = ?`,
      )
      .get(id) as LoanRow | undefined;
    if (!row) throw Errors.notFound('Empréstimo não encontrado.');
    return row;
  }

  private ensureMerchant(merchantId: string): void {
    const row = this.db.prepare('SELECT id, status FROM merchants WHERE id = ?').get(merchantId) as
      | { id: string; status: string }
      | undefined;
    if (!row) throw Errors.notFound('Estabelecimento não encontrado.');
    if (row.status !== 'ACTIVE') throw Errors.conflict('Estabelecimento não está ativo.');
  }

  private merchantAvailable(merchantId: string): number {
    const balances = listBalances(this.db, { ownerType: 'MERCHANT', ownerId: merchantId });
    const available = balances.find((row) => row.kind === 'MERCHANT_AVAILABLE');
    return available ? available.creditCents - available.debitCents : 0;
  }
}

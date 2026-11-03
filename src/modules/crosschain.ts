import type { Db } from '../kernel/db.ts';
import { addSeconds, audit, nowIso, tx } from '../kernel/db.ts';
import { appendAnchor } from '../kernel/anchor.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { assertNonEmptyString } from '../kernel/crypto.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { formatBRL } from '../kernel/money.ts';
import { listBalances, postGroup } from '../domain/ledger.ts';
import { CCIP_ESCROW_HOLDER, AI_SOLVER_MODEL, ccipMessageId, intentDigest, solverScore } from '../domain/aladdin.ts';
import { normalizeWeb3Symbol, normalizeAddress } from '../domain/web3.ts';

const MAX_UNITS = 1_000_000_000_000_000;
const MAX_FEE_CENTS = 10_000_000;
const STATUSES = ['OPEN', 'QUOTED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const;
const RISK_TIERS = ['A', 'B', 'C'] as const;

type IntentStatus = (typeof STATUSES)[number];
type RiskTier = (typeof RISK_TIERS)[number];

interface LaneRow {
  id: string;
  name: string;
  source_chain_id: number;
  dest_chain_id: number;
  source_selector: string;
  dest_selector: string;
  router: string;
  receiver: string;
  fee_bps: number;
  max_units: number;
  status: 'ACTIVE' | 'PAUSED';
  created_at: string;
}

interface LiquidityRow {
  merchant_id: string;
  lane_id: string;
  symbol: string;
  available_units: number;
  rate_bps: number;
  risk_tier: RiskTier;
  status: 'ACTIVE' | 'PAUSED';
  updated_at: string;
}

interface IntentRow {
  id: string;
  merchant_id: string;
  lane_id: string;
  symbol: string;
  amount_units: number;
  min_dest_units: number;
  fee_budget_cents: number;
  status: IntentStatus;
  selected_quote_id: string | null;
  ai_model: string | null;
  deadline: string;
  digest: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface QuoteRow {
  id: string;
  intent_id: string;
  solver_id: string;
  provider_merchant_id: string;
  dest_units: number;
  fee_cents: number;
  eta_seconds: number;
  risk_bps: number;
  score: number;
  status: 'OFFERED' | 'SELECTED' | 'REJECTED';
  created_at: string;
}

interface MessageRow {
  id: string;
  intent_id: string;
  quote_id: string;
  lane_id: string;
  message_id: string;
  sequence: number;
  sender_id: string;
  receiver: string;
  symbol: string;
  amount_units: number;
  dest_units: number;
  fee_cents: number;
  status: 'SENT' | 'SETTLED';
  digest: string;
  created_at: string;
  settled_at: string | null;
}

function holderId(value: unknown, field: string): string {
  const id = assertNonEmptyString(value, field, 80);
  if (!/^[A-Za-z0-9_.:@-]{3,80}$/.test(id)) throw Errors.validation(`${field} contém caracteres inválidos.`);
  return id;
}

function positiveInt(value: unknown, field: string, max = MAX_UNITS): number {
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

function selectorText(value: unknown, field: string): string {
  const selector = String(value ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(selector) || BigInt(selector) > 2n ** 64n - 1n) {
    throw Errors.validation(`${field} deve ser um uint64 decimal.`);
  }
  return selector;
}

function publicLane(row: LaneRow) {
  return {
    id: row.id,
    name: row.name,
    sourceChainId: row.source_chain_id,
    destChainId: row.dest_chain_id,
    sourceSelector: row.source_selector,
    destSelector: row.dest_selector,
    router: row.router,
    receiver: row.receiver,
    feeBps: row.fee_bps,
    maxUnits: row.max_units,
    status: row.status,
    createdAt: row.created_at,
  };
}

function publicLiquidity(row: LiquidityRow) {
  return {
    merchantId: row.merchant_id,
    laneId: row.lane_id,
    symbol: row.symbol,
    availableUnits: row.available_units,
    rateBps: row.rate_bps,
    riskTier: row.risk_tier,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function publicQuote(row: QuoteRow) {
  return {
    id: row.id,
    intentId: row.intent_id,
    solverId: row.solver_id,
    providerMerchantId: row.provider_merchant_id,
    destUnits: row.dest_units,
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    etaSeconds: row.eta_seconds,
    riskBps: row.risk_bps,
    score: row.score,
    status: row.status,
    createdAt: row.created_at,
  };
}

function publicIntent(row: IntentRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    laneId: row.lane_id,
    symbol: row.symbol,
    amountUnits: row.amount_units,
    minDestUnits: row.min_dest_units,
    feeBudgetCents: row.fee_budget_cents,
    feeBudgetFormatted: formatBRL(row.fee_budget_cents),
    status: row.status,
    selectedQuoteId: row.selected_quote_id,
    aiModel: row.ai_model,
    deadline: row.deadline,
    digest: row.digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function publicMessage(row: MessageRow) {
  return {
    id: row.id,
    intentId: row.intent_id,
    quoteId: row.quote_id,
    laneId: row.lane_id,
    messageId: row.message_id,
    sequence: row.sequence,
    senderId: row.sender_id,
    receiver: row.receiver,
    symbol: row.symbol,
    amountUnits: row.amount_units,
    destUnits: row.dest_units,
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    status: row.status,
    digest: row.digest,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/**
 * Tokenização cross-chain orientada por intents.
 *
 * O titular declara o resultado desejado (destino, mínimo aceito, prazo) e deposita unidades
 * em escrow. Solvers registram liquidez no destino e cotam; o motor escolhe a melhor cotação
 * por score auditável e a liquidação emite a mensagem CCIP correspondente.
 *
 * Limite honesto: a entrega no destino é registrada como mensagem CCIP liquidada em trilho
 * simulado; não há router CCIP real nem mint/burn entre chains nesta demonstração.
 */
export class CrossChainHub {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  registerLane(input: {
    name: string;
    sourceChainId: number;
    destChainId: number;
    sourceSelector: string;
    destSelector: string;
    router: string;
    receiver: string;
    feeBps?: number;
    maxUnits?: number;
    now?: number;
  }) {
    const name = assertNonEmptyString(input.name, 'name', 120);
    const sourceChainId = positiveInt(input.sourceChainId, 'sourceChainId', 2_147_483_647);
    const destChainId = positiveInt(input.destChainId, 'destChainId', 2_147_483_647);
    if (sourceChainId === destChainId) throw Errors.validation('sourceChainId e destChainId devem ser diferentes.');
    const sourceSelector = selectorText(input.sourceSelector, 'sourceSelector');
    const destSelector = selectorText(input.destSelector, 'destSelector');
    const router = normalizeAddress(input.router, 'router');
    const receiver = normalizeAddress(input.receiver, 'receiver');
    const feeBps = boundedInt(input.feeBps ?? 0, 'feeBps', 0, 1_000);
    const maxUnits = positiveInt(input.maxUnits ?? 1_000_000_000, 'maxUnits');
    const now = nowIso(input.now ?? Date.now());

    return tx(this.db, () => {
      const dupe = this.db
        .prepare('SELECT 1 AS found FROM ccip_lanes WHERE source_chain_id = ? AND dest_chain_id = ?')
        .get(sourceChainId, destChainId);
      if (dupe) throw Errors.conflict('Já existe lane CCIP para este par de chains.');
      const id = newId('ccl');
      this.db
        .prepare(
          `INSERT INTO ccip_lanes
             (id, name, source_chain_id, dest_chain_id, source_selector, dest_selector, router, receiver,
              fee_bps, max_units, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .run(
          id,
          name,
          sourceChainId,
          destChainId,
          sourceSelector,
          destSelector,
          router,
          receiver,
          feeBps,
          maxUnits,
          now,
        );
      const anchor = appendAnchor(
        this.db,
        { type: 'CCIP_LANE', laneId: id, sourceChainId, destChainId, sourceSelector, destSelector, router, receiver },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'ccip.lane.registered',
        type: 'LaneCCIP',
        key: id,
        payload: { laneId: id, sourceChainId, destChainId, anchorHeight: anchor.height },
      });
      audit(this.db, 'ccip', 'CCIP_LANE_REGISTER', id, { sourceChainId, destChainId });
      return { lane: publicLane(this.laneRow(id)), anchorHeight: anchor.height };
    });
  }

  listLanes(status?: string) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status.toUpperCase());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM ccip_lanes ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`,
      )
      .all(...params) as unknown as LaneRow[];
    return rows.map(publicLane);
  }

  registerLiquidity(input: {
    merchantId: string;
    laneId: string;
    symbol: string;
    availableUnits: number;
    rateBps?: number;
    riskTier?: string;
    now?: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    this.ensureMerchant(merchant);
    const lane = this.laneRow(input.laneId);
    if (lane.status !== 'ACTIVE') throw Errors.conflict('Lane CCIP pausada.');
    const symbol = normalizeWeb3Symbol(input.symbol);
    const availableUnits = boundedInt(input.availableUnits, 'availableUnits', 0, MAX_UNITS);
    const rateBps = boundedInt(input.rateBps ?? 0, 'rateBps', 0, 2_000);
    const riskTier = String(input.riskTier ?? 'B').toUpperCase() as RiskTier;
    if (!RISK_TIERS.includes(riskTier)) throw Errors.validation('riskTier deve ser A, B ou C.');
    const now = nowIso(input.now ?? Date.now());
    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO ccip_liquidity (merchant_id, lane_id, symbol, available_units, rate_bps, risk_tier, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
           ON CONFLICT (merchant_id, lane_id, symbol)
           DO UPDATE SET available_units = excluded.available_units, rate_bps = excluded.rate_bps,
                         risk_tier = excluded.risk_tier, status = 'ACTIVE', updated_at = excluded.updated_at`,
        )
        .run(merchant, lane.id, symbol, availableUnits, rateBps, riskTier, now);
      const anchor = appendAnchor(
        this.db,
        { type: 'CCIP_LIQUIDITY', merchantId: merchant, laneId: lane.id, symbol, availableUnits, rateBps, riskTier },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'ccip.liquidity.updated',
        type: 'LiquidezP2P',
        key: merchant,
        payload: { laneId: lane.id, symbol, availableUnits, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'CCIP_LIQUIDITY', lane.id, { symbol, availableUnits, rateBps, riskTier });
      return { liquidity: publicLiquidity(this.liquidityRow(merchant, lane.id, symbol)), anchorHeight: anchor.height };
    });
  }

  listLiquidity(filter?: { laneId?: string; status?: string }) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.laneId) {
      clauses.push('lane_id = ?');
      params.push(filter.laneId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status.toUpperCase());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM ccip_liquidity ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY available_units DESC, merchant_id`,
      )
      .all(...params) as unknown as LiquidityRow[];
    return rows.map(publicLiquidity);
  }

  createIntent(input: {
    merchantId: string;
    laneId: string;
    symbol: string;
    amountUnits: number;
    minDestUnits: number;
    feeBudgetCents?: number;
    deadlineSeconds?: number;
    now?: number;
  }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    this.ensureMerchant(merchant);
    const lane = this.laneRow(input.laneId);
    if (lane.status !== 'ACTIVE') throw Errors.conflict('Lane CCIP pausada.');
    const symbol = normalizeWeb3Symbol(input.symbol);
    const amountUnits = positiveInt(input.amountUnits, 'amountUnits');
    if (amountUnits > lane.max_units) {
      throw new AppError('CCIP_LANE_LIMIT', 'Volume acima do teto da lane CCIP.', 422, { maxUnits: lane.max_units });
    }
    const minDestUnits = positiveInt(input.minDestUnits, 'minDestUnits');
    const feeBudgetCents = boundedInt(input.feeBudgetCents ?? 0, 'feeBudgetCents', 0, MAX_FEE_CENTS);
    const deadlineSeconds = boundedInt(input.deadlineSeconds ?? 3_600, 'deadlineSeconds', 60, 604_800);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    const deadline = addSeconds(now, deadlineSeconds);
    const digest = intentDigest({ merchantId: merchant, laneId: lane.id, symbol, amountUnits, minDestUnits, feeBudgetCents, deadline });

    return tx(this.db, () => {
      const asset = this.tokenAsset(symbol);
      if (this.holdingUnits(asset.id, merchant) < amountUnits) {
        throw new AppError('INTENT_INSUFFICIENT_UNITS', 'Saldo insuficiente do ativo para a intent.', 422);
      }
      const id = newId('int');
      this.moveUnits(asset.id, merchant, CCIP_ESCROW_HOLDER, amountUnits, now);
      this.db
        .prepare(
          `INSERT INTO crosschain_intents
             (id, merchant_id, lane_id, symbol, amount_units, min_dest_units, fee_budget_cents, status,
              selected_quote_id, ai_model, deadline, digest, created_at, updated_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?, ?, ?, ?, NULL)`,
        )
        .run(id, merchant, lane.id, symbol, amountUnits, minDestUnits, feeBudgetCents, deadline, digest, now, now);
      const anchor = appendAnchor(
        this.db,
        {
          type: 'CCIP_INTENT_OPEN',
          intentId: id,
          merchant,
          laneId: lane.id,
          symbol,
          amountUnits,
          minDestUnits,
          deadline,
          digest,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'ccip.intent.opened',
        type: 'IntentCrossChain',
        key: merchant,
        payload: { intentId: id, laneId: lane.id, symbol, amountUnits, minDestUnits, anchorHeight: anchor.height },
      });
      audit(this.db, merchant, 'CCIP_INTENT_OPEN', id, { amountUnits, minDestUnits, feeBudgetCents, deadline });
      return { intent: publicIntent(this.intentRow(id)), anchorHeight: anchor.height };
    });
  }

  quoteIntent(input: {
    intentId: string;
    solverId: string;
    providerMerchantId: string;
    destUnits: number;
    feeCents: number;
    etaSeconds: number;
    riskBps: number;
    now?: number;
  }) {
    const solver = holderId(input.solverId, 'solverId');
    const provider = holderId(input.providerMerchantId, 'providerMerchantId');
    this.ensureMerchant(provider);
    const destUnits = positiveInt(input.destUnits, 'destUnits');
    const feeCents = boundedInt(input.feeCents, 'feeCents', 0, MAX_FEE_CENTS);
    const etaSeconds = boundedInt(input.etaSeconds, 'etaSeconds', 1, 86_400);
    const riskBps = boundedInt(input.riskBps, 'riskBps', 0, 10_000);
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);

    return tx(this.db, () => {
      const intent = this.intentRow(input.intentId);
      if (intent.status === 'EXPIRED' || Date.parse(intent.deadline) <= nowMs) {
        throw new AppError('INTENT_EXPIRED', 'Intent expirada.', 422);
      }
      if (intent.status !== 'OPEN' && intent.status !== 'QUOTED') {
        throw new AppError('INTENT_INVALID_STATE', 'Intent não aceita novas cotações.', 409);
      }
      if (destUnits < intent.min_dest_units) {
        throw new AppError('INTENT_QUOTE_LOW', 'Cotação abaixo do mínimo aceito.', 422, {
          minDestUnits: intent.min_dest_units,
        });
      }
      if (intent.fee_budget_cents > 0 && feeCents > intent.fee_budget_cents) {
        throw new AppError('INTENT_FEE_BUDGET', 'Taxa acima do orçamento da intent.', 422, {
          feeBudgetCents: intent.fee_budget_cents,
        });
      }
      const liquidity = this.liquidityRow(provider, intent.lane_id, intent.symbol);
      if (liquidity.status !== 'ACTIVE') throw new AppError('CCIP_LIQUIDITY_INSUFFICIENT', 'Provedor pausado.', 422);
      if (liquidity.available_units < destUnits) {
        throw new AppError('CCIP_LIQUIDITY_INSUFFICIENT', 'Liquidez de destino insuficiente.', 422, {
          availableUnits: liquidity.available_units,
        });
      }
      const score = solverScore({
        amountUnits: intent.amount_units,
        destUnits,
        feeCents,
        feeBudgetCents: intent.fee_budget_cents,
        etaSeconds,
        riskBps,
      });
      const id = newId('qot');
      this.db
        .prepare(
          `INSERT INTO crosschain_quotes
             (id, intent_id, solver_id, provider_merchant_id, dest_units, fee_cents, eta_seconds, risk_bps,
              score, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?)`,
        )
        .run(id, intent.id, solver, provider, destUnits, feeCents, etaSeconds, riskBps, score, now);
      this.db
        .prepare("UPDATE crosschain_intents SET status = 'QUOTED', updated_at = ? WHERE id = ?")
        .run(now, intent.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'CCIP_INTENT_QUOTE', intentId: intent.id, quoteId: id, solver, provider, destUnits, feeCents, score },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'ccip.intent.quoted',
        type: 'CotacaoIntent',
        key: intent.merchant_id,
        payload: { intentId: intent.id, quoteId: id, score, destUnits, feeCents, anchorHeight: anchor.height },
      });
      audit(this.db, solver, 'CCIP_INTENT_QUOTE', intent.id, { quoteId: id, destUnits, feeCents, score });
      return { quote: publicQuote(this.quoteRow(id)), anchorHeight: anchor.height };
    });
  }

  selectQuote(intentId: string, merchantId: string, quoteId?: string) {
    const merchant = holderId(merchantId, 'merchantId');
    return tx(this.db, () => {
      const intent = this.intentRow(intentId);
      if (intent.merchant_id !== merchant) throw Errors.forbidden('Intent de outro titular.');
      if (intent.status !== 'OPEN' && intent.status !== 'QUOTED') {
        throw new AppError('INTENT_INVALID_STATE', 'Intent não está em cotação.', 409);
      }
      const quote = quoteId ? this.quoteRow(quoteId) : this.bestQuote(intent.id);
      if (quote.intent_id !== intent.id) throw Errors.validation('Cotação não pertence à intent.');
      const now = nowIso();
      this.db
        .prepare("UPDATE crosschain_quotes SET status = 'REJECTED' WHERE intent_id = ? AND id <> ?")
        .run(intent.id, quote.id);
      this.db.prepare("UPDATE crosschain_quotes SET status = 'SELECTED' WHERE id = ?").run(quote.id);
      this.db
        .prepare(
          `UPDATE crosschain_intents SET status = 'QUOTED', selected_quote_id = ?, ai_model = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(quote.id, AI_SOLVER_MODEL, now, intent.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'CCIP_INTENT_SELECT', intentId: intent.id, quoteId: quote.id, score: quote.score, model: AI_SOLVER_MODEL },
        now,
      );
      audit(this.db, merchant, 'CCIP_INTENT_SELECT', intent.id, { quoteId: quote.id, score: quote.score });
      return {
        intent: publicIntent(this.intentRow(intent.id)),
        quote: publicQuote(this.quoteRow(quote.id)),
        anchorHeight: anchor.height,
      };
    });
  }

  executeIntent(input: { intentId: string; merchantId: string; now?: number }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    const nowMs = input.now ?? Date.now();
    const now = nowIso(nowMs);
    return tx(this.db, () => {
      const intent = this.intentRow(input.intentId);
      if (intent.merchant_id !== merchant) throw Errors.forbidden('Intent de outro titular.');
      if (intent.status !== 'QUOTED') {
        throw new AppError('INTENT_INVALID_STATE', 'Intent precisa de cotação selecionada.', 409);
      }
      if (Date.parse(intent.deadline) <= nowMs) {
        throw new AppError('INTENT_EXPIRED', 'Intent expirada.', 422);
      }
      const lane = this.laneRow(intent.lane_id);
      if (lane.status !== 'ACTIVE') throw Errors.conflict('Lane CCIP pausada.');
      const quote = intent.selected_quote_id
        ? this.quoteRow(intent.selected_quote_id)
        : this.bestQuote(intent.id);
      if (quote.status !== 'SELECTED') {
        this.db.prepare("UPDATE crosschain_quotes SET status = 'SELECTED' WHERE id = ?").run(quote.id);
      }
      const liquidity = this.liquidityRow(quote.provider_merchant_id, intent.lane_id, intent.symbol);
      if (liquidity.status !== 'ACTIVE' || liquidity.available_units < quote.dest_units) {
        throw new AppError('CCIP_LIQUIDITY_INSUFFICIENT', 'Liquidez do solver insuficiente na liquidação.', 422);
      }
      if (quote.fee_cents > 0 && this.merchantAvailable(merchant) < quote.fee_cents) {
        throw new AppError('INTENT_INSUFFICIENT_CASH', 'Saldo insuficiente para a taxa do solver.', 422);
      }

      const asset = this.tokenAsset(intent.symbol);
      this.moveUnits(asset.id, CCIP_ESCROW_HOLDER, quote.provider_merchant_id, intent.amount_units, now);
      this.db
        .prepare(
          'UPDATE ccip_liquidity SET available_units = available_units - ?, updated_at = ? WHERE merchant_id = ? AND lane_id = ? AND symbol = ?',
        )
        .run(quote.dest_units, now, quote.provider_merchant_id, intent.lane_id, intent.symbol);
      if (quote.fee_cents > 0) {
        postGroup(this.db, {
          groupId: newId('ccf'),
          groupKind: 'CCIP_INTENT_FEE',
          createdAt: now,
          entries: [
            {
              kind: 'MERCHANT_AVAILABLE',
              ownerType: 'MERCHANT',
              ownerId: merchant,
              direction: 'DEBIT',
              amountCents: quote.fee_cents,
              memo: `Taxa intent ${intent.id}`,
            },
            { kind: 'FEE_REVENUE', direction: 'CREDIT', amountCents: quote.fee_cents, memo: `Solver ${quote.solver_id}` },
          ],
        });
      }

      const sequenceRow = this.db
        .prepare('SELECT MAX(sequence) AS seq FROM ccip_messages WHERE lane_id = ?')
        .get(intent.lane_id) as { seq: number | null } | undefined;
      const sequence = (sequenceRow?.seq ?? 0) + 1;
      const messageId = ccipMessageId({
        laneId: intent.lane_id,
        sequence,
        intentId: intent.id,
        receiver: lane.receiver,
        symbol: intent.symbol,
        amountUnits: intent.amount_units,
      });
      const messageRowId = newId('ccm');
      this.db
        .prepare(
          `INSERT INTO ccip_messages
             (id, intent_id, quote_id, lane_id, message_id, sequence, sender_id, receiver, symbol, amount_units,
              dest_units, fee_cents, status, digest, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?, ?, ?)`,
        )
        .run(
          messageRowId,
          intent.id,
          quote.id,
          intent.lane_id,
          messageId,
          sequence,
          merchant,
          lane.receiver,
          intent.symbol,
          intent.amount_units,
          quote.dest_units,
          quote.fee_cents,
          intent.digest,
          now,
          now,
        );
      this.db
        .prepare(
          `UPDATE crosschain_intents SET status = 'SETTLED', selected_quote_id = ?, ai_model = ?, settled_at = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(quote.id, AI_SOLVER_MODEL, now, now, intent.id);
      const anchor = appendAnchor(
        this.db,
        {
          type: 'CCIP_INTENT_SETTLED',
          intentId: intent.id,
          quoteId: quote.id,
          messageId,
          sequence,
          sender: merchant,
          provider: quote.provider_merchant_id,
          symbol: intent.symbol,
          amountUnits: intent.amount_units,
          destUnits: quote.dest_units,
          feeCents: quote.fee_cents,
          model: AI_SOLVER_MODEL,
        },
        now,
      );
      enqueueEvent(this.db, {
        topic: 'ccip.intent.settled',
        type: 'IntentLiquidada',
        key: merchant,
        payload: {
          intentId: intent.id,
          messageId,
          destUnits: quote.dest_units,
          provider: quote.provider_merchant_id,
          anchorHeight: anchor.height,
        },
      });
      audit(this.db, merchant, 'CCIP_INTENT_SETTLED', intent.id, {
        quoteId: quote.id,
        messageId,
        destUnits: quote.dest_units,
        feeCents: quote.fee_cents,
      });
      return {
        intent: publicIntent(this.intentRow(intent.id)),
        quote: publicQuote(this.quoteRow(quote.id)),
        message: publicMessage(this.messageRow(messageRowId)),
        anchorHeight: anchor.height,
      };
    });
  }

  cancelIntent(input: { intentId: string; merchantId: string; now?: number }) {
    const merchant = holderId(input.merchantId, 'merchantId');
    const now = nowIso(input.now ?? Date.now());
    return tx(this.db, () => {
      const intent = this.intentRow(input.intentId);
      if (intent.merchant_id !== merchant) throw Errors.forbidden('Intent de outro titular.');
      if (intent.status !== 'OPEN' && intent.status !== 'QUOTED') {
        throw new AppError('INTENT_INVALID_STATE', 'Intent não pode ser cancelada neste estado.', 409);
      }
      const asset = this.tokenAsset(intent.symbol);
      this.moveUnits(asset.id, CCIP_ESCROW_HOLDER, merchant, intent.amount_units, now);
      this.db.prepare("UPDATE crosschain_quotes SET status = 'REJECTED' WHERE intent_id = ?").run(intent.id);
      this.db
        .prepare("UPDATE crosschain_intents SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
        .run(now, intent.id);
      const anchor = appendAnchor(
        this.db,
        { type: 'CCIP_INTENT_CANCELLED', intentId: intent.id, merchant, amountUnits: intent.amount_units },
        now,
      );
      audit(this.db, merchant, 'CCIP_INTENT_CANCEL', intent.id, { amountUnits: intent.amount_units });
      return { intent: publicIntent(this.intentRow(intent.id)), anchorHeight: anchor.height };
    });
  }

  listIntents(filter?: { merchantId?: string; status?: string; limit?: number }) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.merchantId) {
      clauses.push('merchant_id = ?');
      params.push(filter.merchantId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status.toUpperCase());
    }
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM crosschain_intents ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as IntentRow[];
    return rows.map(publicIntent);
  }

  getIntent(intentId: string, merchantId?: string) {
    const intent = this.intentRow(intentId);
    if (merchantId && intent.merchant_id !== merchantId) throw Errors.forbidden('Intent de outro titular.');
    const quotes = this.db
      .prepare('SELECT * FROM crosschain_quotes WHERE intent_id = ? ORDER BY score DESC, fee_cents ASC')
      .all(intent.id) as unknown as QuoteRow[];
    const message = this.db
      .prepare('SELECT * FROM ccip_messages WHERE intent_id = ? ORDER BY sequence DESC LIMIT 1')
      .get(intent.id) as MessageRow | undefined;
    return {
      intent: publicIntent(intent),
      quotes: quotes.map(publicQuote),
      message: message ? publicMessage(message) : null,
    };
  }

  listMessages(filter?: { laneId?: string; limit?: number }) {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const rows = filter?.laneId
      ? (this.db
          .prepare('SELECT * FROM ccip_messages WHERE lane_id = ? ORDER BY sequence DESC LIMIT ?')
          .all(filter.laneId, limit) as unknown as MessageRow[])
      : (this.db
          .prepare('SELECT * FROM ccip_messages ORDER BY sequence DESC LIMIT ?')
          .all(limit) as unknown as MessageRow[]);
    return rows.map(publicMessage);
  }

  overview(merchantId: string) {
    const merchant = holderId(merchantId, 'merchantId');
    const lanes = this.listLanes('ACTIVE');
    const liquidity = this.db
      .prepare('SELECT * FROM ccip_liquidity WHERE merchant_id = ? AND status = ? ORDER BY available_units DESC')
      .all(merchant, 'ACTIVE') as unknown as LiquidityRow[];
    const intents = this.listIntents({ merchantId: merchant, limit: 100 });
    const settled = intents.filter((intent) => intent.status === 'SETTLED');
    const messages = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ccip_messages m
           JOIN crosschain_intents i ON i.id = m.intent_id WHERE i.merchant_id = ?`,
      )
      .get(merchant) as { count: number };
    return {
      merchantId: merchant,
      lanes: lanes.length,
      liquidity: liquidity.map(publicLiquidity),
      intents: {
        total: intents.length,
        open: intents.filter((intent) => intent.status === 'OPEN' || intent.status === 'QUOTED').length,
        settled: settled.length,
        volumeUnits: settled.reduce((sum, intent) => sum + intent.amountUnits, 0),
        deliveredUnits: settled.reduce((sum, intent) => {
          const quote = this.db
            .prepare('SELECT dest_units FROM crosschain_quotes WHERE id = ?')
            .get(intent.selectedQuoteId) as { dest_units: number } | undefined;
          return sum + (quote?.dest_units ?? 0);
        }, 0),
      },
      messages: { total: messages.count },
      model: AI_SOLVER_MODEL,
      generatedAt: nowIso(),
    };
  }

  private bestQuote(intentId: string): QuoteRow {
    const row = this.db
      .prepare('SELECT * FROM crosschain_quotes WHERE intent_id = ? ORDER BY score DESC, fee_cents ASC, eta_seconds ASC LIMIT 1')
      .get(intentId) as QuoteRow | undefined;
    if (!row) throw new AppError('INTENT_NO_QUOTES', 'Nenhuma cotação registrada para a intent.', 409);
    return row;
  }

  private laneRow(id: string): LaneRow {
    const row = this.db.prepare('SELECT * FROM ccip_lanes WHERE id = ?').get(id) as LaneRow | undefined;
    if (!row) throw Errors.notFound('Lane CCIP não encontrada.');
    return row;
  }

  private liquidityRow(merchantId: string, laneId: string, symbol: string): LiquidityRow {
    const row = this.db
      .prepare('SELECT * FROM ccip_liquidity WHERE merchant_id = ? AND lane_id = ? AND symbol = ?')
      .get(merchantId, laneId, symbol) as LiquidityRow | undefined;
    if (!row) throw new AppError('CCIP_LIQUIDITY_INSUFFICIENT', 'Provedor sem liquidez na lane.', 422);
    return row;
  }

  private intentRow(id: string): IntentRow {
    const row = this.db.prepare('SELECT * FROM crosschain_intents WHERE id = ?').get(id) as IntentRow | undefined;
    if (!row) throw Errors.notFound('Intent não encontrada.');
    return row;
  }

  private quoteRow(id: string): QuoteRow {
    const row = this.db.prepare('SELECT * FROM crosschain_quotes WHERE id = ?').get(id) as QuoteRow | undefined;
    if (!row) throw Errors.notFound('Cotação não encontrada.');
    return row;
  }

  private messageRow(id: string): MessageRow {
    const row = this.db.prepare('SELECT * FROM ccip_messages WHERE id = ?').get(id) as MessageRow | undefined;
    if (!row) throw Errors.notFound('Mensagem CCIP não encontrada.');
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

  private tokenAsset(symbol: string): { id: string } {
    const row = this.db.prepare('SELECT id, status FROM token_assets WHERE symbol = ?').get(symbol) as
      | { id: string; status: string }
      | undefined;
    if (!row) throw Errors.notFound(`Ativo tokenizado ${symbol} não encontrado.`);
    if (row.status === 'REDEEMED') throw Errors.conflict(`Ativo ${symbol} encerrado.`);
    return row;
  }

  private holdingUnits(assetId: string, holder: string): number {
    const row = this.db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(assetId, holder) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  private moveUnits(assetId: string, from: string, to: string, units: number, now: string): void {
    if (from === to) throw Errors.validation('Origem e destino das unidades devem ser diferentes.');
    const balance = this.holdingUnits(assetId, from);
    if (balance < units) throw new AppError('TOKEN_INSUFFICIENT_UNITS', 'Saldo de unidades insuficiente.', 422);
    if (balance - units === 0) {
      this.db.prepare('DELETE FROM token_holdings WHERE asset_id = ? AND holder_id = ?').run(assetId, from);
    } else {
      this.db
        .prepare('UPDATE token_holdings SET units = ?, updated_at = ? WHERE asset_id = ? AND holder_id = ?')
        .run(balance - units, now, assetId, from);
    }
    this.db
      .prepare(
        `INSERT INTO token_holdings (asset_id, holder_id, units, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (asset_id, holder_id) DO UPDATE SET units = units + excluded.units, updated_at = excluded.updated_at`,
      )
      .run(assetId, to, units, now);
    this.db
      .prepare(
        `INSERT INTO token_events (id, asset_id, kind, from_holder, to_holder, units, reserve_cents, anchor_height, created_at)
         VALUES (?, ?, 'TRANSFER', ?, ?, ?, 0, NULL, ?)`,
      )
      .run(newId('tke'), assetId, from, to, units, now);
  }
}

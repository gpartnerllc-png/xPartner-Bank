import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { assertPositiveCents, formatBRL, type Cents } from '../kernel/money.ts';
import {
  accountView,
  TREASURY_ACCOUNT_ID,
  TREASURY_USER_ID,
  type BankAccountRow,
  type BankAccountView,
  type BankService,
  type CreditScore,
  type TransferView,
} from './bank.ts';

export type CreditProduct = 'ANTECIPACAO' | 'EMPRESTIMO';

export const CREDIT_MIN_CENTS = 10_000; // R$ 100,00
export const CREDIT_MAX_CENTS = 5_000_000; // R$ 50.000,00
export const CREDIT_MAX_INSTALLMENTS = 12;
export const ANTECIPACAO_TERM_DAYS = 30;
export const TREASURY_ACCOUNT_NUMBER = '00000000';

export const CREDIT_PRODUCTS: Record<CreditProduct, { label: string; termLabel: string; maxInstallments: number }> = {
  ANTECIPACAO: { label: 'Antecipação de recebível', termLabel: '30 dias', maxInstallments: 1 },
  EMPRESTIMO: { label: 'Empréstimo pessoal', termLabel: '1 a 12 meses', maxInstallments: CREDIT_MAX_INSTALLMENTS },
};

// Taxa mensal (ou de 30 dias, na antecipação) por faixa de score interno.
const ANTECIPACAO_RATES_BPS: Record<string, number> = {
  MUITO_BAIXO: 149,
  BAIXO: 179,
  MEDIO: 229,
  ALTO: 299,
  MUITO_ALTO: 399,
};
const EMPRESTIMO_RATES_BPS: Record<string, number> = {
  MUITO_BAIXO: 249,
  BAIXO: 299,
  MEDIO: 349,
  ALTO: 429,
  MUITO_ALTO: 549,
};

const CREDIT_DISCLAIMER =
  'Crédito concedido com capital próprio da tesouraria xPartner e garantido pelo livro-razão interno. ' +
  'Não é operação registrada no SCR/BACEN nem oferta pública de crédito.';

export interface CreditContractRow {
  id: string;
  user_id: string;
  account_id: string;
  contract_number: string;
  product: CreditProduct;
  status: 'OPEN' | 'PAID';
  requested_cents: number;
  principal_cents: number;
  total_due_cents: number;
  paid_cents: number;
  outstanding_cents: number;
  monthly_rate_bps: number;
  installments: number;
  score: number;
  disbursement_transfer_id: string | null;
  settled_early: number;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CreditInstallmentRow {
  id: string;
  contract_id: string;
  number: number;
  due_date: string;
  principal_cents: number;
  interest_cents: number;
  total_cents: number;
  status: 'OPEN' | 'PAID';
  paid_at: string | null;
  payment_transfer_id: string | null;
}

export interface CreditScheduleEntry {
  number: number;
  dueDate: string;
  principalCents: Cents;
  principalFormatted: string;
  interestCents: Cents;
  interestFormatted: string;
  totalCents: Cents;
  totalFormatted: string;
  status: string;
  paidAt: string | null;
}

export interface CreditQuote {
  product: CreditProduct;
  productLabel: string;
  termLabel: string;
  amountCents: Cents;
  amountFormatted: string;
  principalCents: Cents;
  principalFormatted: string;
  interestCents: Cents;
  interestFormatted: string;
  totalDueCents: Cents;
  totalDueFormatted: string;
  monthlyRateBps: number;
  monthlyRatePercent: number;
  installments: number;
  score: number;
  band: string;
  availableLimitCents: Cents;
  availableLimitFormatted: string;
  schedule: CreditScheduleEntry[];
  disclaimer: string;
}

export interface CreditContractView {
  id: string;
  contractNumber: string;
  status: string;
  product: CreditProduct;
  productLabel: string;
  termLabel: string;
  amountCents: Cents;
  amountFormatted: string;
  principalCents: Cents;
  principalFormatted: string;
  interestCents: Cents;
  interestFormatted: string;
  totalDueCents: Cents;
  totalDueFormatted: string;
  monthlyRateBps: number;
  monthlyRatePercent: number;
  installments: number;
  score: number;
  band: string;
  paidCents: Cents;
  paidFormatted: string;
  outstandingCents: Cents;
  outstandingFormatted: string;
  settledEarly: boolean;
  disbursementTransferId: string | null;
  paidInstallments: number;
  openInstallments: number;
  nextDueDate: string | null;
  schedule: CreditScheduleEntry[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  disclaimer: string;
}

export interface CreditLine {
  score: number;
  band: string;
  suggestedLimitCents: Cents;
  suggestedLimitFormatted: string;
  outstandingPrincipalCents: Cents;
  outstandingPrincipalFormatted: string;
  availableLimitCents: Cents;
  availableLimitFormatted: string;
  maxCents: Cents;
  maxFormatted: string;
  minCents: Cents;
  minFormatted: string;
  products: typeof CREDIT_PRODUCTS;
  factors: CreditScore['factors'];
  computedAt: string;
  disclaimer: string;
}

function addDaysIso(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Soma meses preservando o dia e ajustando para o último dia do mês quando necessário. */
function addMonthsClamped(baseIso: string, months: number): string {
  const base = new Date(baseIso);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function monthlyRatePercent(bps: number): number {
  return Number((bps / 100).toFixed(2));
}

function normalizeProduct(value: string | undefined): CreditProduct {
  const product = String(value ?? '').trim().toUpperCase() as CreditProduct;
  if (product !== 'ANTECIPACAO' && product !== 'EMPRESTIMO') {
    throw Errors.validation('Produto deve ser ANTECIPACAO ou EMPRESTIMO.');
  }
  return product;
}

function productRateBps(product: CreditProduct, band: string): number {
  const table = product === 'ANTECIPACAO' ? ANTECIPACAO_RATES_BPS : EMPRESTIMO_RATES_BPS;
  const rate = table[band];
  if (!rate) {
    throw new AppError(
      'CREDIT_DENIED',
      'Crédito não disponível para esta faixa de score. Mantenha movimentação e saldo para reavaliar.',
      422,
    );
  }
  return rate;
}

interface ScheduleBuild {
  principalCents: number;
  totalDueCents: number;
  rows: Array<Omit<CreditInstallmentRow, 'id' | 'contract_id' | 'status' | 'paid_at' | 'payment_transfer_id'>>;
}

/**
 * Monta a agenda contratual. Antecipação: face value com deságio de 30 dias.
 * Empréstimo: tabela Price com parcelas fixas e última parcela ajustada.
 */
function buildSchedule(
  product: CreditProduct,
  amountCents: number,
  rateBps: number,
  installments: number,
  createdAtIso: string,
): ScheduleBuild {
  const createdDate = createdAtIso.slice(0, 10);
  if (product === 'ANTECIPACAO') {
    const interest = Math.max(1, Math.round((amountCents * rateBps) / (10_000 + rateBps)));
    const principal = amountCents - interest;
    if (principal < 1) throw Errors.validation('Valor insuficiente para antecipação.');
    return {
      principalCents: principal,
      totalDueCents: amountCents,
      rows: [
        {
          number: 1,
          due_date: addDaysIso(createdDate, ANTECIPACAO_TERM_DAYS),
          principal_cents: principal,
          interest_cents: interest,
          total_cents: amountCents,
        },
      ],
    };
  }

  const i = rateBps / 10_000;
  const factor = Math.pow(1 + i, installments);
  const payment = Math.round((amountCents * i * factor) / (factor - 1));
  let balance = amountCents;
  const rows: ScheduleBuild['rows'] = [];
  for (let number = 1; number <= installments; number += 1) {
    const interest = Math.round(balance * i);
    const principal = number === installments ? balance : Math.min(balance, Math.max(1, payment - interest));
    const total = number === installments ? principal + interest : payment;
    balance -= principal;
    rows.push({
      number,
      due_date: addMonthsClamped(createdDate, number),
      principal_cents: principal,
      interest_cents: interest,
      total_cents: total,
    });
  }
  if (balance !== 0) {
    throw new AppError('SCHEDULE_INCONSISTENT', 'Falha interna ao montar a agenda de parcelas.', 500);
  }
  const totalDue = rows.reduce((sum, row) => sum + row.total_cents, 0);
  return { principalCents: amountCents, totalDueCents: totalDue, rows };
}

function installmentView(row: CreditInstallmentRow): CreditScheduleEntry {
  return {
    number: row.number,
    dueDate: row.due_date,
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    interestCents: row.interest_cents,
    interestFormatted: formatBRL(row.interest_cents),
    totalCents: row.total_cents,
    totalFormatted: formatBRL(row.total_cents),
    status: row.status,
    paidAt: row.paid_at,
  };
}

export class BankCreditService {
  private readonly db: Db;
  private readonly bank: BankService;

  constructor(db: Db, bank: BankService) {
    this.db = db;
    this.bank = bank;
  }

  private accountFor(userId: string): BankAccountRow {
    const account = this.db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId) as
      | BankAccountRow
      | undefined;
    if (!account) throw Errors.notFound('Conta bancária não encontrada.');
    if (account.status !== 'ACTIVE') {
      throw new AppError('ACCOUNT_BLOCKED', 'Conta bloqueada ou encerrada para crédito.', 403);
    }
    return account;
  }

  private outstandingPrincipalCents(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(i.principal_cents), 0) AS principal
           FROM bank_credit_installments i
           JOIN bank_credit_contracts c ON c.id = i.contract_id
          WHERE c.user_id = ? AND i.status = 'OPEN'`,
      )
      .get(userId) as { principal: number };
    return row.principal;
  }

  line(userId: string, now = Date.now()): CreditLine {
    const account = this.accountFor(userId);
    const score = this.bank.creditScore(account.id, now);
    const outstanding = this.outstandingPrincipalCents(userId);
    const ceiling = Math.min(score.suggestedLimitCents, CREDIT_MAX_CENTS);
    const available = Math.max(0, ceiling - outstanding);
    return {
      score: score.score,
      band: score.band,
      suggestedLimitCents: score.suggestedLimitCents,
      suggestedLimitFormatted: formatBRL(score.suggestedLimitCents),
      outstandingPrincipalCents: outstanding,
      outstandingPrincipalFormatted: formatBRL(outstanding),
      availableLimitCents: available,
      availableLimitFormatted: formatBRL(available),
      maxCents: ceiling,
      maxFormatted: formatBRL(ceiling),
      minCents: CREDIT_MIN_CENTS,
      minFormatted: formatBRL(CREDIT_MIN_CENTS),
      products: CREDIT_PRODUCTS,
      factors: score.factors,
      computedAt: score.computedAt,
      disclaimer: CREDIT_DISCLAIMER,
    };
  }

  quote(
    userId: string,
    input: { product: string; amountCents: number; installments?: number; now?: number },
  ): CreditQuote {
    const now = input.now ?? Date.now();
    const product = normalizeProduct(input.product);
    const amount = assertPositiveCents(input.amountCents, 'amountCents');
    if (amount < CREDIT_MIN_CENTS) {
      throw Errors.validation(`Valor mínimo de crédito é ${formatBRL(CREDIT_MIN_CENTS)}.`);
    }
    if (amount > CREDIT_MAX_CENTS) {
      throw Errors.validation(`Valor máximo por contrato é ${formatBRL(CREDIT_MAX_CENTS)}.`);
    }
    const config = CREDIT_PRODUCTS[product];
    const installments = product === 'ANTECIPACAO' ? 1 : Math.trunc(input.installments ?? 1);
    if (installments < 1 || installments > config.maxInstallments) {
      throw Errors.validation(`Parcelas devem estar entre 1 e ${config.maxInstallments}.`);
    }

    const account = this.accountFor(userId);
    const score = this.bank.creditScore(account.id, now);
    const rateBps = productRateBps(product, score.band);
    const ceiling = Math.min(score.suggestedLimitCents, CREDIT_MAX_CENTS);
    const available = Math.max(0, ceiling - this.outstandingPrincipalCents(userId));
    if (amount > available) {
      throw new AppError(
        'CREDIT_LIMIT',
        `Valor acima do limite disponível de ${formatBRL(available)}.`,
        422,
      );
    }

    const schedule = buildSchedule(product, amount, rateBps, installments, nowIso(now));
    const disbursed = schedule.principalCents;
    return {
      product,
      productLabel: config.label,
      termLabel: config.termLabel,
      amountCents: amount,
      amountFormatted: formatBRL(amount),
      principalCents: disbursed,
      principalFormatted: formatBRL(disbursed),
      interestCents: schedule.totalDueCents - disbursed,
      interestFormatted: formatBRL(schedule.totalDueCents - disbursed),
      totalDueCents: schedule.totalDueCents,
      totalDueFormatted: formatBRL(schedule.totalDueCents),
      monthlyRateBps: rateBps,
      monthlyRatePercent: monthlyRatePercent(rateBps),
      installments,
      score: score.score,
      band: score.band,
      availableLimitCents: available,
      availableLimitFormatted: formatBRL(available),
      schedule: schedule.rows.map((row) =>
        installmentView({
          ...row,
          id: '',
          contract_id: '',
          status: 'OPEN',
          paid_at: null,
          payment_transfer_id: null,
        }),
      ),
      disclaimer: CREDIT_DISCLAIMER,
    };
  }

  create(
    userId: string,
    input: { product: string; amountCents: number; installments?: number; idempotencyKey?: string; now?: number },
  ): { contract: CreditContractView; account: BankAccountView; transfer: TransferView; replayed: boolean } {
    const now = input.now ?? Date.now();
    const product = normalizeProduct(input.product);
    const amount = assertPositiveCents(input.amountCents, 'amountCents');
    const config = CREDIT_PRODUCTS[product];
    const installments = product === 'ANTECIPACAO' ? 1 : Math.trunc(input.installments ?? 1);
    if (installments < 1 || installments > config.maxInstallments) {
      throw Errors.validation(`Parcelas devem estar entre 1 e ${config.maxInstallments}.`);
    }
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length < 8) {
      throw Errors.validation('Idempotency-Key deve ter ao menos 8 caracteres.');
    }
    if (idempotencyKey && idempotencyKey.length > 120) {
      throw Errors.validation('Idempotency-Key excede 120 caracteres.');
    }
    const fingerprint = sha256Hex(`${product}|${amount}|${installments}`);

    return tx(this.db, () => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM bank_credit_contracts WHERE user_id = ? AND idempotency_key = ?')
          .get(userId, idempotencyKey) as unknown as CreditContractRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) {
            throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
          }
          const account = this.accountFor(userId);
          const transfer = this.db
            .prepare('SELECT * FROM bank_transfers WHERE id = ?')
            .get(existing.disbursement_transfer_id ?? '') as
            | { id: string; amount_cents: number; created_at: string }
            | undefined;
          return {
            contract: this.view(existing, this.installmentsOf(existing.id)),
            account: accountView(account),
            transfer: {
              id: transfer?.id ?? existing.disbursement_transfer_id ?? '',
              kind: 'CREDIT',
              status: 'POSTED',
              channel: 'CREDIT',
              direction: 'IN',
              amountCents: transfer?.amount_cents ?? existing.principal_cents,
              amountFormatted: formatBRL(transfer?.amount_cents ?? existing.principal_cents),
              description: `Crédito ${existing.contract_number}`,
              endToEndId: '',
              counterparty: {
                name: 'Tesouraria xPartner',
                documentMasked: '••.•••.•••/••••-••',
                account: '0000 / ••••0000',
              },
              createdAt: transfer?.created_at ?? existing.created_at,
            },
            replayed: true,
          };
        }
      }

      if (amount < CREDIT_MIN_CENTS) {
        throw Errors.validation(`Valor mínimo de crédito é ${formatBRL(CREDIT_MIN_CENTS)}.`);
      }
      if (amount > CREDIT_MAX_CENTS) {
        throw Errors.validation(`Valor máximo por contrato é ${formatBRL(CREDIT_MAX_CENTS)}.`);
      }

      const account = this.accountFor(userId);
      const score = this.bank.creditScore(account.id, now);
      const rateBps = productRateBps(product, score.band);
      const ceiling = Math.min(score.suggestedLimitCents, CREDIT_MAX_CENTS);
      const available = Math.max(0, ceiling - this.outstandingPrincipalCents(userId));
      if (amount > available) {
        throw new AppError('CREDIT_LIMIT', `Valor acima do limite disponível de ${formatBRL(available)}.`, 422);
      }

      const schedule = buildSchedule(product, amount, rateBps, installments, nowIso(now));
      const sequence = this.db
        .prepare(
          `INSERT INTO bank_sequences (name, value) VALUES ('credit_contract', 1000)
           ON CONFLICT(name) DO UPDATE SET value = value + 1
           RETURNING value`,
        )
        .get() as { value: number };
      const contractNumber = `CRT-${nowIso(now).slice(0, 4)}-${String(sequence.value).padStart(5, '0')}`;
      const contractId = newId('crt', now);
      const timestamp = nowIso(now);

      this.db
        .prepare(
          `INSERT INTO bank_credit_contracts
             (id, user_id, account_id, contract_number, product, status, requested_cents, principal_cents,
              total_due_cents, paid_cents, outstanding_cents, monthly_rate_bps, installments, score,
              disbursement_transfer_id, settled_early, idempotency_key, request_hash, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, 0, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL)`,
        )
        .run(
          contractId,
          userId,
          account.id,
          contractNumber,
          product,
          amount,
          schedule.principalCents,
          schedule.totalDueCents,
          schedule.totalDueCents,
          rateBps,
          installments,
          score.score,
          idempotencyKey ?? null,
          idempotencyKey ? fingerprint : null,
          timestamp,
          timestamp,
        );

      const insertInstallment = this.db.prepare(
        `INSERT INTO bank_credit_installments
           (id, contract_id, number, due_date, principal_cents, interest_cents, total_cents, status, paid_at, payment_transfer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL)`,
      );
      for (const row of schedule.rows) {
        insertInstallment.run(
          newId('cin', now),
          contractId,
          row.number,
          row.due_date,
          row.principal_cents,
          row.interest_cents,
          row.total_cents,
        );
      }

      const disbursement = this.bank.postTransfer({
        userId: TREASURY_USER_ID,
        accountId: TREASURY_ACCOUNT_ID,
        amountCents: schedule.principalCents,
        description: `Crédito ${contractNumber} · ${config.label}`,
        recipient: { accountNumber: account.number },
        channel: 'CREDIT',
        now,
      });

      this.db
        .prepare('UPDATE bank_credit_contracts SET disbursement_transfer_id = ?, updated_at = ? WHERE id = ?')
        .run(disbursement.transfer.id, timestamp, contractId);

      enqueueEvent(this.db, {
        topic: 'bank.credit',
        type: 'bank.credit.disbursed',
        key: userId,
        payload: {
          contractId,
          contractNumber,
          product,
          principalCents: schedule.principalCents,
          totalDueCents: schedule.totalDueCents,
          installments,
          transferId: disbursement.transfer.id,
          createdAt: timestamp,
        },
      });
      audit(this.db, userId, 'bank.credit.disbursed', `bank_credit:${contractId}`, {
        contractNumber,
        product,
        principalCents: schedule.principalCents,
        totalDueCents: schedule.totalDueCents,
        rateBps,
        score: score.score,
      });

      const created = this.db
        .prepare('SELECT * FROM bank_credit_contracts WHERE id = ?')
        .get(contractId) as unknown as CreditContractRow;
      const freshAccount = this.accountFor(userId);
      return {
        contract: this.view(created, this.installmentsOf(contractId)),
        account: accountView(freshAccount),
        transfer: disbursement.transfer,
        replayed: false,
      };
    });
  }

  list(userId: string): {
    contracts: CreditContractView[];
    summary: {
      openContracts: number;
      paidContracts: number;
      outstandingCents: Cents;
      outstandingFormatted: string;
      nextDueDate: string | null;
      line: CreditLine;
    };
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM bank_credit_contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(userId) as unknown as CreditContractRow[];
    const contracts = rows.map((row) => this.view(row, this.installmentsOf(row.id)));
    const open = contracts.filter((contract) => contract.status === 'OPEN');
    const outstanding = open.reduce((sum, contract) => sum + contract.outstandingCents, 0);
    const nextDue = open
      .flatMap((contract) => contract.schedule.filter((entry) => entry.status === 'OPEN'))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate ?? null;
    return {
      contracts,
      summary: {
        openContracts: open.length,
        paidContracts: contracts.length - open.length,
        outstandingCents: outstanding,
        outstandingFormatted: formatBRL(outstanding),
        nextDueDate: nextDue,
        line: this.line(userId),
      },
    };
  }

  get(userId: string, contractId: string): CreditContractView {
    const row = this.db
      .prepare('SELECT * FROM bank_credit_contracts WHERE id = ? AND user_id = ?')
      .get(contractId, userId) as unknown as CreditContractRow | undefined;
    if (!row) throw Errors.notFound('Contrato de crédito não encontrado.');
    return this.view(row, this.installmentsOf(row.id));
  }

  exportCsv(userId: string): string {
    const { contracts } = this.list(userId);
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const money = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');
    const lines = [
      ['contrato', 'produto', 'status', 'valor_liberado', 'total_a_pagar', 'pago', 'em_aberto', 'parcelas', 'taxa_mensal_pct', 'criado_em']
        .map(escape)
        .join(';'),
      ...contracts.map((contract) =>
        [
          contract.contractNumber,
          contract.productLabel,
          contract.status,
          money(contract.principalCents),
          money(contract.totalDueCents),
          money(contract.paidCents),
          money(contract.outstandingCents),
          String(contract.installments),
          contract.monthlyRatePercent.toFixed(2).replace('.', ','),
          contract.createdAt,
        ]
          .map(escape)
          .join(';'),
      ),
    ];
    return `\ufeff${lines.join('\r\n')}`;
  }

  payInstallment(
    userId: string,
    contractId: string,
    number: number,
    now = Date.now(),
  ): { contract: CreditContractView; installment: CreditScheduleEntry; transfer: TransferView; account: BankAccountView } {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw Errors.validation('Informe o número da parcela.');
    }
    return tx(this.db, () => {
      const contract = this.db
        .prepare('SELECT * FROM bank_credit_contracts WHERE id = ? AND user_id = ?')
        .get(contractId, userId) as unknown as CreditContractRow | undefined;
      if (!contract) throw Errors.notFound('Contrato de crédito não encontrado.');
      if (contract.status !== 'OPEN') throw Errors.conflict('Contrato já liquidado.');

      const installment = this.db
        .prepare('SELECT * FROM bank_credit_installments WHERE contract_id = ? AND number = ?')
        .get(contractId, number) as unknown as CreditInstallmentRow | undefined;
      if (!installment) throw Errors.notFound('Parcela não encontrada.');
      if (installment.status === 'PAID') throw Errors.conflict('Parcela já paga.');

      const transfer = this.bank.postTransfer({
        userId,
        accountId: contract.account_id,
        amountCents: installment.total_cents,
        description: `Parcela ${number}/${contract.installments} · ${contract.contract_number}`,
        recipient: { accountNumber: TREASURY_ACCOUNT_NUMBER },
        channel: 'CREDIT_PAYMENT',
        now,
      });
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `UPDATE bank_credit_installments SET status = 'PAID', paid_at = ?, payment_transfer_id = ? WHERE id = ?`,
        )
        .run(timestamp, transfer.transfer.id, installment.id);

      const openRow = this.db
        .prepare("SELECT COUNT(*) AS count FROM bank_credit_installments WHERE contract_id = ? AND status = 'OPEN'")
        .get(contractId) as { count: number };
      const paid = contract.paid_cents + installment.total_cents;
      const outstanding = Math.max(0, contract.total_due_cents - paid);
      const closed = openRow.count === 0;
      this.db
        .prepare(
          `UPDATE bank_credit_contracts
              SET paid_cents = ?, outstanding_cents = ?, status = ?, updated_at = ?, closed_at = ?
            WHERE id = ?`,
        )
        .run(paid, outstanding, closed ? 'PAID' : 'OPEN', timestamp, closed ? timestamp : null, contractId);

      enqueueEvent(this.db, {
        topic: 'bank.credit',
        type: 'bank.credit.installment_paid',
        key: userId,
        payload: {
          contractId,
          contractNumber: contract.contract_number,
          installment: number,
          amountCents: installment.total_cents,
          transferId: transfer.transfer.id,
          closed,
          paidAt: timestamp,
        },
      });
      audit(this.db, userId, 'bank.credit.installment_paid', `bank_credit:${contractId}`, {
        installment: number,
        amountCents: installment.total_cents,
        transferId: transfer.transfer.id,
      });

      const updated = this.db
        .prepare('SELECT * FROM bank_credit_contracts WHERE id = ?')
        .get(contractId) as unknown as CreditContractRow;
      return {
        contract: this.view(updated, this.installmentsOf(contractId)),
        installment: installmentView({ ...installment, status: 'PAID', paid_at: timestamp }),
        transfer: transfer.transfer,
        account: transfer.account,
      };
    });
  }

  /**
   * Liquidação antecipada: principal em aberto + juros pro-rata sobre o
   * principal (limitado a 30 dias de acúmulo). Juros futuros são descontados.
   */
  settleEarly(
    userId: string,
    contractId: string,
    now = Date.now(),
  ): {
    contract: CreditContractView;
    transfer: TransferView;
    account: BankAccountView;
    amountCents: Cents;
    amountFormatted: string;
    discountCents: Cents;
    discountFormatted: string;
    accruedInterestCents: Cents;
  } {
    return tx(this.db, () => {
      const contract = this.db
        .prepare('SELECT * FROM bank_credit_contracts WHERE id = ? AND user_id = ?')
        .get(contractId, userId) as unknown as CreditContractRow | undefined;
      if (!contract) throw Errors.notFound('Contrato de crédito não encontrado.');
      if (contract.status !== 'OPEN') throw Errors.conflict('Contrato já liquidado.');

      const open = this.db
        .prepare(
          "SELECT * FROM bank_credit_installments WHERE contract_id = ? AND status = 'OPEN' ORDER BY number",
        )
        .all(contractId) as unknown as CreditInstallmentRow[];
      if (!open.length) throw Errors.conflict('Contrato sem parcelas em aberto.');

      const principalOpen = open.reduce((sum, row) => sum + row.principal_cents, 0);
      const contractedOpen = open.reduce((sum, row) => sum + row.total_cents, 0);
      const lastPaid = this.db
        .prepare("SELECT MAX(paid_at) AS last FROM bank_credit_installments WHERE contract_id = ? AND status = 'PAID'")
        .get(contractId) as { last: string | null };
      const baseIso = lastPaid.last ?? contract.created_at;
      const elapsedDays = Math.floor((now - new Date(baseIso).getTime()) / 86_400_000);
      const accrualDays = Math.min(ANTECIPACAO_TERM_DAYS, Math.max(0, elapsedDays));
      const accrued = Math.round((principalOpen * contract.monthly_rate_bps * accrualDays) / (10_000 * ANTECIPACAO_TERM_DAYS));
      const payoff = Math.min(contractedOpen, principalOpen + accrued);

      const transfer = this.bank.postTransfer({
        userId,
        accountId: contract.account_id,
        amountCents: payoff,
        description: `Liquidação antecipada ${contract.contract_number}`,
        recipient: { accountNumber: TREASURY_ACCOUNT_NUMBER },
        channel: 'CREDIT_PAYMENT',
        now,
      });
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `UPDATE bank_credit_installments
              SET status = 'PAID', paid_at = ?, payment_transfer_id = ?
            WHERE contract_id = ? AND status = 'OPEN'`,
        )
        .run(timestamp, transfer.transfer.id, contractId);
      const paid = contract.paid_cents + payoff;
      this.db
        .prepare(
          `UPDATE bank_credit_contracts
              SET paid_cents = ?, outstanding_cents = 0, settled_early = 1, status = 'PAID',
                  updated_at = ?, closed_at = ?
            WHERE id = ?`,
        )
        .run(paid, timestamp, timestamp, contractId);

      enqueueEvent(this.db, {
        topic: 'bank.credit',
        type: 'bank.credit.settled_early',
        key: userId,
        payload: {
          contractId,
          contractNumber: contract.contract_number,
          amountCents: payoff,
          discountCents: contractedOpen - payoff,
          transferId: transfer.transfer.id,
          settledAt: timestamp,
        },
      });
      audit(this.db, userId, 'bank.credit.settled_early', `bank_credit:${contractId}`, {
        amountCents: payoff,
        discountCents: contractedOpen - payoff,
        transferId: transfer.transfer.id,
      });

      const updated = this.db
        .prepare('SELECT * FROM bank_credit_contracts WHERE id = ?')
        .get(contractId) as unknown as CreditContractRow;
      return {
        contract: this.view(updated, this.installmentsOf(contractId)),
        transfer: transfer.transfer,
        account: transfer.account,
        amountCents: payoff,
        amountFormatted: formatBRL(payoff),
        discountCents: contractedOpen - payoff,
        discountFormatted: formatBRL(contractedOpen - payoff),
        accruedInterestCents: accrued,
      };
    });
  }

  private installmentsOf(contractId: string): CreditInstallmentRow[] {
    return this.db
      .prepare('SELECT * FROM bank_credit_installments WHERE contract_id = ? ORDER BY number')
      .all(contractId) as unknown as CreditInstallmentRow[];
  }

  private view(row: CreditContractRow, installments: CreditInstallmentRow[]): CreditContractView {
    const config = CREDIT_PRODUCTS[row.product];
    const paid = installments.filter((entry) => entry.status === 'PAID');
    const open = installments.filter((entry) => entry.status === 'OPEN');
    return {
      id: row.id,
      contractNumber: row.contract_number,
      status: row.status,
      product: row.product,
      productLabel: config.label,
      termLabel: config.termLabel,
      amountCents: row.requested_cents,
      amountFormatted: formatBRL(row.requested_cents),
      principalCents: row.principal_cents,
      principalFormatted: formatBRL(row.principal_cents),
      interestCents: row.total_due_cents - row.principal_cents,
      interestFormatted: formatBRL(row.total_due_cents - row.principal_cents),
      totalDueCents: row.total_due_cents,
      totalDueFormatted: formatBRL(row.total_due_cents),
      monthlyRateBps: row.monthly_rate_bps,
      monthlyRatePercent: monthlyRatePercent(row.monthly_rate_bps),
      installments: row.installments,
      score: row.score,
      band: row.score >= 850 ? 'MUITO_BAIXO' : row.score >= 700 ? 'BAIXO' : row.score >= 500 ? 'MEDIO' : row.score >= 300 ? 'ALTO' : 'MUITO_ALTO',
      paidCents: row.paid_cents,
      paidFormatted: formatBRL(row.paid_cents),
      outstandingCents: row.outstanding_cents,
      outstandingFormatted: formatBRL(row.outstanding_cents),
      settledEarly: Boolean(row.settled_early),
      disbursementTransferId: row.disbursement_transfer_id,
      paidInstallments: paid.length,
      openInstallments: open.length,
      nextDueDate: open[0]?.due_date ?? null,
      schedule: installments.map(installmentView),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      disclaimer: CREDIT_DISCLAIMER,
    };
  }
}

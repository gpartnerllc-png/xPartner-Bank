import type { AccountRow, AuthContext, Env } from './types.ts';
import { HttpError } from './http.ts';
import { accountById, accountView, audit, queueEvent } from './repo.ts';
import { creditScore, transferView } from './bank.ts';
import { newId, nowIso, sha256Hex } from './security.ts';
import { formatBRL, sanitizeIdempotencyKey } from './validation.ts';

const TREASURY_ACCOUNT_ID = 'bank_acc_system';
const TREASURY_ACCOUNT_NUMBER = '00000000';

export const CREDIT_MIN_CENTS = 10_000;
export const CREDIT_MAX_CENTS = 5_000_000;
export const CREDIT_MAX_INSTALLMENTS = 12;
export const ANTECIPACAO_TERM_DAYS = 30;

export type CreditProduct = 'ANTECIPACAO' | 'EMPRESTIMO';

export const CREDIT_PRODUCTS: Record<CreditProduct, { label: string; termLabel: string; maxInstallments: number }> = {
  ANTECIPACAO: { label: 'Antecipação de recebível', termLabel: '30 dias', maxInstallments: 1 },
  EMPRESTIMO: { label: 'Empréstimo pessoal', termLabel: '1 a 12 meses', maxInstallments: CREDIT_MAX_INSTALLMENTS },
};

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

interface CreditContractRow {
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

interface CreditInstallmentRow {
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

interface ScheduleRow {
  number: number;
  due_date: string;
  principal_cents: number;
  interest_cents: number;
  total_cents: number;
}

interface ScheduleBuild {
  principalCents: number;
  totalDueCents: number;
  rows: ScheduleRow[];
}

function addDaysIso(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsClamped(baseIso: string, months: number): string {
  const base = new Date(baseIso);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function monthlyRatePercent(bps: number): number {
  return Number((bps / 100).toFixed(2));
}

/** Converte o rótulo do score ("MÉDIO", "MUITO ALTO") na chave da tabela de taxas. */
function bandKey(band: string): string {
  return String(band ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
}

function normalizeProduct(value: string | undefined): CreditProduct {
  const product = String(value ?? '').trim().toUpperCase() as CreditProduct;
  if (product !== 'ANTECIPACAO' && product !== 'EMPRESTIMO') {
    throw new HttpError(422, 'INVALID_PRODUCT', 'Produto deve ser ANTECIPACAO ou EMPRESTIMO.');
  }
  return product;
}

function productRateBps(product: CreditProduct, band: string): number {
  const table = product === 'ANTECIPACAO' ? ANTECIPACAO_RATES_BPS : EMPRESTIMO_RATES_BPS;
  const rate = table[bandKey(band)];
  if (!rate) {
    throw new HttpError(
      422,
      'CREDIT_DENIED',
      'Crédito não disponível para esta faixa de score. Mantenha movimentação e saldo para reavaliar.',
    );
  }
  return rate;
}

function amountOf(value: unknown): number {
  const cents = typeof value === 'string' ? Number.parseInt(value.replace(/\D/g, ''), 10) : Number(value);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'Informe um valor positivo em centavos.');
  }
  return cents;
}

function installmentsOf(input: { product: CreditProduct; installments?: unknown }): number {
  if (input.product === 'ANTECIPACAO') return 1;
  const value = Number(input.installments ?? 1);
  const installments = Number.isFinite(value) ? Math.trunc(value) : 0;
  if (installments < 1 || installments > CREDIT_MAX_INSTALLMENTS) {
    throw new HttpError(422, 'INVALID_INSTALLMENTS', `Parcelas devem estar entre 1 e ${CREDIT_MAX_INSTALLMENTS}.`);
  }
  return installments;
}

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
    if (principal < 1) throw new HttpError(422, 'INVALID_AMOUNT', 'Valor insuficiente para antecipação.');
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

  const rate = rateBps / 10_000;
  const factor = Math.pow(1 + rate, installments);
  const payment = Math.round((amountCents * rate * factor) / (factor - 1));
  let balance = amountCents;
  const rows: ScheduleRow[] = [];
  for (let number = 1; number <= installments; number += 1) {
    const interest = Math.round(balance * rate);
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
  if (balance !== 0) throw new HttpError(500, 'SCHEDULE_INCONSISTENT', 'Falha interna ao montar a agenda de parcelas.');
  return { principalCents: amountCents, totalDueCents: rows.reduce((sum, row) => sum + row.total_cents, 0), rows };
}

function installmentView(row: CreditInstallmentRow): Record<string, unknown> {
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

function bandFromScore(score: number): string {
  if (score >= 800) return 'MUITO_ALTO';
  if (score >= 650) return 'ALTO';
  if (score >= 500) return 'MEDIO';
  if (score >= 350) return 'BAIXO';
  return 'MUITO_BAIXO';
}

function contractView(row: CreditContractRow, installments: CreditInstallmentRow[]): Record<string, unknown> {
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
    band: bandFromScore(row.score),
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

async function activeAccount(env: Env, context: AuthContext): Promise<AccountRow> {
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  const account = await accountById(env, context.account.id);
  if (!account) throw new HttpError(404, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  if (account.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta bloqueada ou encerrada para crédito.');
  return account;
}

async function outstandingPrincipal(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(i.principal_cents), 0) AS principal
       FROM bank_credit_installments i
       JOIN bank_credit_contracts c ON c.id = i.contract_id
      WHERE c.user_id = ? AND i.status = 'OPEN'`,
  )
    .bind(userId)
    .first<{ principal: number }>();
  return row?.principal ?? 0;
}

async function contractsWithInstallments(
  env: Env,
  userId: string,
  where: { id?: string } = {},
): Promise<Array<{ contract: CreditContractRow; installments: CreditInstallmentRow[] }>> {
  const rows = where.id
    ? await env.DB.prepare('SELECT * FROM bank_credit_contracts WHERE id = ? AND user_id = ?')
        .bind(where.id, userId)
        .all<CreditContractRow>()
    : await env.DB.prepare(
        'SELECT * FROM bank_credit_contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      )
        .bind(userId)
        .all<CreditContractRow>();
  const contracts = rows.results ?? [];
  if (!contracts.length) return [];
  const placeholders = contracts.map(() => '?').join(',');
  const installments = await env.DB.prepare(
    `SELECT * FROM bank_credit_installments WHERE contract_id IN (${placeholders}) ORDER BY number`,
  )
    .bind(...contracts.map((contract) => contract.id))
    .all<CreditInstallmentRow>();
  const grouped = new Map<string, CreditInstallmentRow[]>();
  for (const installment of installments.results ?? []) {
    const list = grouped.get(installment.contract_id) ?? [];
    list.push(installment);
    grouped.set(installment.contract_id, list);
  }
  return contracts.map((contract) => ({ contract, installments: grouped.get(contract.id) ?? [] }));
}

async function loadContract(
  env: Env,
  userId: string,
  contractId: string,
): Promise<{ contract: CreditContractRow; installments: CreditInstallmentRow[] }> {
  const found = await contractsWithInstallments(env, userId, { id: contractId });
  if (!found.length) throw new HttpError(404, 'CREDIT_NOT_FOUND', 'Contrato de crédito não encontrado.');
  return found[0];
}

async function afterMutation(
  env: Env,
  userId: string,
  contractId: string,
): Promise<{ contract: Record<string, unknown>; account: ReturnType<typeof accountView> }> {
  const { contract, installments } = await loadContract(env, userId, contractId);
  const account = await accountById(env, contract.account_id);
  return {
    contract: contractView(contract, installments),
    account: accountView(account as AccountRow),
  };
}

function mapDebitError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('INSUFFICIENT_FUNDS')) {
    throw new HttpError(422, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente para pagar esta parcela.');
  }
  if (message.includes('INACTIVE')) {
    throw new HttpError(409, 'ACCOUNT_INACTIVE', 'Conta de origem ou destino não está ativa.');
  }
  if (message.includes('UNIQUE') && message.includes('bank_credit_idempotency')) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Chave de idempotência já utilizada.');
  }
  throw error instanceof Error ? error : new Error(message);
}

export async function creditLine(env: Env, context: AuthContext): Promise<Record<string, unknown>> {
  const account = await activeAccount(env, context);
  const score = await creditScore(env, { account, user: context.user });
  const outstanding = await outstandingPrincipal(env, context.user.id);
  const ceiling = Math.min(Number(score.suggestedLimitCents ?? 0), CREDIT_MAX_CENTS);
  const available = Math.max(0, ceiling - outstanding);
  return {
    score: score.score,
    band: score.band,
    suggestedLimitCents: score.suggestedLimitCents,
    suggestedLimitFormatted: score.suggestedLimitFormatted,
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

export async function creditQuote(
  env: Env,
  context: AuthContext,
  input: { product?: string; amountCents?: unknown; installments?: unknown },
): Promise<Record<string, unknown>> {
  const product = normalizeProduct(input.product);
  const amount = amountOf(input.amountCents);
  const installments = installmentsOf({ product, installments: input.installments });
  if (amount < CREDIT_MIN_CENTS) {
    throw new HttpError(422, 'CREDIT_MIN', `Valor mínimo de crédito é ${formatBRL(CREDIT_MIN_CENTS)}.`);
  }
  if (amount > CREDIT_MAX_CENTS) {
    throw new HttpError(422, 'CREDIT_MAX', `Valor máximo por contrato é ${formatBRL(CREDIT_MAX_CENTS)}.`);
  }

  const account = await activeAccount(env, context);
  const score = await creditScore(env, { account, user: context.user });
  const rateBps = productRateBps(product, String(score.band));
  const ceiling = Math.min(Number(score.suggestedLimitCents ?? 0), CREDIT_MAX_CENTS);
  const available = Math.max(0, ceiling - (await outstandingPrincipal(env, context.user.id)));
  if (amount > available) {
    throw new HttpError(422, 'CREDIT_LIMIT', `Valor acima do limite disponível de ${formatBRL(available)}.`);
  }

  const schedule = buildSchedule(product, amount, rateBps, installments, nowIso());
  const config = CREDIT_PRODUCTS[product];
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
        id: '',
        contract_id: '',
        status: 'OPEN',
        paid_at: null,
        payment_transfer_id: null,
        ...row,
      }),
    ),
    disclaimer: CREDIT_DISCLAIMER,
  };
}

export async function creditCreate(
  env: Env,
  context: AuthContext,
  input: {
    product?: string;
    amountCents?: unknown;
    installments?: unknown;
    idempotencyKey?: string;
  },
): Promise<Record<string, unknown>> {
  const product = normalizeProduct(input.product);
  const installments = installmentsOf({ product, installments: input.installments });
  const amount = amountOf(input.amountCents);
  const idempotencyKey = sanitizeIdempotencyKey(input.idempotencyKey);
  const fingerprint = await sha256Hex(`${product}|${amount}|${installments}`);

  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      'SELECT * FROM bank_credit_contracts WHERE user_id = ? AND idempotency_key = ?',
    )
      .bind(context.user.id, idempotencyKey)
      .first<CreditContractRow>();
    if (existing) {
      if (existing.request_hash !== fingerprint) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Chave de idempotência reutilizada com payload diferente.');
      }
      const account = await activeAccount(env, context);
      const transfer = existing.disbursement_transfer_id
        ? await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
            .bind(existing.disbursement_transfer_id)
            .first<import('./types.ts').TransferRow>()
        : null;
      const { installments: rows } = await loadContract(env, context.user.id, existing.id);
      return {
        contract: contractView(existing, rows),
        account: accountView(account),
        transfer: transfer ? await transferView(env, transfer, 'IN') : null,
        replayed: true,
      };
    }
  }

  if (amount < CREDIT_MIN_CENTS) {
    throw new HttpError(422, 'CREDIT_MIN', `Valor mínimo de crédito é ${formatBRL(CREDIT_MIN_CENTS)}.`);
  }
  if (amount > CREDIT_MAX_CENTS) {
    throw new HttpError(422, 'CREDIT_MAX', `Valor máximo por contrato é ${formatBRL(CREDIT_MAX_CENTS)}.`);
  }

  const account = await activeAccount(env, context);
  const score = await creditScore(env, { account, user: context.user });
  const rateBps = productRateBps(product, String(score.band));
  const ceiling = Math.min(Number(score.suggestedLimitCents ?? 0), CREDIT_MAX_CENTS);
  const available = Math.max(0, ceiling - (await outstandingPrincipal(env, context.user.id)));
  if (amount > available) {
    throw new HttpError(422, 'CREDIT_LIMIT', `Valor acima do limite disponível de ${formatBRL(available)}.`);
  }

  const timestamp = nowIso();
  const schedule = buildSchedule(product, amount, rateBps, installments, timestamp);
  const sequence = await env.DB.prepare(
    `INSERT INTO bank_sequences (name, value) VALUES ('credit_contract', 1000)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`,
  ).first<{ value: number }>();
  if (!sequence) throw new HttpError(500, 'SEQUENCE_MISSING', 'Sequência de contratos indisponível.');
  const contractNumber = `CRT-${timestamp.slice(0, 4)}-${String(sequence.value).padStart(5, '0')}`;
  const contractId = newId('crt');
  const transferId = newId('trf');
  const e2e = `E99999999${timestamp.replace(/\D/g, '').slice(0, 12)}${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
  const config = CREDIT_PRODUCTS[product];

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO bank_credit_contracts
         (id, user_id, account_id, contract_number, product, status, requested_cents, principal_cents,
          total_due_cents, paid_cents, outstanding_cents, monthly_rate_bps, installments, score,
          disbursement_transfer_id, settled_early, idempotency_key, request_hash, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL)`,
    ).bind(
      contractId,
      context.user.id,
      account.id,
      contractNumber,
      product,
      amount,
      schedule.principalCents,
      schedule.totalDueCents,
      schedule.totalDueCents,
      rateBps,
      installments,
      Number(score.score ?? 0),
      transferId,
      idempotencyKey,
      idempotencyKey ? fingerprint : null,
      timestamp,
      timestamp,
    ),
    ...schedule.rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO bank_credit_installments
           (id, contract_id, number, due_date, principal_cents, interest_cents, total_cents, status, paid_at, payment_transfer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL)`,
      ).bind(newId('cin'), contractId, row.number, row.due_date, row.principal_cents, row.interest_cents, row.total_cents),
    ),
    env.DB.prepare(
      `INSERT INTO bank_transfers
         (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
          end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
       VALUES (?, 'FUNDING', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?, 'CREDIT')`,
    ).bind(
      transferId,
      TREASURY_ACCOUNT_ID,
      account.id,
      schedule.principalCents,
      `Crédito ${contractNumber} · ${config.label}`,
      e2e,
      context.user.id,
      context.user.name,
      timestamp,
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    mapDebitError(error);
  }

  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<import('./types.ts').TransferRow>();
  const updated = await afterMutation(env, context.user.id, contractId);

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.credit.disbursed',
    resource: 'bank_credit',
    resourceId: contractId,
    details: {
      contractNumber,
      product,
      principalCents: schedule.principalCents,
      totalDueCents: schedule.totalDueCents,
      rateBps,
      score: score.score,
      transferId,
    },
  });
  await queueEvent(env, {
    topic: 'bank.credit',
    type: 'bank.credit.disbursed',
    payload: {
      contractId,
      contractNumber,
      product,
      principalCents: schedule.principalCents,
      totalDueCents: schedule.totalDueCents,
      installments,
      transferId,
      createdAt: timestamp,
    },
  });

  return {
    ...updated,
    transfer: transfer ? await transferView(env, transfer, 'IN') : null,
    replayed: false,
  };
}

export async function creditList(env: Env, context: AuthContext): Promise<Record<string, unknown>> {
  await activeAccount(env, context);
  const rows = await env.DB.prepare(
    'SELECT * FROM bank_credit_contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(context.user.id)
    .all<CreditContractRow>();
  const contracts = rows.results ?? [];
  const placeholders = contracts.map(() => '?').join(',');
  const installmentRows = contracts.length
    ? await env.DB.prepare(
        `SELECT * FROM bank_credit_installments WHERE contract_id IN (${placeholders}) ORDER BY number`,
      )
        .bind(...contracts.map((contract) => contract.id))
        .all<CreditInstallmentRow>()
    : { results: [] as CreditInstallmentRow[] };
  const grouped = new Map<string, CreditInstallmentRow[]>();
  for (const installment of installmentRows.results ?? []) {
    const list = grouped.get(installment.contract_id) ?? [];
    list.push(installment);
    grouped.set(installment.contract_id, list);
  }
  const views = contracts.map((contract) => contractView(contract, grouped.get(contract.id) ?? []));
  const open = views.filter((contract) => contract.status === 'OPEN');
  const outstanding = open.reduce((sum, contract) => sum + Number(contract.outstandingCents), 0);
  const nextDue =
    open
      .flatMap((contract) => (contract.schedule as Array<Record<string, unknown>>).filter((entry) => entry.status === 'OPEN'))
      .map((entry) => String(entry.dueDate))
      .sort()[0] ?? null;
  return {
    contracts: views,
    summary: {
      openContracts: open.length,
      paidContracts: views.length - open.length,
      outstandingCents: outstanding,
      outstandingFormatted: formatBRL(outstanding),
      nextDueDate: nextDue,
      line: await creditLine(env, context),
    },
  };
}

export async function creditGet(
  env: Env,
  context: AuthContext,
  contractId: string,
): Promise<Record<string, unknown>> {
  const { contract, installments } = await loadContract(env, context.user.id, contractId);
  return { contract: contractView(contract, installments) };
}

export async function creditExportCsv(env: Env, context: AuthContext): Promise<string> {
  const list = await creditList(env, context);
  const contracts = list.contracts as Array<Record<string, unknown>>;
  const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
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
        money(Number(contract.principalCents)),
        money(Number(contract.totalDueCents)),
        money(Number(contract.paidCents)),
        money(Number(contract.outstandingCents)),
        String(contract.installments),
        Number(contract.monthlyRatePercent).toFixed(2).replace('.', ','),
        contract.createdAt,
      ]
        .map(escape)
        .join(';'),
    ),
  ];
  return `\ufeff${lines.join('\r\n')}`;
}

export async function creditPayInstallment(
  env: Env,
  context: AuthContext,
  contractId: string,
  number: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new HttpError(422, 'INVALID_INSTALLMENT', 'Informe o número da parcela.');
  }
  const { contract } = await loadContract(env, context.user.id, contractId);
  if (contract.status !== 'OPEN') throw new HttpError(409, 'CREDIT_CLOSED', 'Contrato já liquidado.');

  const installment = await env.DB.prepare(
    'SELECT * FROM bank_credit_installments WHERE contract_id = ? AND number = ?',
  )
    .bind(contractId, number)
    .first<CreditInstallmentRow>();
  if (!installment) throw new HttpError(404, 'INSTALLMENT_NOT_FOUND', 'Parcela não encontrada.');
  if (installment.status === 'PAID') throw new HttpError(409, 'INSTALLMENT_PAID', 'Parcela já paga.');

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM bank_credit_installments WHERE contract_id = ? AND status = 'OPEN' AND number <> ?",
  )
    .bind(contractId, number)
    .first<{ count: number }>();
  const closed = (remaining?.count ?? 0) === 0;

  const timestamp = nowIso();
  const transferId = newId('trf');
  const endToEnd = `E99999999${timestamp.replace(/\D/g, '').slice(0, 12)}${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bank_transfers
           (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
            end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
         VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?, 'CREDIT_PAYMENT')`,
      ).bind(
        transferId,
        contract.account_id,
        TREASURY_ACCOUNT_ID,
        installment.total_cents,
        `Parcela ${number}/${contract.installments} · ${contract.contract_number}`,
        endToEnd,
        context.user.id,
        'Tesouraria xPartner',
        timestamp,
      ),
      env.DB.prepare(
        "UPDATE bank_credit_installments SET status = 'PAID', paid_at = ?, payment_transfer_id = ? WHERE id = ? AND status = 'OPEN'",
      ).bind(timestamp, transferId, installment.id),
      env.DB.prepare(
        `UPDATE bank_credit_contracts
            SET paid_cents = paid_cents + ?,
                outstanding_cents = MAX(0, total_due_cents - (paid_cents + ?)),
                status = ?, updated_at = ?, closed_at = ?
          WHERE id = ?`,
      ).bind(installment.total_cents, installment.total_cents, closed ? 'PAID' : 'OPEN', timestamp, closed ? timestamp : null, contractId),
    ]);
  } catch (error) {
    mapDebitError(error);
  }

  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<import('./types.ts').TransferRow>();
  const updated = await afterMutation(env, context.user.id, contractId);
  const paidRow = await env.DB.prepare('SELECT * FROM bank_credit_installments WHERE id = ?')
    .bind(installment.id)
    .first<CreditInstallmentRow>();

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.credit.installment_paid',
    resource: 'bank_credit',
    resourceId: contractId,
    details: { installment: number, amountCents: installment.total_cents, transferId },
  });
  await queueEvent(env, {
    topic: 'bank.credit',
    type: 'bank.credit.installment_paid',
    payload: {
      contractId,
      contractNumber: contract.contract_number,
      installment: number,
      amountCents: installment.total_cents,
      transferId,
      closed,
      paidAt: timestamp,
    },
  });

  return {
    ...updated,
    installment: paidRow ? installmentView(paidRow) : null,
    transfer: transfer ? await transferView(env, transfer, 'OUT') : null,
  };
}

export async function creditSettleEarly(
  env: Env,
  context: AuthContext,
  contractId: string,
): Promise<Record<string, unknown>> {
  const { contract } = await loadContract(env, context.user.id, contractId);
  if (contract.status !== 'OPEN') throw new HttpError(409, 'CREDIT_CLOSED', 'Contrato já liquidado.');

  const openRows = await env.DB.prepare(
    "SELECT * FROM bank_credit_installments WHERE contract_id = ? AND status = 'OPEN' ORDER BY number",
  )
    .bind(contractId)
    .all<CreditInstallmentRow>();
  const open = openRows.results ?? [];
  if (!open.length) throw new HttpError(409, 'NO_OPEN_INSTALLMENTS', 'Contrato sem parcelas em aberto.');

  const principalOpen = open.reduce((sum, row) => sum + row.principal_cents, 0);
  const contractedOpen = open.reduce((sum, row) => sum + row.total_cents, 0);
  const lastPaid = await env.DB.prepare(
    "SELECT MAX(paid_at) AS last FROM bank_credit_installments WHERE contract_id = ? AND status = 'PAID'",
  )
    .bind(contractId)
    .first<{ last: string | null }>();
  const baseIso = lastPaid?.last ?? contract.created_at;
  const elapsedDays = Math.floor((Date.now() - new Date(baseIso).getTime()) / 86_400_000);
  const accrualDays = Math.min(ANTECIPACAO_TERM_DAYS, Math.max(0, elapsedDays));
  const accrued = Math.round(
    (principalOpen * contract.monthly_rate_bps * accrualDays) / (10_000 * ANTECIPACAO_TERM_DAYS),
  );
  const payoff = Math.min(contractedOpen, principalOpen + accrued);
  const timestamp = nowIso();
  const transferId = newId('trf');
  const endToEnd = `E99999999${timestamp.replace(/\D/g, '').slice(0, 12)}${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bank_transfers
           (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
            end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
         VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?, 'CREDIT_PAYMENT')`,
      ).bind(
        transferId,
        contract.account_id,
        TREASURY_ACCOUNT_ID,
        payoff,
        `Liquidação antecipada ${contract.contract_number}`,
        endToEnd,
        context.user.id,
        'Tesouraria xPartner',
        timestamp,
      ),
      env.DB.prepare(
        "UPDATE bank_credit_installments SET status = 'PAID', paid_at = ?, payment_transfer_id = ? WHERE contract_id = ? AND status = 'OPEN'",
      ).bind(timestamp, transferId, contractId),
      env.DB.prepare(
        `UPDATE bank_credit_contracts
            SET paid_cents = paid_cents + ?, outstanding_cents = 0, settled_early = 1, status = 'PAID',
                updated_at = ?, closed_at = ?
          WHERE id = ?`,
      ).bind(payoff, timestamp, timestamp, contractId),
    ]);
  } catch (error) {
    mapDebitError(error);
  }

  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<import('./types.ts').TransferRow>();
  const updated = await afterMutation(env, context.user.id, contractId);

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.credit.settled_early',
    resource: 'bank_credit',
    resourceId: contractId,
    details: { amountCents: payoff, discountCents: contractedOpen - payoff, transferId },
  });
  await queueEvent(env, {
    topic: 'bank.credit',
    type: 'bank.credit.settled_early',
    payload: {
      contractId,
      contractNumber: contract.contract_number,
      amountCents: payoff,
      discountCents: contractedOpen - payoff,
      transferId,
      settledAt: timestamp,
    },
  });

  return {
    ...updated,
    transfer: transfer ? await transferView(env, transfer, 'OUT') : null,
    amountCents: payoff,
    amountFormatted: formatBRL(payoff),
    discountCents: contractedOpen - payoff,
    discountFormatted: formatBRL(contractedOpen - payoff),
    accruedInterestCents: accrued,
  };
}

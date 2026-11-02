import type {
  AccountRow,
  AuthContext,
  Env,
  FxTransferRow,
  FxWalletRow,
  FxWalletView,
  LedgerRow,
  RecipientRow,
  TransferRow,
} from './types.ts';
import { HttpError, boolEnv } from './http.ts';
import { newId, nowIso, sha256Hex } from './security.ts';
import {
  accountById,
  accountByUser,
  accountView,
  audit,
  ledgerTrial,
  queueEvent,
  recipientView,
  resolveRecipient,
} from './repo.ts';
import {
  endToEndId,
  formatBRL,
  formatUSD,
  maskDocument,
  maskedAccount,
  parseAmountCents,
  sanitizeDescription,
  sanitizeIdempotencyKey,
} from './validation.ts';

const TREASURY_ACCOUNT_ID = 'bank_acc_system';
const CAPITAL_ACCOUNT_ID = 'bank_acc_capital';
const CAPITAL_MAX_CENTS = 50_000_000_000_000; // R$ 500 bilhões por operação
const FX_TREASURY_WALLET_ID = 'bank_fx_system_usd';
const FX_MAX_CENTS = 2_000_000_000_000; // US$ 20 bilhões por operação
const DEMO_FUNDING_MAX_CENTS = 1_000_000;
const DEMO_FUNDING_DAILY_CENTS = 5_000_000;
export const DEMO_START_BRL_CENTS = 200_000_000_000; // R$ 2 bilhões
export const DEMO_START_USD_CENTS = 300_000_000_000; // US$ 3 bilhões

interface TransferInput {
  amountCents?: number | string;
  amount?: number | string;
  description?: string;
  recipient: { accountNumber?: string; document?: string; email?: string; pixKey?: string };
  idempotencyKey?: string;
}

export interface TransferView {
  id: string;
  kind: string;
  status: string;
  channel: string;
  direction: 'IN' | 'OUT';
  amountCents: number;
  amountFormatted: string;
  description: string;
  endToEndId: string;
  counterparty: { name: string; documentMasked: string; account: string };
  createdAt: string;
  balanceAfterCents: number | null;
  balanceAfterFormatted: string | null;
}

interface StatementRow {
  id: string;
  transfer_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  balance_after_cents: number;
  created_at: string;
  kind: 'INTERNAL' | 'FUNDING';
  channel: string;
  description: string | null;
  end_to_end_id: string;
  counterparty_name: string;
  counterparty_branch: string;
  counterparty_number: string;
}

function parseCapitalCents(value: unknown): number {
  const cents =
    typeof value === 'string' ? Number.parseInt(value.replace(/\D/g, ''), 10) : Number(value);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'Informe um valor positivo em centavos.');
  }
  return cents;
}

function walletView(row: FxWalletRow): FxWalletView {
  return {
    id: row.id,
    currency: row.currency,
    status: row.status,
    balanceCents: row.balance_cents,
    balanceFormatted: formatUSD(row.balance_cents),
    openingBalanceCents: row.opening_balance_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function counterpartyFor(env: Env, transfer: TransferRow, direction: 'IN' | 'OUT'): Promise<RecipientRow> {
  const accountId = direction === 'OUT' ? transfer.credit_account_id : transfer.debit_account_id;
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.document, a.id AS account_id, a.branch, a.number
       FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id WHERE a.id = ?`,
  )
    .bind(accountId)
    .first<RecipientRow>();
  if (!row) throw new Error('Contraparte ausente no livro-razão.');
  return row;
}

async function balanceAfterFor(env: Env, transferId: string, direction: 'IN' | 'OUT'): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance_after_cents FROM bank_ledger WHERE transfer_id = ? AND direction = ?',
  )
    .bind(transferId, direction === 'OUT' ? 'DEBIT' : 'CREDIT')
    .first<{ balance_after_cents: number }>();
  return row?.balance_after_cents ?? null;
}

export async function transferView(
  env: Env,
  transfer: TransferRow,
  direction: 'IN' | 'OUT',
): Promise<TransferView> {
  const counterparty = await counterpartyFor(env, transfer, direction);
  const balanceAfter = await balanceAfterFor(env, transfer.id, direction);
  return {
    id: transfer.id,
    kind: transfer.kind,
    status: transfer.status,
    channel: transfer.channel ?? 'INTERNAL',
    direction,
    amountCents: transfer.amount_cents,
    amountFormatted: formatBRL(transfer.amount_cents),
    description: transfer.description ?? '',
    endToEndId: transfer.end_to_end_id,
    counterparty: {
      name: counterparty.name,
      documentMasked: maskDocument(counterparty.document),
      account: maskedAccount(counterparty.branch, counterparty.number),
    },
    createdAt: transfer.created_at,
    balanceAfterCents: balanceAfter,
    balanceAfterFormatted: balanceAfter === null ? null : formatBRL(balanceAfter),
  };
}

function recipientQuery(input: TransferInput): {
  accountNumber?: string;
  document?: string;
  email?: string;
  pixKey?: string;
} {
  const recipient = input.recipient ?? {};
  if (input.recipient === undefined) {
    throw new HttpError(422, 'INVALID_RECIPIENT', 'Informe o favorecido da transferência.');
  }
  return {
    accountNumber: recipient.accountNumber,
    document: recipient.document,
    email: recipient.email,
    pixKey: recipient.pixKey,
  };
}

export async function transfer(
  env: Env,
  context: AuthContext,
  input: TransferInput,
): Promise<{ transfer: TransferView; account: ReturnType<typeof accountView>; replayed: boolean }> {
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  const account = await accountById(env, context.account.id);
  if (!account || account.status !== 'ACTIVE') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta não está ativa para transferências.');
  }

  const amount = parseAmountCents(input.amountCents ?? input.amount);
  const description = sanitizeDescription(input.description);
  const idempotencyKey = sanitizeIdempotencyKey(input.idempotencyKey);
  const recipientQueryValue = recipientQuery(input);
  const fingerprint = await sha256Hex(
    `${JSON.stringify(recipientQueryValue)}|${amount}|${description}`,
  );

  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      'SELECT * FROM bank_transfers WHERE initiator_id = ? AND idempotency_key = ?',
    )
      .bind(context.user.id, idempotencyKey)
      .first<TransferRow>();
    if (existing) {
      if (existing.request_hash !== fingerprint) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Chave de idempotência usada com outro conteúdo.');
      }
      const current = await accountById(env, account.id);
      return {
        transfer: await transferView(env, existing, 'OUT'),
        account: accountView(current ?? account),
        replayed: true,
      };
    }
  }

  if (amount > account.per_transfer_limit_cents) {
    throw new HttpError(422, 'LIMIT_PER_TRANSFER', `Limite por transferência é ${formatBRL(account.per_transfer_limit_cents)}.`);
  }

  const recipient = await resolveRecipient(env, recipientQueryValue);
  if (recipient.user_id === context.user.id) {
    throw new HttpError(422, 'SELF_TRANSFER', 'Não é possível transferir para a própria conta.');
  }

  const cutoff = nowIso(-24 * 60 * 60 * 1000);
  const daily = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bank_transfers WHERE debit_account_id = ? AND kind = 'INTERNAL' AND channel IN ('INTERNAL', 'PIX') AND created_at >= ?",
  )
    .bind(account.id, cutoff)
    .first<{ total: number }>();
  if ((daily?.total ?? 0) + amount > account.daily_limit_cents) {
    throw new HttpError(422, 'LIMIT_DAILY', `Limite diário é ${formatBRL(account.daily_limit_cents)}.`);
  }

  const transferId = newId('trf');
  const e2e = endToEndId();
  const createdAt = nowIso();
  const channel = recipient.pix_key_type ? 'PIX' : 'INTERNAL';
  try {
    await env.DB.prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at, channel)
       VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        transferId,
        account.id,
        recipient.account_id,
        amount,
        description || null,
        e2e,
        idempotencyKey,
        fingerprint,
        context.user.id,
        recipient.name,
        createdAt,
        channel,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('INSUFFICIENT_FUNDS')) {
      throw new HttpError(422, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente para esta transferência.');
    }
    if (message.includes('INACTIVE')) {
      throw new HttpError(409, 'ACCOUNT_INACTIVE', 'Conta de origem ou destino não está ativa.');
    }
    if (message.includes('UNIQUE') && idempotencyKey) {
      const existing = await env.DB.prepare(
        'SELECT * FROM bank_transfers WHERE initiator_id = ? AND idempotency_key = ?',
      )
        .bind(context.user.id, idempotencyKey)
        .first<TransferRow>();
      if (existing && existing.request_hash === fingerprint) {
        const current = await accountById(env, account.id);
        return {
          transfer: await transferView(env, existing, 'OUT'),
          account: accountView(current ?? account),
          replayed: true,
        };
      }
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Conflito de idempotência.');
    }
    throw error;
  }

  const posted = (await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<TransferRow>()) as TransferRow;
  const view = await transferView(env, posted, 'OUT');
  const updated = (await accountById(env, account.id)) ?? account;

  await audit(env, {
    actorId: context.user.id,
    action: 'bank.transfer.posted',
    resource: 'bank_transfer',
    resourceId: transferId,
    details: { amountCents: amount, recipient: recipient.user_id, endToEndId: e2e, channel },
  });
  await queueEvent(env, {
    topic: 'bank.transfer',
    type: 'bank.transfer.posted',
    payload: {
      transferId,
      merchantId: context.user.id,
      amountCents: amount,
      method: 'INTERNAL',
      terminalId: 'EDGE',
      nsu: e2e,
    },
  });
  await storeReceipt(env, transferId, context.user);

  return { transfer: view, account: accountView(updated), replayed: false };
}

export async function funding(
  env: Env,
  context: AuthContext,
  input: { amountCents?: number | string; amount?: number | string; targetUserId?: string },
): Promise<{ transfer: TransferView; account: ReturnType<typeof accountView> }> {
  if (!boolEnv(env.DEMO_MODE)) {
    throw new HttpError(403, 'DEMO_DISABLED', 'Aporte de tesouraria disponível apenas em modo demo.');
  }
  const targetUserId = input.targetUserId && input.targetUserId !== context.user.id
    ? input.targetUserId
    : context.user.id;
  const targetAccount = await accountByUser(env, targetUserId);
  if (!targetAccount) throw new HttpError(404, 'ACCOUNT_MISSING', 'Conta corrente do titular não encontrada.');
  const amount = parseAmountCents(input.amountCents ?? input.amount);
  if (amount > DEMO_FUNDING_MAX_CENTS) {
    throw new HttpError(422, 'FUNDING_LIMIT', `Aporte máximo por operação é ${formatBRL(DEMO_FUNDING_MAX_CENTS)}.`);
  }
  const cutoff = nowIso(-24 * 60 * 60 * 1000);
  const used = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bank_transfers WHERE initiator_id = ? AND kind = 'FUNDING' AND created_at >= ?",
  )
    .bind(context.user.id, cutoff)
    .first<{ total: number }>();
  if ((used?.total ?? 0) + amount > DEMO_FUNDING_DAILY_CENTS) {
    throw new HttpError(422, 'FUNDING_DAILY_LIMIT', `Aporte diário máximo é ${formatBRL(DEMO_FUNDING_DAILY_CENTS)}.`);
  }
  const treasury = await accountById(env, TREASURY_ACCOUNT_ID);
  if (!treasury || treasury.status !== 'ACTIVE') {
    throw new HttpError(503, 'TREASURY_UNAVAILABLE', 'Tesouraria indisponível.');
  }
  const account = targetAccount;
  if (account.status !== 'ACTIVE') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta não está ativa.');
  }

  const transferId = newId('trf');
  const e2e = endToEndId();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO bank_transfers
      (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
       end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
     VALUES (?, 'FUNDING', ?, ?, ?, 'Aporte de tesouraria (demo)', 'POSTED', ?, NULL, NULL, ?, ?, ?)`,
  )
    .bind(transferId, TREASURY_ACCOUNT_ID, account.id, amount, e2e, context.user.id, context.user.name, now)
    .run();

  const posted = (await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<TransferRow>()) as TransferRow;
  const view = await transferView(env, posted, 'IN');
  const updated = (await accountById(env, account.id)) ?? account;
  await audit(env, {
    actorId: context.user.id,
    action: 'bank.funding.received',
    resource: 'bank_transfer',
    resourceId: transferId,
    details: { amountCents: amount, demo: true },
  });
  await queueEvent(env, {
    topic: 'bank.settlement',
    type: 'bank.settlement.paid',
    payload: { transferId, merchantId: context.user.id, netCents: amount, mode: 'DEMO_TREASURY' },
  });
  await storeReceipt(env, transferId, context.user);
  return { transfer: view, account: accountView(updated) };
}

// ── Capital de laboratório e carteira internacional (demo) ────────────

async function postCapital(
  env: Env,
  actorUserId: string,
  targetUserId: string,
  amount: number,
  description: string,
): Promise<{ transfer: TransferRow; account: AccountRow }> {
  const target = await env.DB.prepare(
    `SELECT a.* FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
      WHERE a.user_id = ? AND u.status = 'ACTIVE' AND a.status = 'ACTIVE'`,
  )
    .bind(targetUserId)
    .first<AccountRow>();
  if (!target) throw new HttpError(404, 'ACCOUNT_MISSING', 'Conta ativa não encontrada para o aporte de capital.');
  const capital = await accountById(env, CAPITAL_ACCOUNT_ID);
  if (!capital || capital.status !== 'ACTIVE') {
    throw new HttpError(503, 'CAPITAL_UNAVAILABLE', 'Conta de capital de laboratório indisponível.');
  }

  const transferId = newId('trf');
  const e2e = endToEndId();
  const createdAt = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO bank_transfers
        (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
         end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
       VALUES (?, 'FUNDING', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?)`,
    )
      .bind(
        transferId,
        CAPITAL_ACCOUNT_ID,
        target.id,
        amount,
        description,
        e2e,
        actorUserId,
        targetUserId,
        createdAt,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('INSUFFICIENT_FUNDS')) {
      throw new HttpError(409, 'CAPITAL_EMPTY', 'Conta de capital de laboratório sem lastro para este aporte.');
    }
    throw error;
  }

  const posted = (await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<TransferRow>()) as TransferRow;
  const updated = (await accountById(env, target.id)) ?? target;
  await audit(env, {
    actorId: actorUserId,
    action: 'bank.capital.posted',
    resource: 'bank_transfer',
    resourceId: transferId,
    details: { amountCents: amount, targetUserId, endToEndId: e2e },
  });
  await queueEvent(env, {
    topic: 'bank.transfer',
    type: 'bank.capital.posted',
    payload: { transferId, amountCents: amount, targetUserId, actorUserId, endToEndId: e2e },
  });
  return { transfer: posted, account: updated };
}

async function ensureFxWallet(env: Env, userId: string, currency: string): Promise<FxWalletRow> {
  const existing = await env.DB.prepare(
    'SELECT * FROM bank_fx_wallets WHERE user_id = ? AND currency = ?',
  )
    .bind(userId, currency)
    .first<FxWalletRow>();
  if (existing) return existing;
  const id = newId('fxw');
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO bank_fx_wallets
       (id, user_id, currency, status, balance_cents, opening_balance_cents, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', 0, 0, ?, ?)`,
  )
    .bind(id, userId, currency, createdAt, createdAt)
    .run();
  return (await env.DB.prepare('SELECT * FROM bank_fx_wallets WHERE id = ?')
    .bind(id)
    .first<FxWalletRow>()) as FxWalletRow;
}

async function postFxFund(
  env: Env,
  actorUserId: string,
  targetUserId: string,
  amount: number,
  memo: string,
): Promise<{ transferId: string; wallet: FxWalletRow; createdAt: string }> {
  const target = await env.DB.prepare("SELECT id, name FROM bank_users WHERE id = ? AND status = 'ACTIVE'")
    .bind(targetUserId)
    .first<{ id: string; name: string }>();
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'Titular ativo não encontrado para a carteira internacional.');
  const treasury = await env.DB.prepare('SELECT * FROM bank_fx_wallets WHERE id = ?')
    .bind(FX_TREASURY_WALLET_ID)
    .first<FxWalletRow>();
  if (!treasury || treasury.status !== 'ACTIVE') {
    throw new HttpError(503, 'FX_TREASURY_UNAVAILABLE', 'Tesouraria internacional indisponível.');
  }
  const wallet = await ensureFxWallet(env, targetUserId, 'USD');

  const transferId = newId('fxt');
  const createdAt = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO bank_fx_transfers
         (id, currency, kind, debit_wallet_id, credit_wallet_id, amount_cents, memo, status, initiator_id, created_at)
       VALUES (?, 'USD', 'FUNDING', ?, ?, ?, ?, 'POSTED', ?, ?)`,
    )
      .bind(transferId, treasury.id, wallet.id, amount, memo, actorUserId, createdAt)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('FX_INSUFFICIENT_FUNDS')) {
      throw new HttpError(409, 'FX_TREASURY_EMPTY', 'Tesouraria internacional sem saldo para este aporte.');
    }
    throw error;
  }

  const updated = (await env.DB.prepare('SELECT * FROM bank_fx_wallets WHERE id = ?')
    .bind(wallet.id)
    .first<FxWalletRow>()) as FxWalletRow;
  await audit(env, {
    actorId: actorUserId,
    action: 'bank.fx.funded',
    resource: 'bank_fx_wallet',
    resourceId: wallet.id,
    details: { amountCents: amount, currency: 'USD', targetUserId },
  });
  await queueEvent(env, {
    topic: 'bank.fx',
    type: 'bank.fx.funded',
    payload: { transferId, walletId: wallet.id, amountCents: amount, currency: 'USD', targetUserId },
  });
  return { transferId, wallet: updated, createdAt };
}

export async function fxWallets(env: Env, userId: string): Promise<{ wallets: FxWalletView[] }> {
  const rows = await env.DB.prepare(
    'SELECT * FROM bank_fx_wallets WHERE user_id = ? ORDER BY currency',
  )
    .bind(userId)
    .all<FxWalletRow>();
  return { wallets: (rows.results ?? []).map(walletView) };
}

export async function fxSystemOverview(env: Env): Promise<{
  custodyCents: number;
  custodyFormatted: string;
  wallets: number;
  treasuryCents: number;
  treasuryFormatted: string;
}> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN user_id <> 'bank_user_system' THEN balance_cents ELSE 0 END), 0) AS custody,
            COALESCE(SUM(CASE WHEN user_id = 'bank_user_system' THEN balance_cents ELSE 0 END), 0) AS treasury,
            COALESCE(SUM(CASE WHEN user_id <> 'bank_user_system' AND balance_cents > 0 THEN 1 ELSE 0 END), 0) AS wallets
       FROM bank_fx_wallets`,
  ).first<{ custody: number; treasury: number; wallets: number }>();
  return {
    custodyCents: row?.custody ?? 0,
    custodyFormatted: formatUSD(row?.custody ?? 0),
    wallets: row?.wallets ?? 0,
    treasuryCents: row?.treasury ?? 0,
    treasuryFormatted: formatUSD(row?.treasury ?? 0),
  };
}

export async function demoCapital(
  env: Env,
  context: AuthContext,
  input: { targetUserId: string; amountCents?: number | string; description?: string },
): Promise<{ transfer: TransferView; account: ReturnType<typeof accountView> }> {
  if (!boolEnv(env.DEMO_MODE)) {
    throw new HttpError(403, 'DEMO_DISABLED', 'Capital de laboratório disponível apenas em modo demo.');
  }
  const amount = parseCapitalCents(input.amountCents);
  if (amount > CAPITAL_MAX_CENTS) {
    throw new HttpError(422, 'CAPITAL_LIMIT', `Aporte de capital limitado a ${formatBRL(CAPITAL_MAX_CENTS)} por operação.`);
  }
  const targetUserId = input.targetUserId || context.user.id;
  const description = sanitizeDescription(input.description ?? 'Aporte de capital de laboratório (demo)')
    || 'Aporte de capital de laboratório (demo)';
  const result = await postCapital(env, context.user.id, targetUserId, amount, description);
  return { transfer: await transferView(env, result.transfer, 'IN'), account: accountView(result.account) };
}

export async function demoFx(
  env: Env,
  context: AuthContext,
  input: { targetUserId: string; currency?: string; amountCents?: number | string; memo?: string },
): Promise<{ transfer: Record<string, unknown>; wallet: FxWalletView }> {
  if (!boolEnv(env.DEMO_MODE)) {
    throw new HttpError(403, 'DEMO_DISABLED', 'Carteira internacional demo disponível apenas em modo demo.');
  }
  const currency = String(input.currency ?? 'USD').toUpperCase();
  if (currency !== 'USD') {
    throw new HttpError(422, 'FX_CURRENCY_UNSUPPORTED', 'Moeda internacional não habilitada nesta versão.');
  }
  const amount = parseCapitalCents(input.amountCents);
  if (amount > FX_MAX_CENTS) {
    throw new HttpError(422, 'FX_LIMIT', `Aporte internacional limitado a ${formatUSD(FX_MAX_CENTS)} por operação.`);
  }
  const targetUserId = input.targetUserId || context.user.id;
  const memo = sanitizeDescription(input.memo ?? 'Aporte internacional de laboratório (demo)')
    || 'Aporte internacional de laboratório (demo)';
  const result = await postFxFund(env, context.user.id, targetUserId, amount, memo);
  const wallet = walletView(result.wallet);
  return {
    transfer: {
      id: result.transferId,
      currency,
      kind: 'FUNDING',
      status: 'POSTED',
      direction: 'IN',
      amountCents: amount,
      amountFormatted: formatUSD(amount),
      memo,
      counterpartyName: 'Tesouraria internacional (demo)',
      createdAt: result.createdAt,
      balanceAfterCents: wallet.balanceCents,
      balanceAfterFormatted: wallet.balanceFormatted,
    },
    wallet,
  };
}

/** Primeiro admin do modo demo nasce com os saldos de demonstração lastreados. */
export async function bootstrapDemoBalances(env: Env, userId: string): Promise<void> {
  if (!boolEnv(env.DEMO_MODE)) return;
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bank_transfers t
       JOIN bank_accounts a ON a.id = t.credit_account_id
      WHERE a.user_id = ? AND t.kind = 'FUNDING'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return;
  await postCapital(env, userId, userId, DEMO_START_BRL_CENTS, 'Capital inicial de demonstração');
  await postFxFund(env, userId, userId, DEMO_START_USD_CENTS, 'Capital internacional de demonstração');
  await audit(env, {
    actorId: userId,
    action: 'bank.demo.bootstrap',
    resource: 'bank_user',
    resourceId: userId,
    details: { brlCents: DEMO_START_BRL_CENTS, usdCents: DEMO_START_USD_CENTS },
  });
}

function rangeBound(value: string, edge: 'start' | 'end'): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${edge === 'start' ? '00:00:00.000Z' : '23:59:59.999Z'}`
    : value;
}

export async function statement(
  env: Env,
  context: { account: AccountRow | null },
  filters: { from?: string; to?: string; limit?: number },
): Promise<Record<string, unknown>> {
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  const from = rangeBound(filters.from ?? nowIso(-30 * 24 * 60 * 60 * 1000), 'start');
  const to = rangeBound(filters.to ?? nowIso(), 'end');
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const rows = await env.DB.prepare(
    `SELECT l.id, l.transfer_id, l.direction, l.amount_cents, l.balance_after_cents, l.created_at,
            t.kind, t.channel, t.description, t.end_to_end_id,
            CASE WHEN l.direction = 'DEBIT' THEN cu.name ELSE du.name END AS counterparty_name,
            CASE WHEN l.direction = 'DEBIT' THEN ca.branch ELSE da.branch END AS counterparty_branch,
            CASE WHEN l.direction = 'DEBIT' THEN ca.number ELSE da.number END AS counterparty_number
       FROM bank_ledger l
       JOIN bank_transfers t ON t.id = l.transfer_id
       JOIN bank_accounts da ON da.id = t.debit_account_id
       JOIN bank_users du ON du.id = da.user_id
       JOIN bank_accounts ca ON ca.id = t.credit_account_id
       JOIN bank_users cu ON cu.id = ca.user_id
      WHERE l.account_id = ? AND l.created_at >= ? AND l.created_at <= ?
      ORDER BY l.created_at DESC LIMIT ?`,
  )
    .bind(context.account.id, from, to, limit)
    .all<StatementRow>();

  const channelLabels: Record<string, string> = {
    INTERNAL: 'Transferência interna',
    PIX: 'Pix · chave',
    CREDIT: 'Crédito liberado',
    CREDIT_PAYMENT: 'Parcela de crédito',
    RSFN: 'RSFN · PAG0004',
    RSFN_REFUND: 'Estorno RSFN',
  };
  const entries = (rows.results ?? []).map((row) => ({
    id: row.id,
    transferId: row.transfer_id,
    direction: row.direction === 'DEBIT' ? 'OUT' : 'IN',
    directionLabel: row.direction === 'DEBIT' ? 'SAÍDA' : 'ENTRADA',
    kind: row.kind,
    channel: row.channel,
    kindLabel:
      row.kind === 'FUNDING' ? 'Aporte de tesouraria' : (channelLabels[row.channel] ?? 'Transferência interna'),
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    signedAmountFormatted: `${row.direction === 'DEBIT' ? '−' : '+'} ${formatBRL(row.amount_cents)}`,
    balanceAfterCents: row.balance_after_cents,
    balanceAfterFormatted: formatBRL(row.balance_after_cents),
    description: row.description ?? '',
    endToEndId: row.end_to_end_id,
    counterparty: {
      name: row.counterparty_name,
      account: maskedAccount(row.counterparty_branch, row.counterparty_number),
    },
    createdAt: row.created_at,
  }));

  const creditCents = entries.filter((entry) => entry.direction === 'IN').reduce((sum, entry) => sum + entry.amountCents, 0);
  const debitCents = entries.filter((entry) => entry.direction === 'OUT').reduce((sum, entry) => sum + entry.amountCents, 0);
  return {
    account: accountView(context.account),
    accountId: context.account.id,
    balanceCents: context.account.balance_cents,
    balanceFormatted: formatBRL(context.account.balance_cents),
    range: { from, to },
    summary: {
      creditCents,
      creditFormatted: formatBRL(creditCents),
      debitCents,
      debitFormatted: formatBRL(debitCents),
      entries: entries.length,
    },
    entries,
  };
}

export async function statementCsv(
  env: Env,
  context: AuthContext,
  filters: { from?: string; to?: string },
): Promise<string> {
  const data = (await statement(env, context, { ...filters, limit: 200 })) as {
    entries: Array<Record<string, unknown>>;
  };
  const escape = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = ['Data;Direção;Tipo;Contraparte;Conta;Descrição;EndToEnd;Valor;Saldo após'];
  for (const entry of data.entries as Array<Record<string, unknown>>) {
    const counterparty = entry.counterparty as { name: string; account: string };
    lines.push(
      [
        escape(entry.createdAt),
        escape(entry.directionLabel),
        escape(entry.kindLabel),
        escape(counterparty.name),
        escape(counterparty.account),
        escape(entry.description),
        escape(entry.endToEndId),
        escape(entry.signedAmountFormatted),
        escape(entry.balanceAfterFormatted),
      ].join(';'),
    );
  }
  return lines.join('\r\n');
}

async function receiptPayload(
  env: Env,
  transferId: string,
  requester: { userId: string; role: string },
): Promise<Record<string, unknown>> {
  const transfer = await env.DB.prepare('SELECT * FROM bank_transfers WHERE id = ?')
    .bind(transferId)
    .first<TransferRow>();
  if (!transfer) throw new HttpError(404, 'TRANSFER_NOT_FOUND', 'Transferência não encontrada.');
  const debit = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.document, a.id AS account_id, a.branch, a.number
       FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id WHERE a.id = ?`,
  )
    .bind(transfer.debit_account_id)
    .first<RecipientRow>();
  const credit = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.document, a.id AS account_id, a.branch, a.number
       FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id WHERE a.id = ?`,
  )
    .bind(transfer.credit_account_id)
    .first<RecipientRow>();
  const authorized = debit?.user_id === requester.userId || credit?.user_id === requester.userId;
  if (!authorized && requester.role !== 'ADMIN') {
    throw new HttpError(403, 'FORBIDDEN', 'Comprovante restrito às partes da transferência.');
  }
  const direction: 'IN' | 'OUT' = debit?.user_id === requester.userId ? 'OUT' : 'IN';
  const ledger = await env.DB.prepare(
    'SELECT direction, amount_cents, balance_after_cents, created_at FROM bank_ledger WHERE transfer_id = ? ORDER BY direction DESC',
  )
    .bind(transferId)
    .all<Pick<LedgerRow, 'direction' | 'amount_cents' | 'balance_after_cents' | 'created_at'>>();
  const rows = ledger.results ?? [];
  const balanced =
    rows.reduce(
      (total, entry) => total + (entry.direction === 'DEBIT' ? entry.amount_cents : -entry.amount_cents),
      0,
    ) === 0;
  const hash = await sha256Hex(
    `${transfer.id}|${transfer.end_to_end_id}|${transfer.amount_cents}|${transfer.debit_account_id}|${transfer.credit_account_id}|${transfer.created_at}`,
  );
  const party = (row: RecipientRow | null, role: string) =>
    row
      ? {
          role,
          name: row.name,
          documentMasked: maskDocument(row.document),
          account: `${row.branch} / ${row.number.slice(0, -1)}-${row.number.slice(-1)}`,
        }
      : null;
  return {
    transfer: {
      ...(await transferView(env, transfer, direction)),
      parties: [party(debit, 'ORIGEM'), party(credit, 'DESTINO')].filter(Boolean),
    },
    ledger: rows.map((entry) => ({
      direction: entry.direction,
      amountCents: entry.amount_cents,
      balanceAfterCents: entry.balance_after_cents,
      createdAt: entry.created_at,
    })),
    integrity: { algorithm: 'SHA-256', hash, balanced },
  };
}

async function storeReceipt(
  env: Env,
  transferId: string,
  requester: { id: string; role: string },
): Promise<void> {
  try {
    const payload = await receiptPayload(env, transferId, { userId: requester.id, role: requester.role });
    await env.RECEIPTS.put(`receipts/${transferId}.json`, JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { transferId, userId: requester.id },
    });
  } catch (error) {
    console.error('r2.receipt_failed', {
      transferId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function receipt(env: Env, context: AuthContext, transferId: string): Promise<Record<string, unknown>> {
  return receiptPayload(env, transferId, { userId: context.user.id, role: context.user.role });
}

export async function receiptFromR2(env: Env, context: AuthContext, transferId: string): Promise<Response> {
  const object = await env.RECEIPTS.get(`receipts/${transferId}.json`);
  if (!object) {
    const payload = await receiptPayload(env, transferId, { userId: context.user.id, role: context.user.role });
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const owner = (await env.DB.prepare(
    `SELECT 1 AS ok FROM bank_transfers t
       JOIN bank_accounts a ON a.id IN (t.debit_account_id, t.credit_account_id)
      WHERE t.id = ? AND a.user_id = ? LIMIT 1`,
  )
    .bind(transferId, context.user.id)
    .first<{ ok: number }>()) ?? null;
  if (!owner && context.user.role !== 'ADMIN') {
    throw new HttpError(403, 'FORBIDDEN', 'Comprovante restrito às partes.');
  }
  return new Response(object.body, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=60' },
  });
}

export async function creditScore(
  env: Env,
  context: { account: AccountRow | null; user: { created_at: string } },
): Promise<Record<string, unknown>> {
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  const account = context.account;
  const tenureDays = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(context.user.created_at)) / (24 * 60 * 60 * 1000)),
  );
  const cutoff = nowIso(-90 * 24 * 60 * 60 * 1000);
  const activity = await env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volume
       FROM bank_transfers WHERE debit_account_id = ? AND created_at >= ?`,
  )
    .bind(account.id, cutoff)
    .first<{ count: number; volume: number }>();
  const tenurePoints = Math.min(120, Math.floor(tenureDays * 0.4));
  const balancePoints = Math.min(180, Math.floor(account.balance_cents / 100));
  const activityPoints = Math.min(150, (activity?.count ?? 0) * 6);
  const volumePoints = Math.min(120, Math.floor((activity?.volume ?? 0) / 10_000));
  const statusPoints = account.status === 'ACTIVE' ? 100 : 0;
  const score = Math.min(1000, 300 + tenurePoints + balancePoints + activityPoints + volumePoints + statusPoints);
  const band =
    score >= 800 ? 'MUITO ALTO' : score >= 650 ? 'ALTO' : score >= 500 ? 'MÉDIO' : score >= 350 ? 'BAIXO' : 'MUITO BAIXO';
  const suggestedLimitCents = Math.max(
    0,
    Math.min(account.per_transfer_limit_cents, Math.floor(account.balance_cents * 0.5 + score * 50)),
  );
  return {
    score,
    band,
    suggestedLimitCents,
    suggestedLimitFormatted: formatBRL(suggestedLimitCents),
    factors: [
      { name: 'Tempo de conta', points: tenurePoints, max: 120, detail: `${tenureDays} dias` },
      { name: 'Saldo atual', points: balancePoints, max: 180, detail: formatBRL(account.balance_cents) },
      { name: 'Atividade (90 dias)', points: activityPoints, max: 150, detail: `${activity?.count ?? 0} transferências` },
      { name: 'Volume (90 dias)', points: volumePoints, max: 120, detail: formatBRL(activity?.volume ?? 0) },
      { name: 'Conta ativa', points: statusPoints, max: 100, detail: account.status },
    ],
    disclaimer:
      'Score interno determinístico do xPartner Bank. Não é score de bureau de crédito e não concede crédito automaticamente.',
    computedAt: nowIso(),
  };
}

export async function aiInsights(env: Env, context: AuthContext): Promise<Record<string, unknown>> {
  if (!context.account) throw new HttpError(403, 'ACCOUNT_MISSING', 'Conta corrente não encontrada.');
  const cutoff = nowIso(-30 * 24 * 60 * 60 * 1000);
  const rows = await env.DB.prepare(
    `SELECT COALESCE(t.description, 'Sem descrição') AS label,
            SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount_cents ELSE 0 END) AS debit,
            SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_cents ELSE 0 END) AS credit,
            COUNT(*) AS entries
       FROM bank_ledger l JOIN bank_transfers t ON t.id = l.transfer_id
      WHERE l.account_id = ? AND l.created_at >= ?
      GROUP BY label ORDER BY (debit + credit) DESC LIMIT 8`,
  )
    .bind(context.account.id, cutoff)
    .all<{ label: string; debit: number; credit: number; entries: number }>();
  const data = (rows.results ?? []).map((row) => ({ ...row }));
  const debit = data.reduce((sum, row) => sum + row.debit, 0);
  const credit = data.reduce((sum, row) => sum + row.credit, 0);
  const top = data[0];
  const heuristic =
    data.length === 0
      ? 'Ainda não há movimento nos últimos 30 dias. Faça uma transferência interna para gerar análise.'
      : `Nos últimos 30 dias entraram ${formatBRL(credit)} e saíram ${formatBRL(debit)}. ` +
        `A maior movimentação foi "${top.label}" (${top.entries} lançamentos). ` +
        (debit > credit
          ? 'O ritmo de saída supera as entradas; revise despesas recorrentes.'
          : 'As entradas superam as saídas; considere reservar parte do saldo.');

  const prompt = [
    'Você é um analista financeiro do xPartner Bank. Responda em português do Brasil, em no máximo 3 frases,',
    'com orientação prática e sem prometer crédito. Dados dos últimos 30 dias:',
    `entradas=${formatBRL(credit)}; saidas=${formatBRL(debit)};`,
    `categorias=${data.map((row) => `${row.label}: saida ${formatBRL(row.debit)}, entrada ${formatBRL(row.credit)}`).join('; ') || 'sem movimento'}.`,
    'Saldo atual=' + formatBRL(context.account.balance_cents) + '.',
  ].join(' ');

  try {
    const result = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'Você é um assistente financeiro objetivo, seguro e sem aconselhamento de investimento.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 220,
      temperature: 0.3,
    })) as { response?: string };
    const insight = (result.response ?? '').trim();
    return {
      source: 'workers-ai',
      model: '@cf/meta/llama-3.1-8b-instruct',
      insight: insight || heuristic,
      fallbackInsight: heuristic,
      windowDays: 30,
      totals: {
        creditCents: credit,
        creditFormatted: formatBRL(credit),
        debitCents: debit,
        debitFormatted: formatBRL(debit),
      },
      categories: data,
      generatedAt: nowIso(),
    };
  } catch (error) {
    console.error('workers-ai.failed', error instanceof Error ? error.message : String(error));
    return {
      source: 'heuristic',
      model: null,
      insight: heuristic,
      windowDays: 30,
      totals: {
        creditCents: credit,
        creditFormatted: formatBRL(credit),
        debitCents: debit,
        debitFormatted: formatBRL(debit),
      },
      categories: data,
      generatedAt: nowIso(),
    };
  }
}

export async function lookupRecipient(
  env: Env,
  context: AuthContext,
  type: string,
  query: string,
): Promise<Record<string, unknown>> {
  const value = String(query ?? '').trim();
  if (!value) throw new HttpError(422, 'INVALID_QUERY', 'Informe o valor da consulta.');
  let recipient: RecipientRow;
  if (type === 'document') recipient = await resolveRecipient(env, { document: value });
  else if (type === 'email') recipient = await resolveRecipient(env, { email: value });
  else if (type === 'pix') recipient = await resolveRecipient(env, { pixKey: value });
  else recipient = await resolveRecipient(env, { accountNumber: value });
  return {
    recipient: {
      ...recipientView(recipient),
      numberMasked: recipient.number,
      ...(recipient.pix_key_type
        ? { keyMasked: recipient.pix_key_masked ?? null, keyType: recipient.pix_key_type }
        : {}),
    },
    self: recipient.user_id === context.user.id,
  };
}

export async function ledgerSummary(env: Env): Promise<Record<string, unknown>> {
  return ledgerTrial(env);
}

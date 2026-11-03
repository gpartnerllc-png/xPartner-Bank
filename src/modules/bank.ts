import { createHash, randomInt } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { assertCents, assertPositiveCents, formatBRL, type Cents } from '../kernel/money.ts';
import { formatDocument, maskDocument, onlyDigits } from '../domain/documents.ts';

export const TREASURY_USER_ID = 'bank_user_system';
export const TREASURY_ACCOUNT_ID = 'bank_acc_system';
export const TREASURY_OPENING_CENTS = 0; // tesouraria começa zerada: só movimento real gera saldo
export const DEMO_FUNDING_MAX_CENTS = 1_000_000; // R$ 10.000,00 por aporte
export const DEMO_FUNDING_DAILY_CENTS = 5_000_000; // R$ 50.000,00 por dia

/**
 * Tesouraria de capital: é a contraparte dos aportes de grande porte. Ela abre
 * zerada e só recebe dinheiro de um aporte anterior — o aporte nunca cria
 * saldo, ele apenas move o que já existe para a conta do titular.
 */
export const DEMO_CAPITAL_USER_ID = 'bank_user_capital';
export const DEMO_CAPITAL_ACCOUNT_ID = 'bank_acc_capital';
export const DEMO_CAPITAL_OPENING_CENTS = 0; // sem lastro de vitrine: aporte não cria dinheiro
export const DEMO_CAPITAL_MAX_CENTS = 50_000_000_000_000; // R$ 500.000.000.000,00 por operação

export interface BankAccountRow {
  id: string;
  user_id: string;
  branch: string;
  number: string;
  kind: 'CHECKING' | 'SAVINGS';
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
  balance_cents: number;
  opening_balance_cents: number;
  per_transfer_limit_cents: number;
  daily_limit_cents: number;
  created_at: string;
  updated_at: string;
}

export interface BankAccountView {
  id: string;
  branch: string;
  number: string;
  formattedNumber: string;
  kind: string;
  status: string;
  balanceCents: Cents;
  balanceFormatted: string;
  openingBalanceCents: Cents;
  perTransferLimitCents: Cents;
  dailyLimitCents: Cents;
  createdAt: string;
}

export interface BankTransferRow {
  id: string;
  kind: 'INTERNAL' | 'FUNDING';
  debit_account_id: string;
  credit_account_id: string;
  amount_cents: number;
  description: string | null;
  status: 'POSTED' | 'REVERSED';
  end_to_end_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  initiator_id: string;
  recipient_name: string | null;
  channel: string;
  created_at: string;
}

interface RecipientRow {
  user_id: string;
  name: string;
  document: string;
  user_status: string;
  account_id: string;
  branch: string;
  number: string;
  account_status: string;
}

export function accountCheckDigit(base: string): string {
  let sum = 0;
  let weight = 2;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const digit = 11 - (sum % 11);
  return digit >= 10 ? '0' : String(digit);
}

export interface AccountNumberCheck {
  base: string;
  expectedDigit: string;
  providedDigit: string;
  valid: boolean;
  /** true quando o DV informado usa a convenção legada "X" para resto 10. */
  legacyX: boolean;
}

/**
 * Confere o dígito verificador FEBRABAN (módulo 11, pesos 2..9).
 * Aceita as duas convenções vistas em integrações: resto 10 vira "0" (padrão xPartner)
 * ou "X" (implementações legadas). O valor canônico persistido é sempre "0".
 */
export function validateAccountNumber(base: string, providedDigit: string): AccountNumberCheck {
  const cleanBase = onlyDigits(base);
  if (cleanBase.length < 4 || cleanBase.length > 16) {
    throw Errors.validation('Número base da conta deve ter de 4 a 16 dígitos.');
  }
  const raw = String(providedDigit ?? '').trim().toUpperCase();
  if (!/^[0-9X]$/.test(raw)) throw Errors.validation('Dígito verificador deve ser 0-9 ou X.');
  const expectedDigit = accountCheckDigit(cleanBase);
  const legacyX = raw === 'X' && expectedDigit === '0';
  return {
    base: cleanBase,
    expectedDigit,
    providedDigit: raw,
    valid: raw === expectedDigit || legacyX,
    legacyX,
  };
}


export function nextAccountNumber(db: Db): string {
  db.prepare("UPDATE bank_sequences SET value = value + 1 WHERE name = 'account'").run();
  const row = db.prepare("SELECT value FROM bank_sequences WHERE name = 'account'").get() as
    | { value: number }
    | undefined;
  const base = String(row?.value ?? 1_000_001).padStart(7, '0').slice(-7);
  return `${base}${accountCheckDigit(base)}`;
}

/** Cria a conta do usuário uma única vez. Idempotente por user_id. */
export function ensureAccount(db: Db, userId: string, now = Date.now()): BankAccountRow {
  const existing = db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId) as
    | BankAccountRow
    | undefined;
  if (existing) return existing;
  const timestamp = nowIso(now);
  const id = newId('bacc', now);
  const number = nextAccountNumber(db);
  db.prepare(
    `INSERT INTO bank_accounts (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
       per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
     VALUES (?, ?, '0001', ?, 'CHECKING', 'ACTIVE', 0, 0, 5000000, 10000000, ?, ?)`,
  ).run(id, userId, number, timestamp, timestamp);
  return db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id) as unknown as BankAccountRow;
}

export function ensureTreasury(db: Db, now = Date.now()): void {
  const timestamp = nowIso(now);
  db.prepare(
    `INSERT OR IGNORE INTO bank_users
       (id, name, document, email, phone, password_hash, role, status, created_at, updated_at)
     VALUES (?, 'Tesouraria xPartner', '00000000000000', 'tesouraria@xpartner.internal', NULL,
             '!system-account-no-login!', 'SYSTEM', 'ACTIVE', ?, ?)`,
  ).run(TREASURY_USER_ID, timestamp, timestamp);
  db.prepare(
    `INSERT OR IGNORE INTO bank_accounts
       (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
        per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
     VALUES (?, ?, '0000', '00000000', 'CHECKING', 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
  ).run(
    TREASURY_ACCOUNT_ID,
    TREASURY_USER_ID,
    TREASURY_OPENING_CENTS,
    TREASURY_OPENING_CENTS,
    100_000_000_000,
    100_000_000_000,
    timestamp,
    timestamp,
  );
}

export function ensureCapital(db: Db, now = Date.now()): void {
  const timestamp = nowIso(now);
  db.prepare(
    `INSERT OR IGNORE INTO bank_users
       (id, name, document, email, phone, password_hash, role, status, created_at, updated_at)
     VALUES (?, 'Tesouraria de capital xPartner', '00000000000002', 'capital@xpartner.internal', NULL,
             '!system-account-no-login!', 'SYSTEM', 'ACTIVE', ?, ?)`,
  ).run(DEMO_CAPITAL_USER_ID, timestamp, timestamp);
  // A conta de capital nasceu com o rótulo da vitrine; o INSERT OR IGNORE não
  // toca em linha existente, então o nome honesto é corrigido aqui.
  db.prepare('UPDATE bank_users SET name = ? WHERE id = ?').run('Tesouraria de capital xPartner', DEMO_CAPITAL_USER_ID);
  db.prepare(
    `INSERT OR IGNORE INTO bank_accounts
       (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
        per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
     VALUES (?, ?, '0000', '99999999', 'CHECKING', 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEMO_CAPITAL_ACCOUNT_ID,
    DEMO_CAPITAL_USER_ID,
    DEMO_CAPITAL_OPENING_CENTS,
    DEMO_CAPITAL_OPENING_CENTS,
    DEMO_CAPITAL_MAX_CENTS,
    DEMO_CAPITAL_MAX_CENTS,
    timestamp,
    timestamp,
  );
}

export function accountView(row: BankAccountRow): BankAccountView {
  const base = row.number.slice(0, -1);
  const digit = row.number.slice(-1);
  return {
    id: row.id,
    branch: row.branch,
    number: row.number,
    formattedNumber: `${row.branch} / ${base}-${digit}`,
    kind: row.kind,
    status: row.status,
    balanceCents: row.balance_cents,
    balanceFormatted: formatBRL(row.balance_cents),
    openingBalanceCents: row.opening_balance_cents,
    perTransferLimitCents: row.per_transfer_limit_cents,
    dailyLimitCents: row.daily_limit_cents,
    createdAt: row.created_at,
  };
}

export function maskedAccountLabel(branch: string, number: string): string {
  return `${branch} / ••••${number.slice(-4)}`;
}

export function balanceFromLedger(db: Db, accountId: string): Cents {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0) AS delta
         FROM bank_ledger WHERE account_id = ?`,
    )
    .get(accountId) as { delta: number };
  const account = db.prepare('SELECT opening_balance_cents FROM bank_accounts WHERE id = ?').get(accountId) as
    | { opening_balance_cents: number }
    | undefined;
  return (account?.opening_balance_cents ?? 0) + row.delta;
}

export function ledgerTrialBalance(db: Db): { debitCents: number; creditCents: number; balanced: boolean } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents END), 0) AS debitCents,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents END), 0) AS creditCents
         FROM bank_ledger`,
    )
    .get() as { debitCents: number; creditCents: number };
  return { ...row, balanced: row.debitCents === row.creditCents };
}

export type RecipientQuery =
  | { accountNumber: string }
  | { document: string }
  | { email: string };

export interface TransferInput {
  userId: string;
  accountId: string;
  amountCents: number;
  description?: string;
  recipient: RecipientQuery;
  idempotencyKey?: string;
  /** Canal de iniciação: PIX quando o favorecido foi escolhido por chave Pix. */
  channel?: 'INTERNAL' | 'PIX' | 'CREDIT' | 'CREDIT_PAYMENT' | 'PDV' | 'CAPITAL';
  now?: number;
}

export interface TransferView {
  id: string;
  kind: string;
  status: string;
  channel: string;
  direction: 'IN' | 'OUT';
  amountCents: Cents;
  amountFormatted: string;
  description: string;
  endToEndId: string;
  counterparty: {
    name: string;
    documentMasked: string;
    account: string;
  };
  createdAt: string;
  balanceAfterCents?: Cents;
  balanceAfterFormatted?: string;
}

export interface StatementEntry extends TransferView {
  transferId: string;
  balanceAfterCents: Cents;
  balanceAfterFormatted: string;
  kindLabel: string;
  channel: string;
}

export interface CreditScore {
  score: number;
  band: string;
  suggestedLimitCents: Cents;
  suggestedLimitFormatted: string;
  factors: Array<{ label: string; points: number; max: number }>;
  computedAt: string;
  disclaimer: string;
}

function normalizeDescription(input: string | undefined): string {
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return 'Transferência entre contas';
  if (value.length > 120) throw Errors.validation('Descrição excede 120 caracteres.');
  return value;
}

function resolveRecipient(db: Db, actorUserId: string, query: RecipientQuery, allowSelf = false): RecipientRow {
  const columns = `u.id AS user_id, u.name, u.document, u.status AS user_status,
                   a.id AS account_id, a.branch, a.number, a.status AS account_status`;
  let row: RecipientRow | undefined;
  const base = `SELECT ${columns}
                  FROM bank_users u
                  JOIN bank_accounts a ON a.user_id = u.id
                 WHERE u.status = 'ACTIVE' AND a.status = 'ACTIVE' AND `;
  if ('accountNumber' in query) {
    let digits = onlyDigits(query.accountNumber);
    if (digits.length > 8) digits = digits.slice(-8);
    if (digits.length !== 8) {
      throw Errors.validation('Conta de destino inválida: informe agência e conta com 8 dígitos.');
    }
    row = db.prepare(`${base} a.number = ?`).get(digits) as unknown as RecipientRow | undefined;
  } else if ('document' in query) {
    const document = onlyDigits(query.document);
    if (document.length !== 11 && document.length !== 14) {
      throw Errors.validation('CPF/CNPJ do favorecido inválido.');
    }
    row = db.prepare(`${base} u.document = ?`).get(document) as unknown as RecipientRow | undefined;
  } else {
    const email = query.email.trim().toLowerCase();
    if (!email.includes('@')) throw Errors.validation('E-mail do favorecido inválido.');
    row = db.prepare(`${base} lower(u.email) = ?`).get(email) as unknown as RecipientRow | undefined;
  }
  if (!row) throw Errors.notFound('Favorecido não encontrado ou sem conta ativa no xPartner Bank.');
  if (!allowSelf && row.user_id === actorUserId) {
    throw Errors.validation('Não é possível transferir para a própria conta.');
  }
  return row;
}

function transferView(
  row: BankTransferRow,
  direction: 'IN' | 'OUT',
  counterparty: RecipientRow,
  balanceAfter?: number,
): TransferView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    channel: row.channel ?? 'INTERNAL',
    direction,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    description: row.description ?? '',
    endToEndId: row.end_to_end_id,
    counterparty: {
      name: counterparty.name,
      documentMasked: maskDocument(counterparty.document),
      account: maskedAccountLabel(counterparty.branch, counterparty.number),
    },
    createdAt: row.created_at,
    balanceAfterCents: balanceAfter,
    balanceAfterFormatted: balanceAfter === undefined ? undefined : formatBRL(balanceAfter),
  };
}

function endToEndId(now: number): string {
  const stamp = nowIso(now).replace(/\D/g, '').slice(0, 12);
  let suffix = '';
  for (let index = 0; index < 11; index += 1) suffix += String(randomInt(0, 10));
  return `E99999999${stamp}${suffix}`;
}

function requestFingerprint(input: TransferInput): string {
  const recipient = 'accountNumber' in input.recipient
    ? `acc:${onlyDigits(input.recipient.accountNumber).slice(-8)}`
    : 'document' in input.recipient
      ? `doc:${onlyDigits(input.recipient.document)}`
      : `email:${input.recipient.email.trim().toLowerCase()}`;
  return sha256Hex(`${recipient}|${input.amountCents}|${normalizeDescription(input.description)}`);
}

function counterpartyFor(db: Db, row: BankTransferRow, direction: 'IN' | 'OUT'): RecipientRow {
  const accountId = direction === 'OUT' ? row.credit_account_id : row.debit_account_id;
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name, u.document, u.status AS user_status,
              a.id AS account_id, a.branch, a.number, a.status AS account_status
         FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
        WHERE a.id = ?`,
    )
    .get(accountId) as unknown as RecipientRow;
}

export class BankService {
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  lookupRecipient(userId: string, query: RecipientQuery): {
    name: string;
    documentMasked: string;
    account: string;
    branch: string;
    numberMasked: string;
  } {
    const row = resolveRecipient(this.db, userId, query, true);
    return {
      name: row.name,
      documentMasked: maskDocument(row.document),
      account: maskedAccountLabel(row.branch, row.number),
      branch: row.branch,
      numberMasked: `••••${row.number.slice(-4)}`,
    };
  }

  transfer(input: TransferInput): { transfer: TransferView; account: BankAccountView; replayed: boolean } {
    return tx(this.db, () => this.postTransfer(input));
  }

  /**
   * Executa a transferência sem abrir transação própria. Só deve ser chamado
   * por serviços que já controlam a transação (crédito, PDV), para que o
   * lançamento contábil e o fato de negócio sejam atômicos.
   */
  postTransfer(input: TransferInput): { transfer: TransferView; account: BankAccountView; replayed: boolean } {
    const now = input.now ?? Date.now();
    const timestamp = nowIso(now);
    const amount = assertPositiveCents(input.amountCents, 'amountCents');
    const description = normalizeDescription(input.description);
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length < 8) {
      throw Errors.validation('Idempotency-Key deve ter ao menos 8 caracteres.');
    }
    if (idempotencyKey && idempotencyKey.length > 120) {
      throw Errors.validation('Idempotency-Key excede 120 caracteres.');
    }
    const fingerprint = requestFingerprint({ ...input, description });

    if (idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM bank_transfers WHERE initiator_id = ? AND idempotency_key = ?')
        .get(input.userId, idempotencyKey) as unknown as unknown as BankTransferRow | undefined;
      if (existing) {
        if (existing.request_hash !== fingerprint) {
          throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
        }
        const account = this.db
          .prepare('SELECT * FROM bank_accounts WHERE id = ?')
          .get(input.accountId) as unknown as BankAccountRow;
        const sent = existing.debit_account_id === input.accountId;
        const counterparty = counterpartyFor(this.db, existing, sent ? 'OUT' : 'IN');
        return {
          transfer: transferView(existing, sent ? 'OUT' : 'IN', counterparty),
          account: accountView(account),
          replayed: true,
        };
      }
    }

      const sender = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?')
        .get(input.accountId, input.userId) as unknown as unknown as BankAccountRow | undefined;
      if (!sender) throw Errors.notFound('Conta de origem não encontrada.');
      if (sender.status !== 'ACTIVE') {
        throw new AppError('ACCOUNT_BLOCKED', 'Conta de origem bloqueada ou encerrada.', 403);
      }
      if (amount > sender.per_transfer_limit_cents) {
        throw new AppError(
          'TRANSFER_LIMIT',
          `Valor acima do limite por transferência de ${formatBRL(sender.per_transfer_limit_cents)}.`,
          422,
        );
      }

      const recipient = resolveRecipient(this.db, input.userId, input.recipient, true);
      if (recipient.user_id === input.userId || recipient.account_id === sender.id) {
        throw Errors.validation('Não é possível transferir para a própria conta.');
      }

      const moved = this.db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total
             FROM bank_transfers
            WHERE debit_account_id = ? AND status = 'POSTED' AND created_at >= ?`,
        )
        .get(sender.id, nowIso(now - 86_400_000)) as { total: number };
      if (moved.total + amount > sender.daily_limit_cents) {
        throw new AppError(
          'DAILY_LIMIT',
          `Limite diário de ${formatBRL(sender.daily_limit_cents)} excedido. Já movimentado nas últimas 24h: ${formatBRL(moved.total)}.`,
          422,
        );
      }

      const debit = this.db
        .prepare(
          `UPDATE bank_accounts
              SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(amount, timestamp, sender.id, amount);
      if (debit.changes !== 1) {
        throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente para esta transferência.', 422);
      }
      this.db
        .prepare(
          `UPDATE bank_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`,
        )
        .run(amount, timestamp, recipient.account_id);

      const id = newId('btr', now);
      const e2e = endToEndId(now);
      const debitAfter = sender.balance_cents - amount;
      const creditAccount = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(recipient.account_id) as unknown as BankAccountRow;
      this.db
        .prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, channel, created_at)
           VALUES (?, 'INTERNAL', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sender.id,
          recipient.account_id,
          amount,
          description,
          e2e,
          idempotencyKey ?? null,
          idempotencyKey ? fingerprint : null,
          input.userId,
          recipient.name,
          input.channel ?? 'INTERNAL',
          timestamp,
        );

      const insertEntry = this.db.prepare(
        `INSERT INTO bank_ledger
           (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(newId('ble', now), id, sender.id, 'DEBIT', amount, debitAfter, description, timestamp);
      insertEntry.run(
        newId('ble', now),
        id,
        recipient.account_id,
        'CREDIT',
        amount,
        creditAccount.balance_cents,
        description,
        timestamp,
      );

      enqueueEvent(this.db, {
        topic: 'bank.transfer',
        type: 'bank.transfer.posted',
        key: input.userId,
        payload: {
          transferId: id,
          amountCents: amount,
          fromAccountId: sender.id,
          toAccountId: recipient.account_id,
          fromUserId: input.userId,
          toUserId: recipient.user_id,
          endToEndId: e2e,
          description,
          createdAt: timestamp,
        },
      });
      audit(this.db, input.userId, 'bank.transfer.posted', `bank_transfer:${id}`, {
        amountCents: amount,
        from: sender.id,
        to: recipient.account_id,
        endToEndId: e2e,
      });

      const created = this.db.prepare('SELECT * FROM bank_transfers WHERE id = ?').get(id) as unknown as BankTransferRow;
      return {
        transfer: transferView(created, 'OUT', recipient, debitAfter),
        account: accountView({ ...sender, balance_cents: debitAfter }),
        replayed: false,
      };
  }

  /** Aporte da tesouraria para um titular: exige saldo de verdade e gera as duas partidas do razão. */
  funding(input: {
    actorUserId: string;
    targetUserId: string;
    amountCents: number;
    description?: string;
    now?: number;
  }): { transfer: TransferView; account: BankAccountView; replayed: boolean } {
    if (!this.config.demoMode) {
      throw new AppError('DEMO_ONLY', 'Aporte de tesouraria disponível apenas em ambiente demo.', 403);
    }
    const now = input.now ?? Date.now();
    const timestamp = nowIso(now);
    const amount = assertPositiveCents(input.amountCents, 'amountCents');
    if (amount > DEMO_FUNDING_MAX_CENTS) {
      throw Errors.validation(`Aporte de tesouraria limitado a ${formatBRL(DEMO_FUNDING_MAX_CENTS)} por operação.`);
    }
    const description = normalizeDescription(input.description ?? 'Aporte da tesouraria');

    return tx(this.db, () => {
      const target = this.db
        .prepare(
          `SELECT a.* FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
            WHERE a.user_id = ? AND u.status = 'ACTIVE' AND a.status = 'ACTIVE'`,
        )
        .get(input.targetUserId) as unknown as unknown as BankAccountRow | undefined;
      if (!target) throw Errors.notFound('Conta de destino ativa não encontrada para aporte.');

      const funded = this.db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bank_transfers
            WHERE credit_account_id = ? AND kind = 'FUNDING' AND status = 'POSTED' AND created_at >= ?`,
        )
        .get(target.id, nowIso(now - 86_400_000)) as { total: number };
      if (funded.total + amount > DEMO_FUNDING_DAILY_CENTS) {
        throw new AppError(
          'FUNDING_LIMIT',
          `Limite diário de aporte demo é ${formatBRL(DEMO_FUNDING_DAILY_CENTS)} por conta.`,
          422,
        );
      }

      const debit = this.db
        .prepare(
          `UPDATE bank_accounts SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(amount, timestamp, TREASURY_ACCOUNT_ID, amount);
      if (debit.changes !== 1) {
        throw new AppError('TREASURY_EMPTY', 'Tesouraria sem saldo para este aporte.', 409);
      }
      this.db
        .prepare('UPDATE bank_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
        .run(amount, timestamp, target.id);
      const treasury = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(TREASURY_ACCOUNT_ID) as unknown as BankAccountRow;
      const creditAfter = target.balance_cents + amount;

      const id = newId('btr', now);
      const e2e = endToEndId(now);
      this.db
        .prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, created_at)
           VALUES (?, 'FUNDING', ?, ?, ?, ?, 'POSTED', ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(id, TREASURY_ACCOUNT_ID, target.id, amount, description, e2e, input.actorUserId, 'Tesouraria xPartner', timestamp);
      const insertEntry = this.db.prepare(
        `INSERT INTO bank_ledger
           (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(newId('ble', now), id, TREASURY_ACCOUNT_ID, 'DEBIT', amount, treasury.balance_cents - amount, description, timestamp);
      insertEntry.run(newId('ble', now), id, target.id, 'CREDIT', amount, creditAfter, description, timestamp);

      enqueueEvent(this.db, {
        topic: 'bank.transfer',
        type: 'bank.funding.posted',
        key: input.targetUserId,
        payload: {
          transferId: id,
          amountCents: amount,
          userId: input.targetUserId,
          actorUserId: input.actorUserId,
          endToEndId: e2e,
          createdAt: timestamp,
        },
      });
      audit(this.db, input.actorUserId, 'bank.funding.posted', `bank_transfer:${id}`, {
        amountCents: amount,
        targetUserId: input.targetUserId,
        endToEndId: e2e,
      });

      const created = this.db.prepare('SELECT * FROM bank_transfers WHERE id = ?').get(id) as unknown as BankTransferRow;
      const counterparty: RecipientRow = {
        user_id: TREASURY_USER_ID,
        name: 'Tesouraria xPartner',
        document: '00000000000000',
        user_status: 'ACTIVE',
        account_id: TREASURY_ACCOUNT_ID,
        branch: '0000',
        number: '00000000',
        account_status: 'ACTIVE',
      };
      return {
        transfer: transferView(created, 'IN', counterparty, creditAfter),
        account: accountView({ ...target, balance_cents: creditAfter }),
        replayed: false,
      };
    });
  }

  /**
   * Aporte da tesouraria de capital. Credita o titular a partir da conta de
   * capital, com duas partidas no ledger. Existe para dar lastro contábil a um
   * saldo injetado pelo administrador — nunca para fabricar número na tela.
   */
  demoCapital(input: {
    actorUserId: string;
    targetUserId: string;
    amountCents: number;
    description?: string;
    idempotencyKey?: string;
    now?: number;
  }): { transfer: TransferView; account: BankAccountView; replayed: boolean } {
    if (!this.config.demoMode) {
      throw new AppError('DEMO_ONLY', 'Capital de laboratório disponível apenas em ambiente demo.', 403);
    }
    const now = input.now ?? Date.now();
    const timestamp = nowIso(now);
    const amount = assertCents(input.amountCents);
    if (amount <= 0) throw Errors.validation('amountCents deve ser maior que zero.');
    if (amount > DEMO_CAPITAL_MAX_CENTS) {
      throw Errors.validation(`Aporte de capital limitado a ${formatBRL(DEMO_CAPITAL_MAX_CENTS)} por operação.`);
    }
    const description = normalizeDescription(input.description ?? 'Aporte de capital da tesouraria');
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 120)) {
      throw Errors.validation('Idempotency-Key deve ter entre 8 e 120 caracteres.');
    }
    const fingerprint = sha256Hex(`${input.targetUserId}|${amount}|${description}`);

    return tx(this.db, () => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM bank_transfers WHERE initiator_id = ? AND idempotency_key = ?')
          .get(input.actorUserId, idempotencyKey) as unknown as BankTransferRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) {
            throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
          }
          const account = this.db
            .prepare('SELECT * FROM bank_accounts WHERE id = ?')
            .get(existing.credit_account_id) as unknown as BankAccountRow;
          const capital: RecipientRow = {
            user_id: DEMO_CAPITAL_USER_ID,
            name: 'Tesouraria de capital xPartner',
            document: '00000000000002',
            user_status: 'ACTIVE',
            account_id: DEMO_CAPITAL_ACCOUNT_ID,
            branch: '0000',
            number: '99999999',
            account_status: 'ACTIVE',
          };
          return { transfer: transferView(existing, 'IN', capital), account: accountView(account), replayed: true };
        }
      }

      const target = this.db
        .prepare(
          `SELECT a.* FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
            WHERE a.user_id = ? AND u.status = 'ACTIVE' AND a.status = 'ACTIVE'`,
        )
        .get(input.targetUserId) as unknown as BankAccountRow | undefined;
      if (!target) throw Errors.notFound('Conta de destino ativa não encontrada para o aporte de capital.');

      const capital = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(DEMO_CAPITAL_ACCOUNT_ID) as unknown as BankAccountRow | undefined;
      if (!capital) throw Errors.notFound('Conta de capital de laboratório não encontrada.');

      const debit = this.db
        .prepare(
          `UPDATE bank_accounts SET balance_cents = balance_cents - ?, updated_at = ?
            WHERE id = ? AND balance_cents >= ?`,
        )
        .run(amount, timestamp, DEMO_CAPITAL_ACCOUNT_ID, amount);
      if (debit.changes !== 1) {
        throw new AppError('CAPITAL_EMPTY', 'Conta de capital de laboratório sem lastro para este aporte.', 409);
      }
      this.db
        .prepare('UPDATE bank_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
        .run(amount, timestamp, target.id);

      const id = newId('btr', now);
      const e2e = endToEndId(now);
      this.db
        .prepare(
          `INSERT INTO bank_transfers
             (id, kind, debit_account_id, credit_account_id, amount_cents, description, status,
              end_to_end_id, idempotency_key, request_hash, initiator_id, recipient_name, channel, created_at)
           VALUES (?, 'FUNDING', ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, 'Tesouraria de capital xPartner', 'CAPITAL', ?)`,
        )
        .run(
          id,
          DEMO_CAPITAL_ACCOUNT_ID,
          target.id,
          amount,
          description,
          e2e,
          idempotencyKey ?? null,
          idempotencyKey ? fingerprint : null,
          input.actorUserId,
          timestamp,
        );
      const creditAfter = target.balance_cents + amount;
      const capitalAfter = capital.balance_cents - amount;
      const insertEntry = this.db.prepare(
        `INSERT INTO bank_ledger
           (id, transfer_id, account_id, direction, amount_cents, balance_after_cents, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertEntry.run(newId('ble', now), id, DEMO_CAPITAL_ACCOUNT_ID, 'DEBIT', amount, capitalAfter, description, timestamp);
      insertEntry.run(newId('ble', now), id, target.id, 'CREDIT', amount, creditAfter, description, timestamp);

      enqueueEvent(this.db, {
        topic: 'bank.transfer',
        type: 'bank.capital.posted',
        key: input.targetUserId,
        payload: {
          transferId: id,
          amountCents: amount,
          userId: input.targetUserId,
          actorUserId: input.actorUserId,
          endToEndId: e2e,
          createdAt: timestamp,
        },
      });
      audit(this.db, input.actorUserId, 'bank.capital.posted', `bank_transfer:${id}`, {
        amountCents: amount,
        targetUserId: input.targetUserId,
        endToEndId: e2e,
      });

      const created = this.db.prepare('SELECT * FROM bank_transfers WHERE id = ?').get(id) as unknown as BankTransferRow;
      const counterparty: RecipientRow = {
        user_id: DEMO_CAPITAL_USER_ID,
        name: 'Tesouraria de capital xPartner',
        document: '00000000000002',
        user_status: 'ACTIVE',
        account_id: DEMO_CAPITAL_ACCOUNT_ID,
        branch: '0000',
        number: '99999999',
        account_status: 'ACTIVE',
      };
      return {
        transfer: transferView(created, 'IN', counterparty, creditAfter),
        account: accountView({ ...target, balance_cents: creditAfter }),
        replayed: false,
      };
    });
  }

  statement(
    accountId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ): { accountId: string; entries: StatementEntry[]; balanceCents: Cents; balanceFormatted: string } {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const clauses = ['l.account_id = ?'];
    const params: Array<string | number> = [accountId];
    if (options.from) {
      clauses.push('l.created_at >= ?');
      params.push(`${options.from}T00:00:00.000Z`);
    }
    if (options.to) {
      clauses.push('l.created_at <= ?');
      params.push(`${options.to}T23:59:59.999Z`);
    }
    const rows = this.db
      .prepare(
        `SELECT l.id AS ledger_id, l.direction, l.amount_cents, l.balance_after_cents, l.created_at,
                t.*,
                r.num_ctrl_if AS rsfn_num_ctrl_if,
                r.nome_destinatario AS rsfn_nome_destinatario,
                r.documento_destinatario AS rsfn_documento_destinatario,
                r.agencia_destinatario AS rsfn_agencia_destinatario,
                r.conta_destinatario AS rsfn_conta_destinatario,
                cu.name AS counterparty_name, cu.document AS counterparty_document,
                ca.branch AS counterparty_branch, ca.number AS counterparty_number
           FROM bank_ledger l
           JOIN bank_transfers t ON t.id = l.transfer_id
           LEFT JOIN bank_rsfn_messages r ON r.transfer_id = t.id
           JOIN bank_accounts ca
             ON ca.id = CASE WHEN l.direction = 'DEBIT' THEN t.credit_account_id ELSE t.debit_account_id END
           JOIN bank_users cu ON cu.id = ca.user_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY l.created_at DESC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<
      BankTransferRow & {
        ledger_id: string;
        direction: 'DEBIT' | 'CREDIT';
        balance_after_cents: number;
        rsfn_num_ctrl_if: string | null;
        rsfn_nome_destinatario: string | null;
        rsfn_documento_destinatario: string | null;
        rsfn_agencia_destinatario: string | null;
        rsfn_conta_destinatario: string | null;
        counterparty_name: string;
        counterparty_document: string;
        counterparty_branch: string;
        counterparty_number: string;
      }
    >;
    const account = this.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId) as
      | BankAccountRow
      | undefined;
    const entries: StatementEntry[] = rows.map((row) => {
      const direction = row.direction === 'DEBIT' ? 'OUT' : 'IN';
      const view = transferView(
        row,
        direction,
        {
          user_id: '',
          name: row.rsfn_num_ctrl_if && row.rsfn_nome_destinatario ? row.rsfn_nome_destinatario : row.counterparty_name,
          document:
            row.rsfn_num_ctrl_if && row.rsfn_documento_destinatario
              ? row.rsfn_documento_destinatario
              : row.counterparty_document,
          user_status: 'ACTIVE',
          account_id: '',
          branch:
            row.rsfn_num_ctrl_if && row.rsfn_agencia_destinatario
              ? row.rsfn_agencia_destinatario
              : row.counterparty_branch,
          number:
            row.rsfn_num_ctrl_if && row.rsfn_conta_destinatario
              ? row.rsfn_conta_destinatario
              : row.counterparty_number,
          account_status: 'ACTIVE',
        },
        row.balance_after_cents,
      );
      return {
        ...view,
        id: row.ledger_id,
        transferId: row.id,
        kind: row.rsfn_num_ctrl_if ? 'RSFN' : row.kind,
        balanceAfterCents: row.balance_after_cents,
        balanceAfterFormatted: formatBRL(row.balance_after_cents),
        kindLabel: row.rsfn_num_ctrl_if
          ? 'RSFN · PAG0004'
          : row.channel === 'PIX'
            ? direction === 'OUT'
              ? 'Pix enviado'
              : 'Pix recebido'
            : row.channel === 'CREDIT'
              ? direction === 'OUT'
                ? 'Crédito enviado'
                : 'Crédito liberado'
              : row.channel === 'CREDIT_PAYMENT'
                ? direction === 'OUT'
                  ? 'Parcela de crédito'
                  : 'Recebimento de parcela'
                : row.channel === 'PDV'
                  ? direction === 'OUT'
                    ? 'Estorno PDV'
                    : 'Liquidação de venda NFC-e'
                  : row.channel === 'CAPITAL'
                    ? direction === 'OUT'
                      ? 'Capital enviado'
                      : 'Aporte de capital da tesouraria'
                    : row.kind === 'FUNDING'
                      ? 'Aporte de tesouraria'
                      : direction === 'OUT'
                        ? 'Enviada'
                        : 'Recebida',
        channel: row.rsfn_num_ctrl_if
          ? 'RSFN'
          : row.channel === 'PIX'
            ? 'PIX'
            : row.channel === 'CREDIT_PAYMENT'
              ? 'CREDIT_PAYMENT'
              : row.channel === 'CREDIT'
                ? 'CREDIT'
                : row.channel === 'PDV'
                  ? 'PDV'
                  : row.channel === 'CAPITAL'
                    ? 'CAPITAL'
                    : row.kind,
      };
    });
    return {
      accountId,
      entries,
      balanceCents: account?.balance_cents ?? 0,
      balanceFormatted: formatBRL(account?.balance_cents ?? 0),
    };
  }

  statementCsv(accountId: string, options: { from?: string; to?: string } = {}): string {
    const { entries } = this.statement(accountId, { ...options, limit: 500 });
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      ['data', 'tipo', 'direcao', 'contraparte', 'valor', 'saldo_apos', 'descricao', 'end_to_end_id']
        .map(escape)
        .join(';'),
      ...entries.map((entry) =>
        [
          entry.createdAt,
          entry.kindLabel,
          entry.direction,
          entry.counterparty.name,
          (entry.amountCents / 100).toFixed(2).replace('.', ','),
          (entry.balanceAfterCents / 100).toFixed(2).replace('.', ','),
          entry.description,
          entry.endToEndId,
        ]
          .map((value) => escape(String(value)))
          .join(';'),
      ),
    ];
    return `\ufeff${lines.join('\r\n')}`;
  }

  receipt(
    transferId: string,
    requester: { userId: string; role: string },
  ): {
    transfer: TransferView & { parties: Array<{ role: string; name: string; documentMasked: string; account: string }> };
    ledger: Array<{ direction: string; amountCents: number; balanceAfterCents: number; createdAt: string }>;
    integrity: { hash: string; balanced: boolean };
  } {
    const row = this.db.prepare('SELECT * FROM bank_transfers WHERE id = ?').get(transferId) as
      | BankTransferRow
      | undefined;
    if (!row) throw Errors.notFound('Transferência não encontrada.');
    const parties = this.db
      .prepare(
        `SELECT u.id, u.name, u.document, a.id AS account_id, a.branch, a.number
           FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
          WHERE a.id IN (?, ?)
          ORDER BY a.id = ? DESC`,
      )
      .all(row.debit_account_id, row.credit_account_id, row.debit_account_id) as Array<{
      id: string;
      name: string;
      document: string;
      account_id: string;
      branch: string;
      number: string;
    }>;
    const isParticipant = parties.some((party) => party.id === requester.userId);
    if (!isParticipant && requester.role !== 'ADMIN') {
      throw Errors.forbidden('Comprovante disponível apenas para os participantes.');
    }
    const direction = parties[0]?.id === requester.userId ? 'OUT' : 'IN';
    const counterpartyRow = parties[direction === 'OUT' ? 1 : 0];
    const counterparty: RecipientRow = {
      user_id: counterpartyRow.id,
      name: counterpartyRow.name,
      document: counterpartyRow.document,
      user_status: 'ACTIVE',
      account_id: counterpartyRow.account_id,
      branch: counterpartyRow.branch,
      number: counterpartyRow.number,
      account_status: 'ACTIVE',
    };
    const ledgerRows = this.db
      .prepare(
        `SELECT direction, amount_cents, balance_after_cents, created_at
           FROM bank_ledger WHERE transfer_id = ? ORDER BY direction DESC`,
      )
      .all(transferId) as Array<{
      direction: string;
      amount_cents: number;
      balance_after_cents: number;
      created_at: string;
    }>;
    const balanced = ledgerRows.reduce(
      (total, entry) => total + (entry.direction === 'DEBIT' ? entry.amount_cents : -entry.amount_cents),
      0,
    ) === 0;
    const hash = createHash('sha256')
      .update(
        `${row.id}|${row.end_to_end_id}|${row.amount_cents}|${row.debit_account_id}|${row.credit_account_id}|${row.created_at}`,
      )
      .digest('hex');
    return {
      transfer: {
        ...transferView(row, direction, counterparty),
        parties: parties.map((party) => ({
          role: party.account_id === row.debit_account_id ? 'ORIGEM' : 'DESTINO',
          name: party.name,
          documentMasked: maskDocument(party.document),
          account: `${party.branch} / ${party.number.slice(0, -1)}-${party.number.slice(-1)}`,
        })),
      },
      ledger: ledgerRows.map((entry) => ({
        direction: entry.direction,
        amountCents: entry.amount_cents,
        balanceAfterCents: entry.balance_after_cents,
        createdAt: entry.created_at,
      })),
      integrity: { hash, balanced },
    };
  }

  creditScore(accountId: string, now = Date.now()): CreditScore {
    const account = this.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId) as
      | BankAccountRow
      | undefined;
    if (!account) throw Errors.notFound('Conta não encontrada.');
    const since = nowIso(now - 90 * 86_400_000);
    const activity = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volume
           FROM bank_transfers
          WHERE (debit_account_id = ? OR credit_account_id = ?) AND status = 'POSTED' AND created_at >= ?`,
      )
      .get(accountId, accountId, since) as { count: number; volume: number };
    const tenureDays = Math.max(0, Math.floor((now - new Date(account.created_at).getTime()) / 86_400_000));
    const factors = [
      { label: 'Tempo de conta', points: Math.min(200, tenureDays * 4), max: 200 },
      { label: 'Saldo atual', points: Math.min(300, Math.round((account.balance_cents / 5_000_000) * 300)), max: 300 },
      { label: 'Movimentação em 90 dias', points: Math.min(250, activity.count * 10), max: 250 },
      { label: 'Volume movimentado', points: Math.min(150, Math.round((activity.volume / 50_000_000) * 150)), max: 150 },
      { label: 'Sem bloqueios', points: account.status === 'ACTIVE' ? 100 : 0, max: 100 },
    ];
    const score = Math.max(0, Math.min(1000, factors.reduce((total, factor) => total + factor.points, 0)));
    const band =
      score >= 850 ? 'MUITO_BAIXO' : score >= 700 ? 'BAIXO' : score >= 500 ? 'MEDIO' : score >= 300 ? 'ALTO' : 'MUITO_ALTO';
    const suggested = Math.min(
      account.daily_limit_cents,
      Math.max(0, Math.round((account.balance_cents * 0.5 + activity.volume * 0.05) / 100) * 100),
    );
    return {
      score,
      band,
      suggestedLimitCents: suggested,
      suggestedLimitFormatted: formatBRL(suggested),
      factors,
      computedAt: nowIso(now),
      disclaimer: 'Score interno do xPartner Bank (não é consulta a bureau de crédito).',
    };
  }

  systemOverview(): {
    users: number;
    activeUsers: number;
    pendingUsers: number;
    blockedUsers: number;
    totalBalanceCents: number;
    totalBalanceFormatted: string;
    treasuryBalanceCents: number;
    treasuryBalanceFormatted: string;
    transfers24h: number;
    volume24hCents: number;
    volume24hFormatted: string;
    ledger: ReturnType<typeof ledgerTrialBalance>;
  } {
    const since = nowIso(Date.now() - 86_400_000);
    const users = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'ACTIVE' AND role <> 'SYSTEM' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked
         FROM bank_users WHERE role <> 'SYSTEM'`,
      )
      .get() as { total: number; active: number | null; pending: number | null; blocked: number | null };
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN u.role <> 'SYSTEM' THEN a.balance_cents ELSE 0 END), 0) AS customer,
                COALESCE(SUM(CASE WHEN u.id = ? THEN a.balance_cents ELSE 0 END), 0) AS treasury
           FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
          WHERE a.status <> 'CLOSED'`,
      )
      .get(TREASURY_USER_ID) as { customer: number; treasury: number };
    const flow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volume
           FROM bank_transfers WHERE status = 'POSTED' AND created_at >= ?`,
      )
      .get(since) as { count: number; volume: number };
    return {
      users: users.total,
      activeUsers: users.active ?? 0,
      pendingUsers: users.pending ?? 0,
      blockedUsers: users.blocked ?? 0,
      totalBalanceCents: totals.customer,
      totalBalanceFormatted: formatBRL(totals.customer),
      treasuryBalanceCents: totals.treasury,
      treasuryBalanceFormatted: formatBRL(totals.treasury),
      transfers24h: flow.count,
      volume24hCents: flow.volume,
      volume24hFormatted: formatBRL(flow.volume),
      ledger: ledgerTrialBalance(this.db),
    };
  }
}

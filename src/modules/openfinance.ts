import type { Db } from '../kernel/db.ts';
import { addDays, audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId, numeric } from '../kernel/ids.ts';
import { assertPositiveCents, formatBRL } from '../kernel/money.ts';
import { postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';
import { assertDocument, maskDocument, normalizeName } from '../domain/documents.ts';
import { insertPendingPixTransaction } from './billing.ts';
import type { BillingService } from './billing.ts';
import type { CustomerService } from './customers.ts';
import { settleReceivable } from './receivable-settlement.ts';

export type ConsentKind = 'DATA_SHARING' | 'EXTERNAL_DEBIT' | 'PAYMENT_INITIATION';
export type ConsentStatus = 'AWAITING_AUTHORISATION' | 'AUTHORISED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';

const CONSENT_KINDS: readonly ConsentKind[] = ['DATA_SHARING', 'EXTERNAL_DEBIT', 'PAYMENT_INITIATION'];
const DEFAULT_SCOPES: Record<ConsentKind, string[]> = {
  DATA_SHARING: ['accounts:read', 'balances:read', 'transactions:read'],
  EXTERNAL_DEBIT: ['accounts:read', 'payments:debit'],
  PAYMENT_INITIATION: ['accounts:read', 'payments:initiate'],
};
const PAYMENT_FEE_BPS = 50;

interface MerchantRow {
  id: string;
  status: string;
}

export interface AccountRow {
  id: string;
  merchant_id: string;
  consent_id: string | null;
  provider: string;
  provider_code: string;
  account_type: 'CHECKING' | 'SAVINGS' | 'PAYMENT';
  branch: string;
  account_number_masked: string;
  holder_name: string;
  holder_document: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  balance_cents: number;
  currency: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsentRow {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  account_id: string | null;
  provider: string;
  provider_code: string;
  kind: ConsentKind;
  scopes: string;
  status: ConsentStatus;
  expires_at: string;
  authorised_at: string | null;
  revoked_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DebitRow {
  id: string;
  merchant_id: string;
  consent_id: string;
  account_id: string;
  amount_cents: number;
  description: string | null;
  due_date: string;
  status: 'SCHEDULED' | 'SETTLED' | 'FAILED' | 'CANCELED';
  transaction_id: string | null;
  settled_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface PaymentRow {
  id: string;
  merchant_id: string;
  consent_id: string;
  account_id: string;
  amount_cents: number;
  fee_cents: number;
  pix_key: string;
  description: string | null;
  status: 'PENDING' | 'SETTLED' | 'FAILED' | 'CANCELED';
  end_to_end_id: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface CreateConsentInput {
  merchantId: string;
  customerId?: string;
  provider: string;
  providerCode: string;
  kind: ConsentKind;
  scopes?: string[];
  account: {
    type: 'CHECKING' | 'SAVINGS' | 'PAYMENT';
    branch: string;
    number: string;
    holderName?: string;
    holderDocument?: string;
    balanceCents?: number;
  };
  expiresInDays?: number;
  now?: number;
}

export interface CreateDebitInput {
  merchantId: string;
  consentId: string;
  amountCents: number;
  description?: string;
  dueDate?: string;
  now?: number;
}

export interface CreatePaymentInput {
  merchantId: string;
  consentId: string;
  amountCents: number;
  pixKey: string;
  description?: string;
  now?: number;
}

function accountMask(branch: string, number: string): string {
  const cleanBranch = branch.replace(/\D/g, '');
  const cleanNumber = number.replace(/\D/g, '');
  const tail = cleanNumber.slice(-4).padStart(4, '0');
  return `${cleanBranch || '0001'}/${'*'.repeat(Math.max(0, cleanNumber.length - 4))}${tail}`;
}

function isoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DATE', `${field} deve estar no formato YYYY-MM-DD.`, 422);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError('INVALID_DATE', `${field} inválida.`, 422);
  }
  return value;
}

function todayIso(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function monthStartIso(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function publicAccount(row: AccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    providerCode: row.provider_code,
    accountType: row.account_type,
    branch: row.branch,
    numberMasked: row.account_number_masked,
    holderName: row.holder_name,
    holderDocumentMasked: maskDocument(row.holder_document),
    status: row.status,
    balanceCents: row.balance_cents,
    balanceFormatted: formatBRL(row.balance_cents),
    currency: row.currency,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

export function publicConsent(row: ConsentRow, account?: AccountRow | null) {
  return {
    id: row.id,
    customerId: row.customer_id,
    provider: row.provider,
    providerCode: row.provider_code,
    kind: row.kind,
    scopes: parseScopes(row.scopes),
    status: row.status,
    expiresAt: row.expires_at,
    authorisedAt: row.authorised_at,
    revokedAt: row.revoked_at,
    rejectionReason: row.rejection_reason,
    account: account ? publicAccount(account) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicDebit(row: DebitRow, account?: AccountRow | null) {
  return {
    id: row.id,
    consentId: row.consent_id,
    accountId: row.account_id,
    provider: account?.provider ?? null,
    providerCode: account?.provider_code ?? null,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    description: row.description,
    dueDate: row.due_date,
    status: row.status,
    transactionId: row.transaction_id,
    settledAt: row.settled_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export function publicPayment(row: PaymentRow, account?: AccountRow | null) {
  const totalCents = row.amount_cents + row.fee_cents;
  return {
    id: row.id,
    consentId: row.consent_id,
    accountId: row.account_id,
    provider: account?.provider ?? null,
    providerCode: account?.provider_code ?? null,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    feeCents: row.fee_cents,
    feeFormatted: formatBRL(row.fee_cents),
    totalCents,
    totalFormatted: formatBRL(totalCents),
    pixKey: row.pix_key,
    description: row.description,
    status: row.status,
    endToEndId: row.end_to_end_id,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
}

export class OpenFinanceService {
  private readonly db: Db;
  private readonly billing: BillingService;
  private readonly customers: CustomerService;

  constructor(db: Db, billing: BillingService, customers: CustomerService) {
    this.db = db;
    this.billing = billing;
    this.customers = customers;
  }

  private merchant(merchantId: string): MerchantRow {
    const merchant = this.db.prepare('SELECT id, status FROM merchants WHERE id = ?').get(merchantId) as
      | MerchantRow
      | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);
    return merchant;
  }

  private availableCents(merchantId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS balance
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ? AND a.kind = 'MERCHANT_AVAILABLE'`,
      )
      .get(merchantId) as { balance: number };
    return row.balance;
  }

  private accountOf(accountId: string | null): AccountRow | null {
    if (!accountId) return null;
    return (this.db.prepare('SELECT * FROM of_accounts WHERE id = ?').get(accountId) as AccountRow | undefined) ?? null;
  }

  private consentRow(merchantId: string, consentId: string): ConsentRow {
    const row = this.db.prepare('SELECT * FROM of_consents WHERE id = ?').get(consentId) as ConsentRow | undefined;
    if (!row) throw Errors.notFound('Consentimento não encontrado.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Consentimento não pertence ao estabelecimento.');
    return row;
  }

  private ensureConsentActive(row: ConsentRow, kind: ConsentKind, now: number): AccountRow {
    if (row.kind !== kind) {
      throw new AppError('CONSENT_SCOPE_MISMATCH', 'Consentimento não cobre esta operação.', 409, {
        required: kind,
        actual: row.kind,
      });
    }
    if (row.status === 'EXPIRED' || Date.parse(row.expires_at) <= now) {
      this.expire(now);
      throw new AppError('CONSENT_EXPIRED', 'Consentimento expirado.', 409);
    }
    if (row.status !== 'AUTHORISED') {
      throw new AppError('CONSENT_NOT_AUTHORISED', 'Consentimento não autorizado.', 409, { status: row.status });
    }
    const account = this.accountOf(row.account_id);
    if (!account || account.status !== 'ACTIVE') {
      throw new AppError('CONSENT_ACCOUNT_UNAVAILABLE', 'Conta vinculada indisponível.', 409);
    }
    return account;
  }

  createConsent(input: CreateConsentInput) {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    this.merchant(input.merchantId);
    const kind = input.kind;
    if (!CONSENT_KINDS.includes(kind)) throw new AppError('INVALID_CONSENT_KIND', 'Tipo de consentimento inválido.', 422);

    const provider = normalizeName(input.provider, 60);
    const providerCode = String(input.providerCode ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,30}$/.test(providerCode)) {
      throw new AppError('INVALID_PROVIDER', 'Código da instituição inválido.', 422);
    }
    const customer = input.customerId ? this.customers.ensureCustomer(input.merchantId, input.customerId) : null;
    const holderName = normalizeName(input.account.holderName?.trim() || customer?.name || '');
    const holder = assertDocument(input.account.holderDocument?.trim() || customer?.document || '', 'documento do titular');
    const branch = String(input.account.branch ?? '').replace(/\D/g, '');
    const number = String(input.account.number ?? '').replace(/\D/g, '');
    if (branch.length < 1 || branch.length > 6) throw new AppError('INVALID_BRANCH', 'Agência inválida.', 422);
    if (number.length < 4 || number.length > 20) throw new AppError('INVALID_ACCOUNT', 'Conta inválida.', 422);
    if (!['CHECKING', 'SAVINGS', 'PAYMENT'].includes(input.account.type)) {
      throw new AppError('INVALID_ACCOUNT_TYPE', 'Tipo de conta inválido.', 422);
    }
    const balanceCents = input.account.balanceCents ?? 0;
    if (!Number.isInteger(balanceCents) || balanceCents < 0) {
      throw new AppError('INVALID_BALANCE', 'Saldo informado inválido.', 422);
    }
    const scopes = input.scopes?.length ? input.scopes.map((scope) => String(scope).slice(0, 40)) : DEFAULT_SCOPES[kind];
    const expiresInDays = Math.min(365, Math.max(1, input.expiresInDays ?? 90));

    const accountId = newId('ofa', now);
    const consentId = newId('ofc', now);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO of_accounts
             (id, merchant_id, consent_id, provider, provider_code, account_type, branch,
              account_number_masked, holder_name, holder_document, status, balance_cents, currency,
              last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 'BRL', NULL, ?, ?)`,
        )
        .run(
          accountId,
          input.merchantId,
          consentId,
          provider,
          providerCode,
          input.account.type,
          branch,
          accountMask(branch, number),
          holderName,
          holder.document,
          balanceCents,
          createdAt,
          createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO of_consents
             (id, merchant_id, customer_id, account_id, provider, provider_code, kind, scopes, status,
              expires_at, authorised_at, revoked_at, rejection_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_AUTHORISATION', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          consentId,
          input.merchantId,
          customer?.id ?? null,
          accountId,
          provider,
          providerCode,
          kind,
          JSON.stringify(scopes),
          addDays(createdAt, expiresInDays),
          createdAt,
          createdAt,
        );
      audit(this.db, 'open-finance', 'CONSENT_CREATED', consentId, {
        providerCode,
        kind,
        scopes,
        expiresInDays,
      });
    });

    const consent = this.consentRow(input.merchantId, consentId);
    return publicConsent(consent, this.accountOf(accountId));
  }

  authorize(merchantId: string, consentId: string, options: { now?: number; balanceCents?: number } = {}) {
    const now = options.now ?? Date.now();
    const row = this.consentRow(merchantId, consentId);
    if (row.status === 'AUTHORISED') return publicConsent(row, this.accountOf(row.account_id));
    if (row.status === 'EXPIRED' || Date.parse(row.expires_at) <= now) {
      this.expire(now);
      throw new AppError('CONSENT_EXPIRED', 'Consentimento expirado.', 409);
    }
    if (row.status !== 'AWAITING_AUTHORISATION') {
      throw new AppError('CONSENT_NOT_PENDING', 'Consentimento não está aguardando autorização.', 409, {
        status: row.status,
      });
    }
    const timestamp = nowIso(now);
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE of_consents SET status = 'AUTHORISED', authorised_at = ?, updated_at = ?
            WHERE id = ? AND status = 'AWAITING_AUTHORISATION'`,
        )
        .run(timestamp, timestamp, consentId);
      this.db
        .prepare(
          `UPDATE of_accounts
              SET status = 'ACTIVE', last_synced_at = ?,
                  balance_cents = COALESCE(?, balance_cents), updated_at = ?
            WHERE id = ?`,
        )
        .run(timestamp, options.balanceCents ?? null, timestamp, row.account_id);
      audit(this.db, 'open-finance', 'CONSENT_AUTHORISED', consentId, {
        providerCode: row.provider_code,
        kind: row.kind,
      });
    });
    const updated = this.consentRow(merchantId, consentId);
    return publicConsent(updated, this.accountOf(updated.account_id));
  }

  reject(merchantId: string, consentId: string, reason?: string, now = Date.now()) {
    const row = this.consentRow(merchantId, consentId);
    if (row.status === 'REJECTED') return publicConsent(row, this.accountOf(row.account_id));
    if (row.status !== 'AWAITING_AUTHORISATION') {
      throw new AppError('CONSENT_NOT_PENDING', 'Consentimento não está aguardando autorização.', 409);
    }
    const timestamp = nowIso(now);
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE of_consents SET status = 'REJECTED', rejection_reason = ?, revoked_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(String(reason ?? 'Recusado pelo titular').slice(0, 160), timestamp, timestamp, consentId);
      this.db.prepare("UPDATE of_accounts SET status = 'REVOKED', updated_at = ? WHERE id = ?").run(timestamp, row.account_id);
      audit(this.db, 'open-finance', 'CONSENT_REJECTED', consentId, { reason: reason ?? null });
    });
    return publicConsent(this.consentRow(merchantId, consentId), this.accountOf(row.account_id));
  }

  revoke(merchantId: string, consentId: string, reason?: string, now = Date.now()) {
    const row = this.consentRow(merchantId, consentId);
    if (row.status === 'REVOKED') return publicConsent(row, this.accountOf(row.account_id));
    const timestamp = nowIso(now);
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE of_consents SET status = 'REVOKED', revoked_at = ?, rejection_reason = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(timestamp, String(reason ?? 'Revogado pelo titular').slice(0, 160), timestamp, consentId);
      this.db.prepare("UPDATE of_accounts SET status = 'REVOKED', updated_at = ? WHERE id = ?").run(timestamp, row.account_id);
      this.db
        .prepare(
          `UPDATE of_external_debits SET status = 'CANCELED', failure_reason = 'Consentimento revogado', updated_at = ?
            WHERE consent_id = ? AND status = 'SCHEDULED'`,
        )
        .run(timestamp, consentId);
      this.db
        .prepare(
          `UPDATE of_payments SET status = 'CANCELED', settled_at = NULL
            WHERE consent_id = ? AND status = 'PENDING'`,
        )
        .run(consentId);
      audit(this.db, 'open-finance', 'CONSENT_REVOKED', consentId, { reason: reason ?? null });
    });
    return publicConsent(this.consentRow(merchantId, consentId), this.accountOf(row.account_id));
  }

  /** Expira consentimentos vencidos. Chamado de forma preguiçosa antes de listar/operar. */
  expire(now: number = Date.now()): number {
    const timestamp = nowIso(now);
    const result = this.db
      .prepare(
        `UPDATE of_consents SET status = 'EXPIRED', updated_at = ?
          WHERE status IN ('AWAITING_AUTHORISATION', 'AUTHORISED') AND expires_at <= ?`,
      )
      .run(timestamp, timestamp);
    this.db
      .prepare(
        `UPDATE of_accounts SET status = 'REVOKED', updated_at = ?
          WHERE id IN (SELECT account_id FROM of_consents WHERE status = 'EXPIRED' AND account_id IS NOT NULL)`,
      )
      .run(timestamp);
    return Number(result.changes);
  }

  createDebit(input: CreateDebitInput) {
    const now = input.now ?? Date.now();
    this.merchant(input.merchantId);
    const consent = this.consentRow(input.merchantId, input.consentId);
    const account = this.ensureConsentActive(consent, 'EXTERNAL_DEBIT', now);
    const amountCents = assertPositiveCents(input.amountCents, 'valor do débito');
    const dueDate = isoDate(input.dueDate ?? todayIso(now), 'Vencimento');
    const description = (input.description?.trim() || `Débito externo · ${consent.provider}`).slice(0, 120);
    const id = newId('ofd', now);
    const createdAt = nowIso(now);
    this.db
      .prepare(
        `INSERT INTO of_external_debits
           (id, merchant_id, consent_id, account_id, amount_cents, description, due_date, status,
            transaction_id, settled_at, failure_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, input.merchantId, consent.id, account.id, amountCents, description, dueDate, createdAt, createdAt);
    audit(this.db, 'open-finance', 'EXTERNAL_DEBIT_CREATED', id, {
      consentId: consent.id,
      amountCents,
      dueDate,
    });
    return publicDebit(this.db.prepare('SELECT * FROM of_external_debits WHERE id = ?').get(id) as unknown as DebitRow, account);
  }

  settleDebit(merchantId: string, debitId: string, now = Date.now()) {
    this.merchant(merchantId);
    const row = this.db.prepare('SELECT * FROM of_external_debits WHERE id = ?').get(debitId) as DebitRow | undefined;
    if (!row) throw Errors.notFound('Débito externo não encontrado.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Débito não pertence ao estabelecimento.');
    if (row.status === 'SETTLED') {
      return publicDebit(row, this.accountOf(row.account_id));
    }
    if (row.status !== 'SCHEDULED') {
      throw new AppError('DEBIT_CLOSED', 'Débito não está agendado.', 409, { status: row.status });
    }
    const consent = this.consentRow(merchantId, row.consent_id);
    const account = this.ensureConsentActive(consent, 'EXTERNAL_DEBIT', now);
    const terminalId = this.billing.resolveTerminal(merchantId);
    const paidAt = nowIso(now);

    const transactionId = tx(this.db, () => {
      const txnId = insertPendingPixTransaction(this.db, {
        merchantId,
        terminalId,
        amountCents: row.amount_cents,
        description: `Débito Open Finance · ${consent.provider} · ${row.description ?? account.account_number_masked}`,
        source: 'OPEN_FINANCE',
        now,
      });
      settleReceivable(this.db, txnId, {
        paidAt,
        nsu: `OF${numeric(10)}`,
        channel: 'OPEN_FINANCE',
        settlementAt: paidAt,
      });
      this.db
        .prepare(
          `UPDATE of_external_debits
              SET status = 'SETTLED', transaction_id = ?, settled_at = ?, updated_at = ?
            WHERE id = ? AND status = 'SCHEDULED'`,
        )
        .run(txnId, paidAt, paidAt, debitId);
      this.db
        .prepare('UPDATE of_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?')
        .run(paidAt, paidAt, account.id);
      audit(this.db, 'open-finance', 'EXTERNAL_DEBIT_SETTLED', debitId, {
        transactionId: txnId,
        amountCents: row.amount_cents,
      });
      return txnId;
    });

    const updated = this.db.prepare('SELECT * FROM of_external_debits WHERE id = ?').get(debitId) as unknown as DebitRow;
    return { ...publicDebit(updated, account), transactionId };
  }

  cancelDebit(merchantId: string, debitId: string, now = Date.now()) {
    this.merchant(merchantId);
    const row = this.db.prepare('SELECT * FROM of_external_debits WHERE id = ?').get(debitId) as DebitRow | undefined;
    if (!row) throw Errors.notFound('Débito externo não encontrado.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Débito não pertence ao estabelecimento.');
    if (row.status === 'SETTLED') throw new AppError('DEBIT_SETTLED', 'Débito já liquidado.', 409);
    if (row.status === 'CANCELED') return publicDebit(row, this.accountOf(row.account_id));
    const timestamp = nowIso(now);
    this.db
      .prepare("UPDATE of_external_debits SET status = 'CANCELED', updated_at = ? WHERE id = ?")
      .run(timestamp, debitId);
    audit(this.db, 'open-finance', 'EXTERNAL_DEBIT_CANCELED', debitId, {});
    return publicDebit(this.db.prepare('SELECT * FROM of_external_debits WHERE id = ?').get(debitId) as unknown as DebitRow);
  }

  createPayment(input: CreatePaymentInput) {
    const now = input.now ?? Date.now();
    this.merchant(input.merchantId);
    const consent = this.consentRow(input.merchantId, input.consentId);
    const account = this.ensureConsentActive(consent, 'PAYMENT_INITIATION', now);
    const amountCents = assertPositiveCents(input.amountCents, 'valor do pagamento');
    const pixKey = String(input.pixKey ?? '').trim();
    if (pixKey.length < 5 || pixKey.length > 120) throw new AppError('INVALID_PIX_KEY', 'Chave Pix inválida.', 422);
    const feeCents = Math.round((amountCents * PAYMENT_FEE_BPS) / 10_000);
    const description = (input.description?.trim() || `Pagamento Pix · ${consent.provider}`).slice(0, 120);
    const id = newId('ofp', now);
    const createdAt = nowIso(now);
    this.db
      .prepare(
        `INSERT INTO of_payments
           (id, merchant_id, consent_id, account_id, amount_cents, fee_cents, pix_key, description,
            status, end_to_end_id, settled_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?)`,
      )
      .run(id, input.merchantId, consent.id, account.id, amountCents, feeCents, pixKey, description, createdAt);
    audit(this.db, 'open-finance', 'PAYMENT_CREATED', id, { consentId: consent.id, amountCents, feeCents });
    return publicPayment(this.db.prepare('SELECT * FROM of_payments WHERE id = ?').get(id) as unknown as PaymentRow, account);
  }

  settlePayment(merchantId: string, paymentId: string, now = Date.now()) {
    this.merchant(merchantId);
    const row = this.db.prepare('SELECT * FROM of_payments WHERE id = ?').get(paymentId) as PaymentRow | undefined;
    if (!row) throw Errors.notFound('Pagamento não encontrado.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Pagamento não pertence ao estabelecimento.');
    if (row.status === 'SETTLED') return publicPayment(row, this.accountOf(row.account_id));
    if (row.status !== 'PENDING') {
      throw new AppError('PAYMENT_CLOSED', 'Pagamento não está pendente.', 409, { status: row.status });
    }
    const consent = this.consentRow(merchantId, row.consent_id);
    if (consent.kind !== 'PAYMENT_INITIATION') {
      throw new AppError('CONSENT_SCOPE_MISMATCH', 'Consentimento não cobre iniciação de pagamento.', 409);
    }
    this.ensureConsentActive(consent, 'PAYMENT_INITIATION', now);
    const total = row.amount_cents + row.fee_cents;
    if (this.availableCents(merchantId) < total) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo disponível insuficiente para o pagamento.', 422, {
        requiredCents: total,
        availableCents: this.availableCents(merchantId),
      });
    }
    const paidAt = nowIso(now);
    const endToEndId = `E${numeric(8)}${new Date(now).getTime()}`;
    tx(this.db, () => {
      const entries: EntryInput[] = [
        {
          kind: 'MERCHANT_AVAILABLE',
          ownerType: 'MERCHANT',
          ownerId: merchantId,
          direction: 'DEBIT',
          amountCents: row.amount_cents,
          memo: `Pagamento Open Finance · ${row.description ?? row.pix_key}`,
        },
        {
          kind: 'OPEN_FINANCE_CLEARING',
          direction: 'CREDIT',
          amountCents: row.amount_cents,
          memo: `Liquidação Open Finance ${endToEndId}`,
        },
      ];
      if (row.fee_cents > 0) {
        entries.push(
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: merchantId,
            direction: 'DEBIT',
            amountCents: row.fee_cents,
            memo: 'Tarifa de iniciação de pagamento',
          },
          {
            kind: 'FEE_REVENUE',
            direction: 'CREDIT',
            amountCents: row.fee_cents,
            memo: 'Tarifa de iniciação de pagamento',
          },
        );
      }
      postGroup(this.db, {
        groupId: `ofpay_${row.id}`,
        groupKind: 'OF_PAYMENT',
        createdAt: paidAt,
        entries,
      });
      this.db
        .prepare(
          `UPDATE of_payments SET status = 'SETTLED', end_to_end_id = ?, settled_at = ?
            WHERE id = ? AND status = 'PENDING'`,
        )
        .run(endToEndId, paidAt, paymentId);
      audit(this.db, 'open-finance', 'PAYMENT_SETTLED', paymentId, {
        amountCents: row.amount_cents,
        feeCents: row.fee_cents,
        endToEndId,
      });
    });
    return publicPayment(this.db.prepare('SELECT * FROM of_payments WHERE id = ?').get(paymentId) as unknown as PaymentRow);
  }

  cancelPayment(merchantId: string, paymentId: string) {
    this.merchant(merchantId);
    const row = this.db.prepare('SELECT * FROM of_payments WHERE id = ?').get(paymentId) as PaymentRow | undefined;
    if (!row) throw Errors.notFound('Pagamento não encontrado.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Pagamento não pertence ao estabelecimento.');
    if (row.status === 'SETTLED') throw new AppError('PAYMENT_SETTLED', 'Pagamento já liquidado.', 409);
    if (row.status === 'CANCELED') return publicPayment(row, this.accountOf(row.account_id));
    this.db.prepare("UPDATE of_payments SET status = 'CANCELED' WHERE id = ?").run(paymentId);
    audit(this.db, 'open-finance', 'PAYMENT_CANCELED', paymentId, {});
    return publicPayment(this.db.prepare('SELECT * FROM of_payments WHERE id = ?').get(paymentId) as unknown as PaymentRow);
  }

  overview(merchantId: string, now: number = Date.now()) {
    this.merchant(merchantId);
    this.expire(now);
    const consents = this.db
      .prepare('SELECT * FROM of_consents WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(merchantId) as unknown as ConsentRow[];
    const accounts = this.db
      .prepare('SELECT * FROM of_accounts WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(merchantId) as unknown as AccountRow[];
    const debits = this.db
      .prepare('SELECT * FROM of_external_debits WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(merchantId) as unknown as DebitRow[];
    const payments = this.db
      .prepare('SELECT * FROM of_payments WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(merchantId) as unknown as PaymentRow[];

    const activeConsents = consents.filter((row) => row.status === 'AUTHORISED').length;
    const activeAccounts = accounts.filter((row) => row.status === 'ACTIVE').length;
    const scheduledDebits = debits
      .filter((row) => row.status === 'SCHEDULED')
      .reduce((total, row) => total + row.amount_cents, 0);
    const monthStart = monthStartIso(now);
    const monthDebits = debits
      .filter((row) => row.status === 'SETTLED' && row.settled_at !== null && row.settled_at >= monthStart)
      .reduce((total, row) => total + row.amount_cents, 0);
    const monthPayments = payments
      .filter((row) => row.status === 'SETTLED' && row.settled_at !== null && row.settled_at >= monthStart)
      .reduce((total, row) => total + row.amount_cents, 0);
    const monthFees = payments
      .filter((row) => row.status === 'SETTLED' && row.settled_at !== null && row.settled_at >= monthStart)
      .reduce((total, row) => total + row.fee_cents, 0);
    const accountById = new Map(accounts.map((row) => [row.id, row]));

    return {
      kpis: {
        activeConsents,
        activeAccounts,
        scheduledDebitsCents: scheduledDebits,
        scheduledDebitsFormatted: formatBRL(scheduledDebits),
        monthDebitsCents: monthDebits,
        monthDebitsFormatted: formatBRL(monthDebits),
        monthPaymentsCents: monthPayments,
        monthPaymentsFormatted: formatBRL(monthPayments),
        monthFeesCents: monthFees,
        monthFeesFormatted: formatBRL(monthFees),
      },
      consents: consents.map((row) => publicConsent(row, row.account_id ? accountById.get(row.account_id) ?? null : null)),
      accounts: accounts.map(publicAccount),
      debits: debits.map((row) => publicDebit(row, accountById.get(row.account_id) ?? null)),
      payments: payments.map((row) => publicPayment(row, accountById.get(row.account_id) ?? null)),
    };
  }
}

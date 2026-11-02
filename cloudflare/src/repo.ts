import type { AccountRow, AccountView, Env, PublicUser, RecipientRow, UserRow } from './types.ts';
import { HttpError } from './http.ts';
import { newId, nowIso } from './security.ts';
import { pixLookupCandidates } from './pix-keys.ts';
import {
  formatAccountNumber,
  formatBRL,
  formatDocument,
  maskDocument,
  maskEmail,
  maskedAccount,
  onlyDigits,
} from './validation.ts';

export function userView(user: UserRow, account: AccountRow | null, self = false): PublicUser {
  return {
    id: user.id,
    name: user.name,
    document: self ? formatDocument(user.document) : maskDocument(user.document),
    documentMasked: maskDocument(user.document),
    email: self ? user.email : maskEmail(user.email),
    phone: self ? user.phone : user.phone ? `(••) •••••-${user.phone.slice(-4)}` : null,
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    approvedAt: user.approved_at,
    approvedBy: user.approved_by,
    lastLoginAt: user.last_login_at,
    deletedAt: user.deleted_at,
    account: account ? accountView(account) : null,
  };
}

export function accountView(account: AccountRow): AccountView {
  const formattedNumber = `${account.branch} / ${account.number.slice(0, 7)}-${account.number.slice(-1)}`;
  return {
    id: account.id,
    branch: account.branch,
    number: account.number,
    numberFormatted: formattedNumber,
    formattedNumber,
    kind: account.kind,
    status: account.status,
    balanceCents: account.balance_cents,
    balanceFormatted: formatBRL(account.balance_cents),
    openingBalanceCents: account.opening_balance_cents,
    perTransferLimitCents: account.per_transfer_limit_cents,
    dailyLimitCents: account.daily_limit_cents,
    openedAt: account.created_at,
    createdAt: account.created_at,
  };
}

export async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM bank_users WHERE id = ?').bind(id).first<UserRow>();
}

export async function findUserByLogin(env: Env, identifier: string): Promise<UserRow | null> {
  const raw = String(identifier ?? '').trim();
  if (!raw) return null;
  const byEmail = await env.DB.prepare('SELECT * FROM bank_users WHERE lower(email) = ?')
    .bind(raw.toLowerCase())
    .first<UserRow>();
  if (byEmail) return byEmail;
  const document = onlyDigits(raw);
  if (document.length === 11 || document.length === 14) {
    return env.DB.prepare('SELECT * FROM bank_users WHERE document = ?').bind(document).first<UserRow>();
  }
  return null;
}

export async function accountByUser(env: Env, userId: string): Promise<AccountRow | null> {
  return env.DB.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').bind(userId).first<AccountRow>();
}

export async function accountById(env: Env, id: string): Promise<AccountRow | null> {
  return env.DB.prepare('SELECT * FROM bank_accounts WHERE id = ?').bind(id).first<AccountRow>();
}

export async function nextAccountNumber(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "UPDATE bank_sequences SET value = value + 1 WHERE name = 'account' RETURNING value",
  ).first<{ value: number }>();
  if (!row) throw new Error('Sequência de contas ausente na migração.');
  return formatAccountNumber(row.value);
}

export async function createAccount(env: Env, userId: string, now = nowIso()): Promise<AccountRow> {
  const existing = await accountByUser(env, userId);
  if (existing) return existing;
  const number = await nextAccountNumber(env);
  const id = newId('acc');
  await env.DB.prepare(
    `INSERT INTO bank_accounts
       (id, user_id, branch, number, kind, status, balance_cents, opening_balance_cents,
        per_transfer_limit_cents, daily_limit_cents, created_at, updated_at)
     VALUES (?, ?, '0001', ?, 'CHECKING', 'ACTIVE', 0, 0, 5000000, 10000000, ?, ?)`,
  )
    .bind(id, userId, number, now, now)
    .run();
  const account = await accountById(env, id);
  if (!account) throw new Error('Conta não encontrada após criação.');
  return account;
}

export async function resolveRecipient(
  env: Env,
  query: { accountNumber?: string; document?: string; email?: string; pixKey?: string },
): Promise<RecipientRow> {
  const columns = `u.id AS user_id, u.name, u.document, a.id AS account_id, a.branch, a.number`;
  const base = `SELECT ${columns}
                  FROM bank_users u
                  JOIN bank_accounts a ON a.user_id = u.id
                 WHERE u.status = 'ACTIVE' AND a.status = 'ACTIVE' AND `;
  let row: RecipientRow | null = null;
  if (query.pixKey) {
    for (const candidate of pixLookupCandidates(query.pixKey)) {
      row = await env.DB.prepare(
        `SELECT ${columns}, k.key_type AS pix_key_type, k.key_masked AS pix_key_masked
           FROM bank_pix_keys k
           JOIN bank_users u ON u.id = k.user_id
           JOIN bank_accounts a ON a.user_id = u.id
          WHERE k.key_type = ? AND k.key_value = ? AND k.status = 'ACTIVE'
            AND u.status = 'ACTIVE' AND a.status = 'ACTIVE'`,
      )
        .bind(candidate.type, candidate.value)
        .first<RecipientRow>();
      if (row) break;
    }
    if (!row) throw new HttpError(404, 'PIX_KEY_NOT_FOUND', 'Chave Pix não encontrada ou inativa no xPartner Bank.');
    return row;
  }
  if (query.accountNumber) {
    let digits = onlyDigits(query.accountNumber);
    if (digits.length > 8) digits = digits.slice(-8);
    if (digits.length !== 8) {
      throw new HttpError(422, 'INVALID_RECIPIENT', 'Conta de destino inválida: informe os 8 dígitos.');
    }
    row = await env.DB.prepare(`${base} a.number = ?`).bind(digits).first<RecipientRow>();
  } else if (query.document) {
    const document = onlyDigits(query.document);
    if (document.length !== 11 && document.length !== 14) {
      throw new HttpError(422, 'INVALID_RECIPIENT', 'CPF/CNPJ do favorecido inválido.');
    }
    row = await env.DB.prepare(`${base} u.document = ?`).bind(document).first<RecipientRow>();
  } else if (query.email) {
    const email = query.email.trim().toLowerCase();
    if (!email.includes('@')) throw new HttpError(422, 'INVALID_RECIPIENT', 'E-mail do favorecido inválido.');
    row = await env.DB.prepare(`${base} lower(u.email) = ?`).bind(email).first<RecipientRow>();
  } else {
    throw new HttpError(422, 'INVALID_RECIPIENT', 'Informe conta, CPF/CNPJ ou e-mail do favorecido.');
  }
  if (!row) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'Favorecido não encontrado ou sem conta ativa.');
  return row;
}

export function recipientView(recipient: RecipientRow): {
  id: string;
  name: string;
  documentMasked: string;
  account: string;
  numberMasked: string;
} {
  return {
    id: recipient.user_id,
    name: recipient.name,
    documentMasked: maskDocument(recipient.document),
    account: maskedAccount(recipient.branch, recipient.number),
    numberMasked: recipient.number,
  };
}

export async function audit(
  env: Env,
  input: { actorId: string | null; action: string; resource: string; resourceId?: string; details?: unknown },
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO bank_audit (id, actor_id, action, resource, resource_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      newId('aud'),
      input.actorId,
      input.action,
      input.resource,
      input.resourceId ?? null,
      input.details === undefined ? null : JSON.stringify(input.details),
      nowIso(),
    )
    .run();
}

export async function queueEvent(
  env: Env,
  input: { topic: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  try {
    await env.EVENTS.send({
      id: newId('evt'),
      topic: input.topic,
      type: input.type,
      payload: input.payload,
      occurredAt: nowIso(),
    });
  } catch (error) {
    console.error('queue.send_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function customerCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bank_users WHERE role IN ('USER', 'ADMIN') AND status <> 'DELETED'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function ledgerTrial(env: Env): Promise<{ debits: number; credits: number; balanced: boolean }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0) AS debits,
            COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0) AS credits
       FROM bank_ledger`,
  ).first<{ debits: number; credits: number }>();
  const debits = row?.debits ?? 0;
  const credits = row?.credits ?? 0;
  return { debits, credits, balanced: debits === credits };
}

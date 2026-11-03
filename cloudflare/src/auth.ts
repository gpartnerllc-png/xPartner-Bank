import type { AccountRow, AuthContext, Env, SessionRow, UserRow } from './types.ts';
import { HttpError, boolEnv, clientContext, intEnv } from './http.ts';
import {
  constantTimeStringEqual,
  generateTempPassword,
  hashPassword,
  nowIso,
  randomToken,
  rateLimit,
  readSessionToken,
  sha256Hex,
  validatePassword,
  verifyPassword,
} from './security.ts';
import {
  accountByUser,
  accountView,
  audit,
  createAccount,
  customerCount,
  findUserById,
  findUserByLogin,
  ledgerTrial,
  userView,
  queueEvent,
  resolveRecipient,
} from './repo.ts';
import { creditScore, fxSystemOverview, statement } from './bank.ts';
import { assertDocument, assertEmail, assertPhone, formatBRL, normalizeName } from './validation.ts';

export interface RegisterInput {
  name: string;
  document: string;
  email: string;
  phone?: string;
  password: string;
  bootstrapToken?: string;
}

export interface SessionView {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export function sessionTtl(env: Env): number {
  return intEnv(env.SESSION_TTL_SECONDS, 28_800, 900, 604_800);
}

export function demoMode(env: Env): boolean {
  return boolEnv(env.DEMO_MODE);
}

function sessionHash(env: Env, token: string): Promise<string> {
  return sha256Hex(`${token}:${env.SESSION_PEPPER ?? 'xpartner-edge'}`);
}

export async function createSession(
  env: Env,
  userId: string,
  meta: { ip: string; userAgent: string },
): Promise<SessionView> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const ttl = sessionTtl(env);
  const now = nowIso();
  const expiresAt = nowIso(ttl * 1000);
  await env.DB.prepare(
    `INSERT INTO bank_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(`ses_${crypto.randomUUID()}`, userId, await sessionHash(env, token), csrfToken, now, expiresAt, meta.ip, meta.userAgent)
    .run();
  return { token, csrfToken, expiresAt };
}

export async function revokeSessions(env: Env, userId: string, exceptTokenHash?: string): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE bank_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
  )
    .bind(nowIso(), userId, exceptTokenHash ?? '')
    .run();
  return result.meta.changes ?? 0;
}

export async function authenticate(env: Env, request: Request): Promise<AuthContext | null> {
  const credentials = readSessionToken(request);
  if (!credentials) return null;
  const hash = await sessionHash(env, credentials.token);
  const session = await env.DB.prepare('SELECT * FROM bank_sessions WHERE token_hash = ?')
    .bind(hash)
    .first<SessionRow>();
  if (!session || session.revoked_at || session.expires_at <= nowIso()) return null;
  const user = await findUserById(env, session.user_id);
  if (!user || user.status === 'DELETED') return null;
  if (user.status === 'PENDING') {
    throw new HttpError(403, 'ACCOUNT_PENDING', 'Cadastro aguardando aprovação do administrador.');
  }
  if (user.status === 'BLOCKED') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta bloqueada. Procure o administrador.');
  }
  if (credentials.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrf = request.headers.get('x-bank-csrf') ?? '';
    if (!constantTimeStringEqual(csrf, session.csrf_token)) {
      throw new HttpError(403, 'CSRF_INVALID', 'Token CSRF ausente ou inválido.');
    }
  }
  const account = await accountByUser(env, user.id);
  return { user, account, session, token: credentials.token, viaCookie: credentials.viaCookie };
}

export async function register(
  env: Env,
  input: RegisterInput,
  request: Request,
): Promise<{
  user: ReturnType<typeof userView>;
  account: ReturnType<typeof accountView> | null;
  requiresApproval: boolean;
  bootstrapAdmin: boolean;
  session: SessionView | null;
}> {
  const meta = clientContext(request);
  await rateLimit(env, `register:${meta.ip}`, 5, 60);

  const name = normalizeName(input.name);
  const { document } = assertDocument(input.document);
  const email = assertEmail(input.email);
  const phone = assertPhone(input.phone);
  validatePassword(input.password, { name, document, email });

  const duplicate = await env.DB.prepare(
    "SELECT id FROM bank_users WHERE (document = ? OR lower(email) = ?) AND status <> 'DELETED'",
  )
    .bind(document, email)
    .first<{ id: string }>();
  if (duplicate) {
    throw new HttpError(409, 'ACCOUNT_EXISTS', 'Já existe cadastro com este CPF/CNPJ ou e-mail.');
  }

  const isFirst = (await customerCount(env)) === 0;
  const bootstrapAllowed =
    isFirst &&
    (demoMode(env) ||
      Boolean(
        env.BOOTSTRAP_TOKEN &&
          input.bootstrapToken &&
          constantTimeStringEqual(input.bootstrapToken, env.BOOTSTRAP_TOKEN),
      ));
  if (isFirst && !bootstrapAllowed) {
    throw new HttpError(
      403,
      'BOOTSTRAP_REQUIRED',
      'Primeiro administrador exige o token de bootstrap configurado no servidor.',
    );
  }
  if (input.bootstrapToken && !bootstrapAllowed && !isFirst) {
    throw new HttpError(403, 'BOOTSTRAP_CLOSED', 'Bootstrap disponível apenas para o primeiro administrador.');
  }

  const active = isFirst && bootstrapAllowed;
  const role = active ? 'ADMIN' : 'USER';
  const status = active ? 'ACTIVE' : 'PENDING';
  const now = nowIso();
  const userId = `usr_${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(input.password);

  await env.DB.prepare(
    `INSERT INTO bank_users
       (id, name, document, email, phone, password_hash, role, status, must_change_password, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(userId, name, document, email, phone, passwordHash, role, status, now, now, active ? now : null)
    .run();

  let account: AccountRow | null = null;
  let session: SessionView | null = null;
  if (active) {
    account = await createAccount(env, userId, now);
    session = await createSession(env, userId, meta);
  }

  await audit(env, {
    actorId: userId,
    action: 'bank.user.registered',
    resource: 'bank_user',
    resourceId: userId,
    details: { role, status, firstAdmin: isFirst },
  });
  await queueEvent(env, {
    topic: 'bank.user',
    type: 'bank.user.registered',
    payload: { userId, role, status },
  });

  return {
    user: userView((await findUserById(env, userId)) as UserRow, account, true),
    account: account ? accountView(account) : null,
    requiresApproval: status === 'PENDING',
    bootstrapAdmin: active,
    session,
  };
}

export async function login(
  env: Env,
  input: { identifier: string; password: string },
  request: Request,
): Promise<{
  user: ReturnType<typeof userView>;
  account: ReturnType<typeof accountView> | null;
  session: SessionView;
}> {
  const meta = clientContext(request);
  await rateLimit(env, `login:${meta.ip}`, 20, 60);

  const user = await findUserByLogin(env, input.identifier);
  if (!user || user.status === 'DELETED') {
    throw new HttpError(401, 'AUTH_INVALID', 'Credenciais inválidas.');
  }
  if (user.locked_until && user.locked_until > nowIso()) {
    throw new HttpError(423, 'ACCOUNT_LOCKED', 'Conta temporariamente bloqueada por tentativas inválidas.', {
      lockedUntil: user.locked_until,
    });
  }
  if (user.status === 'PENDING') {
    throw new HttpError(403, 'ACCOUNT_PENDING', 'Cadastro aguardando aprovação do administrador.');
  }
  if (user.status === 'BLOCKED') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta bloqueada. Procure o administrador.');
  }

  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) {
    const attempts = user.failed_attempts + 1;
    const lockedUntil = attempts >= 5 ? nowIso(15 * 60_000) : null;
    await env.DB.prepare('UPDATE bank_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .bind(attempts, lockedUntil, nowIso(), user.id)
      .run();
    await audit(env, {
      actorId: user.id,
      action: 'bank.login.failed',
      resource: 'bank_user',
      resourceId: user.id,
      details: { attempts, locked: Boolean(lockedUntil) },
    });
    if (lockedUntil) {
      throw new HttpError(423, 'ACCOUNT_LOCKED', 'Muitas tentativas inválidas. Conta bloqueada por 15 minutos.', {
        lockedUntil,
      });
    }
    throw new HttpError(401, 'AUTH_INVALID', 'Credenciais inválidas.');
  }

  const now = nowIso();
  await env.DB.prepare(
    'UPDATE bank_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
  )
    .bind(now, now, user.id)
    .run();
  const session = await createSession(env, user.id, meta);
  const account = await accountByUser(env, user.id);
  const updated = (await findUserById(env, user.id)) as UserRow;

  await audit(env, {
    actorId: user.id,
    action: 'bank.login',
    resource: 'bank_user',
    resourceId: user.id,
    details: { ip: meta.ip },
  });

  return {
    user: userView(updated, account, true),
    account: account ? accountView(account) : null,
    session,
  };
}

export async function logout(env: Env, context: AuthContext): Promise<void> {
  await env.DB.prepare('UPDATE bank_sessions SET revoked_at = ? WHERE id = ?')
    .bind(nowIso(), context.session.id)
    .run();
  await audit(env, {
    actorId: context.user.id,
    action: 'bank.logout',
    resource: 'bank_session',
    resourceId: context.session.id,
  });
}

export async function changePassword(
  env: Env,
  context: AuthContext,
  input: { currentPassword: string; newPassword: string },
): Promise<{ revokedSessions: number }> {
  const valid = await verifyPassword(input.currentPassword, context.user.password_hash);
  if (!valid) throw new HttpError(401, 'AUTH_INVALID', 'Senha atual incorreta.');
  validatePassword(input.newPassword, {
    name: context.user.name,
    document: context.user.document,
    email: context.user.email,
  });
  const hash = await hashPassword(input.newPassword);
  await env.DB.prepare(
    'UPDATE bank_users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(hash, nowIso(), context.user.id)
    .run();
  const revoked = await revokeSessions(env, context.user.id, context.session.token_hash);
  await audit(env, {
    actorId: context.user.id,
    action: 'bank.password.changed',
    resource: 'bank_user',
    resourceId: context.user.id,
    details: { revokedSessions: revoked },
  });
  return { revokedSessions: revoked };
}

// ── Administração ────────────────────────────────────────────────────

interface JoinedUserRow extends UserRow {
  a_id: string | null;
  a_branch: string | null;
  a_number: string | null;
  a_kind: 'CHECKING' | 'SYSTEM' | null;
  a_status: 'ACTIVE' | 'BLOCKED' | 'CLOSED' | null;
  a_balance_cents: number | null;
  a_opening_balance_cents: number | null;
  a_per_transfer_limit_cents: number | null;
  a_daily_limit_cents: number | null;
  a_created_at: string | null;
  a_updated_at: string | null;
}

const JOINED_USER_SELECT = `SELECT u.*,
       a.id AS a_id, a.branch AS a_branch, a.number AS a_number, a.kind AS a_kind,
       a.status AS a_status, a.balance_cents AS a_balance_cents,
       a.opening_balance_cents AS a_opening_balance_cents,
       a.per_transfer_limit_cents AS a_per_transfer_limit_cents,
       a.daily_limit_cents AS a_daily_limit_cents,
       a.created_at AS a_created_at, a.updated_at AS a_updated_at
  FROM bank_users u LEFT JOIN bank_accounts a ON a.user_id = u.id`;

function joinedAccount(row: JoinedUserRow): AccountRow | null {
  if (!row.a_id) return null;
  return {
    id: row.a_id,
    user_id: row.id,
    branch: row.a_branch ?? '0001',
    number: row.a_number ?? '00000000',
    kind: row.a_kind ?? 'CHECKING',
    status: row.a_status ?? 'ACTIVE',
    balance_cents: row.a_balance_cents ?? 0,
    opening_balance_cents: row.a_opening_balance_cents ?? 0,
    per_transfer_limit_cents: row.a_per_transfer_limit_cents ?? 0,
    daily_limit_cents: row.a_daily_limit_cents ?? 0,
    created_at: row.a_created_at ?? '',
    updated_at: row.a_updated_at ?? '',
  };
}

export async function adminOverview(env: Env): Promise<Record<string, unknown>> {
  const users = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END), 0) AS blocked
       FROM bank_users WHERE role IN ('USER', 'ADMIN') AND status <> 'DELETED'`,
  ).first<{ total: number; active: number; pending: number; blocked: number }>();
  const balances = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN u.role <> 'SYSTEM' THEN a.balance_cents ELSE 0 END), 0) AS customers,
            COALESCE(SUM(CASE WHEN u.id = 'bank_user_system' THEN a.balance_cents ELSE 0 END), 0) AS treasury
       FROM bank_accounts a JOIN bank_users u ON u.id = a.user_id
      WHERE a.status <> 'CLOSED'`,
  ).first<{ customers: number; treasury: number }>();
  const flow = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS volume, COUNT(*) AS transfers
       FROM bank_transfers WHERE status = 'POSTED' AND created_at >= ?`,
  )
    .bind(nowIso(-24 * 60 * 60 * 1000))
    .first<{ volume: number; transfers: number }>();
  const pending = await env.DB.prepare(
    `${JOINED_USER_SELECT} WHERE u.status = 'PENDING' AND u.role IN ('USER', 'ADMIN') ORDER BY u.created_at ASC LIMIT 20`,
  ).all<JoinedUserRow>();
  const recent = await env.DB.prepare(
    `${JOINED_USER_SELECT} WHERE u.role <> 'SYSTEM' ORDER BY u.created_at DESC LIMIT 8`,
  ).all<JoinedUserRow>();
  const auditRows = await env.DB.prepare(
    `SELECT COALESCE(u.name, 'sistema') AS actor, a.action, a.resource, a.details, a.created_at
       FROM bank_audit a LEFT JOIN bank_users u ON u.id = a.actor_id
      WHERE a.action LIKE 'bank.%' ORDER BY a.created_at DESC LIMIT 30`,
  ).all<{ actor: string; action: string; resource: string; details: string | null; created_at: string }>();
  const trial = await ledgerTrial(env);
  const fx = await fxSystemOverview(env);
  return {
    system: {
      users: users?.total ?? 0,
      activeUsers: users?.active ?? 0,
      pendingUsers: users?.pending ?? 0,
      blockedUsers: users?.blocked ?? 0,
      totalBalanceCents: balances?.customers ?? 0,
      totalBalanceFormatted: formatBRL(balances?.customers ?? 0),
      treasuryBalanceCents: balances?.treasury ?? 0,
      treasuryBalanceFormatted: formatBRL(balances?.treasury ?? 0),
      transfers24h: flow?.transfers ?? 0,
      volume24hCents: flow?.volume ?? 0,
      volume24hFormatted: formatBRL(flow?.volume ?? 0),
      ledger: trial,
      fx,
    },
    pending: (pending.results ?? []).map((row) => userView(row, joinedAccount(row), false)),
    recentUsers: (recent.results ?? []).map((row) => userView(row, joinedAccount(row), false)),
    audit: (auditRows.results ?? []).map((row) => ({
      actor: row.actor,
      action: row.action,
      resource: row.resource,
      metadata: row.details ? (JSON.parse(row.details) as unknown) : null,
      createdAt: row.created_at,
    })),
  };
}

export async function listUsers(
  env: Env,
  filters: { status?: string; search?: string; limit?: number },
): Promise<Array<ReturnType<typeof userView>>> {
  const clauses = ["u.role IN ('USER', 'ADMIN')"];
  const bindings: unknown[] = [];
  if (filters.status && ['PENDING', 'ACTIVE', 'BLOCKED', 'DELETED'].includes(filters.status)) {
    clauses.push('u.status = ?');
    bindings.push(filters.status);
  }
  if (filters.search) {
    clauses.push('(lower(u.name) LIKE ? OR u.document LIKE ? OR lower(u.email) LIKE ? OR a.number LIKE ?)');
    const term = `%${filters.search.toLowerCase()}%`;
    const digits = `%${filters.search.replace(/\D/g, '')}%`;
    bindings.push(term, digits, term, digits);
  }
  bindings.push(Math.min(200, Math.max(1, filters.limit ?? 100)));
  const rows = await env.DB.prepare(
    `${JOINED_USER_SELECT}
      WHERE ${clauses.join(' AND ')}
      ORDER BY CASE u.status WHEN 'PENDING' THEN 0 ELSE 1 END, u.created_at DESC
      LIMIT ?`,
  )
    .bind(...bindings)
    .all<JoinedUserRow>();
  return (rows.results ?? []).map((row) => userView(row, joinedAccount(row), false));
}

export async function adminUserDetail(env: Env, userId: string): Promise<Record<string, unknown>> {
  const user = await findUserById(env, userId);
  if (!user || user.role === 'SYSTEM') throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  const account = await accountByUser(env, userId);
  return {
    user: userView(user, account, false),
    credit: account ? await creditScore(env, { account, user }) : null,
    statement: account ? await statement(env, { account }, { limit: 25 }) : null,
  };
}

export async function approveUser(env: Env, admin: AuthContext, userId: string): Promise<Record<string, unknown>> {
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  if (user.status !== 'PENDING') {
    throw new HttpError(409, 'INVALID_STATUS', 'Somente cadastros pendentes podem ser aprovados.');
  }
  const account = await createAccount(env, userId);
  const now = nowIso();
  await env.DB.prepare(
    'UPDATE bank_users SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?',
  )
    .bind('ACTIVE', admin.user.id, now, now, userId)
    .run();
  await audit(env, {
    actorId: admin.user.id,
    action: 'bank.user.approved',
    resource: 'bank_user',
    resourceId: userId,
    details: { accountId: account.id },
  });
  await queueEvent(env, {
    topic: 'bank.user',
    type: 'bank.user.approved',
    payload: { userId, accountId: account.id, approvedBy: admin.user.id },
  });
  return {
    user: userView((await findUserById(env, userId)) as UserRow, account, false),
    account: accountView(account),
  };
}

export async function rejectUser(env: Env, admin: AuthContext, userId: string): Promise<void> {
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  if (user.status !== 'PENDING') {
    throw new HttpError(409, 'INVALID_STATUS', 'Somente cadastros pendentes podem ser recusados.');
  }
  await env.DB.prepare('UPDATE bank_users SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind('DELETED', nowIso(), nowIso(), userId)
    .run();
  await audit(env, {
    actorId: admin.user.id,
    action: 'bank.user.rejected',
    resource: 'bank_user',
    resourceId: userId,
  });
}

export async function setBlocked(
  env: Env,
  admin: AuthContext,
  userId: string,
  blocked: boolean,
): Promise<void> {
  if (userId === admin.user.id) {
    throw new HttpError(422, 'SELF_ACTION', 'O administrador não pode bloquear a própria conta.');
  }
  const user = await findUserById(env, userId);
  if (!user || user.role === 'SYSTEM') throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  if (blocked && user.status !== 'ACTIVE') {
    throw new HttpError(409, 'INVALID_STATUS', 'Somente contas ativas podem ser bloqueadas.');
  }
  if (!blocked && user.status !== 'BLOCKED') {
    throw new HttpError(409, 'INVALID_STATUS', 'Conta não está bloqueada.');
  }
  const now = nowIso();
  await env.DB.prepare('UPDATE bank_users SET status = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .bind(blocked ? 'BLOCKED' : 'ACTIVE', now, userId)
    .run();
  await env.DB.prepare('UPDATE bank_accounts SET status = ?, updated_at = ? WHERE user_id = ?')
    .bind(blocked ? 'BLOCKED' : 'ACTIVE', now, userId)
    .run();
  if (blocked) await revokeSessions(env, userId);
  await audit(env, {
    actorId: admin.user.id,
    action: blocked ? 'bank.user.blocked' : 'bank.user.unblocked',
    resource: 'bank_user',
    resourceId: userId,
  });
}

export async function deleteUser(env: Env, admin: AuthContext, userId: string): Promise<void> {
  if (userId === admin.user.id) {
    throw new HttpError(422, 'SELF_ACTION', 'O administrador não pode excluir a própria conta.');
  }
  const user = await findUserById(env, userId);
  if (!user || user.role === 'SYSTEM') throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  const account = await accountByUser(env, userId);
  if (account && account.balance_cents > 0) {
    throw new HttpError(409, 'BALANCE_NOT_ZERO', `Conta com saldo de ${formatBRL(account.balance_cents)}. Transfira antes de excluir.`, {
      balanceCents: account.balance_cents,
    });
  }
  const now = nowIso();
  await env.DB.prepare('UPDATE bank_users SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind('DELETED', now, now, userId)
    .run();
  await env.DB.prepare("UPDATE bank_accounts SET status = 'CLOSED', updated_at = ? WHERE user_id = ?")
    .bind(now, userId)
    .run();
  await revokeSessions(env, userId);
  await audit(env, {
    actorId: admin.user.id,
    action: 'bank.user.deleted',
    resource: 'bank_user',
    resourceId: userId,
  });
}

export async function resetUserPassword(
  env: Env,
  admin: AuthContext,
  userId: string,
): Promise<{ tempPassword: string; revokedSessions: number }> {
  const user = await findUserById(env, userId);
  if (!user || user.role === 'SYSTEM') throw new HttpError(404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
  if (user.status === 'DELETED') throw new HttpError(409, 'INVALID_STATUS', 'Usuário excluído.');
  const tempPassword = generateTempPassword();
  const hash = await hashPassword(tempPassword);
  await env.DB.prepare(
    'UPDATE bank_users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(hash, nowIso(), userId)
    .run();
  const revoked = await revokeSessions(env, userId);
  await audit(env, {
    actorId: admin.user.id,
    action: 'bank.password.reset',
    resource: 'bank_user',
    resourceId: userId,
    details: { revokedSessions: revoked },
  });
  return { tempPassword, revokedSessions: revoked };
}

export async function auditLog(env: Env, limit = 100): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.action, a.resource, a.resource_id, a.details, a.created_at,
            COALESCE(u.name, 'sistema') AS actor
       FROM bank_audit a LEFT JOIN bank_users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(Math.min(300, Math.max(1, limit)))
    .all<{
      id: string;
      action: string;
      resource: string;
      resource_id: string | null;
      details: string | null;
      created_at: string;
      actor: string;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    resourceId: row.resource_id,
    metadata: row.details ? (JSON.parse(row.details) as unknown) : null,
    createdAt: row.created_at,
  }));
}

// Reexport usados pelo roteador para evitar ciclos de importação.
export { resolveRecipient };

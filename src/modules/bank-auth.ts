import { randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId, randomToken } from '../kernel/ids.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { formatBRL } from '../kernel/money.ts';
import {
  assertDocument,
  assertEmail,
  assertPhone,
  formatDocument,
  formatPhone,
  maskDocument,
  normalizeName,
  onlyDigits,
} from '../domain/documents.ts';
import {
  accountView,
  ensureAccount,
  type BankAccountRow,
  type BankAccountView,
  type BankService,
  TREASURY_USER_ID,
} from './bank.ts';

export const BANK_SESSION_COOKIE = 'xp_bank_session';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface BankUserRow {
  id: string;
  name: string;
  document: string;
  email: string;
  phone: string | null;
  password_hash: string;
  role: 'USER' | 'ADMIN' | 'SYSTEM';
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'DELETED';
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface BankSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface BankUserView {
  id: string;
  name: string;
  document: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  mustChangePassword: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  account: BankAccountView | null;
}

export interface BankAuth {
  user: BankUserRow;
  account: BankAccountRow | null;
  session: BankSessionRow;
}

export interface SessionTokens {
  token: string;
  csrfToken: string;
  expiresAt: string;
  sessionId: string;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export function hashPassword(password: string): string {
  const salt = randomToken(16);
  const hash = scryptSync(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  }).toString('base64url');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, nRaw, rRaw, pRaw, salt, expected] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const actual = scryptSync(password, salt, 64, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  'senha123456',
  '1234567890',
  'password123',
  'qwerty12345',
  'xpartner123',
  'banco123456',
  'admin123456',
  'abcdef1234',
]);

export function validatePassword(password: string, context: { name?: string; document?: string; email?: string } = {}): void {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new AppError('WEAK_PASSWORD', 'A senha deve ter entre 10 e 128 caracteres.', 422);
  }
  if (!/[A-Za-zÀ-ÿ]/.test(password) || !/\d/.test(password)) {
    throw new AppError('WEAK_PASSWORD', 'A senha deve combinar letras e números.', 422);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError('WEAK_PASSWORD', 'Esta senha é muito comum. Escolha outra.', 422);
  }
  const normalized = password.toLowerCase();
  const document = onlyDigits(context.document ?? '');
  if (document.length >= 8 && normalized.includes(document)) {
    throw new AppError('WEAK_PASSWORD', 'A senha não pode conter o seu documento.', 422);
  }
  const email = (context.email ?? '').toLowerCase();
  if (email.includes('@') && normalized.includes(email.split('@')[0])) {
    throw new AppError('WEAK_PASSWORD', 'A senha não pode conter o seu e-mail.', 422);
  }
  if (context.name) {
    const firstName = context.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstName.length >= 3 && normalized.includes(firstName)) {
      throw new AppError('WEAK_PASSWORD', 'A senha não pode conter o seu nome.', 422);
    }
  }
}

export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const pick = (alphabet: string): string => alphabet[randomInt(0, alphabet.length)];
  const chars = [
    pick(upper),
    pick(upper),
    pick(lower),
    pick(lower),
    pick(lower),
    pick(lower),
    pick(lower),
    pick(lower),
    pick(digits),
    pick(digits),
    pick(digits),
    pick(digits),
  ];
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return `Xp${chars.join('')}`;
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token || undefined;
}

export function sessionCookie(token: string, ttlSeconds: number, secure: boolean): string {
  const flags = [
    `${BANK_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ttlSeconds}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const flags = [`${BANK_SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export interface RegisterInput {
  name: string;
  document: string;
  email: string;
  phone?: string;
  password: string;
  bootstrapToken?: string;
}

export interface LoginInput {
  identifier: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

export interface RegisterResult {
  user: BankUserView;
  account: BankAccountView | null;
  requiresApproval: boolean;
  bootstrapAdmin: boolean;
  session: SessionTokens | null;
}

export class BankAuthService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly bank: BankService;
  private loginAttempts = new Map<string, number[]>();

  constructor(db: Db, config: AppConfig, bank: BankService) {
    this.db = db;
    this.config = config;
    this.bank = bank;
  }

  private throttle(key: string, now = Date.now()): void {
    const windowStart = now - 60_000;
    const hits = (this.loginAttempts.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    if (hits.length >= 20) throw Errors.rateLimited();
    hits.push(now);
    this.loginAttempts.set(key, hits);
    if (this.loginAttempts.size > 5000) {
      for (const [entry, list] of this.loginAttempts) {
        if (!list.length || list[list.length - 1] < windowStart) this.loginAttempts.delete(entry);
      }
    }
  }

  private countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM bank_users WHERE role <> 'SYSTEM'").get() as {
      count: number;
    };
    return row.count;
  }

  private accountFor(userId: string): BankAccountRow | null {
    return (this.db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId) as
      | BankAccountRow
      | undefined) ?? null;
  }

  private userRow(userId: string): BankUserRow | undefined {
    return this.db.prepare('SELECT * FROM bank_users WHERE id = ?').get(userId) as BankUserRow | undefined;
  }

  view(row: BankUserRow, options: { self?: boolean } = {}): BankUserView {
    const account = this.accountFor(row.id);
    return {
      id: row.id,
      name: row.name,
      document: options.self ? formatDocument(row.document) : maskDocument(row.document),
      email: options.self ? row.email : maskEmail(row.email),
      phone: options.self ? (row.phone ? formatPhone(row.phone) : null) : row.phone ? `(••) •••••-${row.phone.slice(-4)}` : null,
      role: row.role,
      status: row.status,
      mustChangePassword: row.must_change_password === 1,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      account: account ? accountView(account) : null,
    };
  }

  private createSession(userId: string, ip?: string, userAgent?: string, now = Date.now()): SessionTokens {
    const token = `bpk_${randomToken(32)}`;
    const csrfToken = randomToken(24);
    const sessionId = newId('bses', now);
    const createdAt = nowIso(now);
    const expiresAt = nowIso(now + this.config.bankSessionTtlSeconds * 1000);
    this.db
      .prepare(
        `INSERT INTO bank_sessions
           (id, user_id, token_hash, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        userId,
        sha256Hex(token),
        csrfToken,
        ip ?? null,
        userAgent ? userAgent.slice(0, 200) : null,
        createdAt,
        createdAt,
        expiresAt,
      );
    return { token, csrfToken, expiresAt, sessionId };
  }

  private revokeSessions(userId: string, exceptSessionId?: string): void {
    const timestamp = nowIso();
    if (exceptSessionId) {
      this.db
        .prepare('UPDATE bank_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL')
        .run(timestamp, userId, exceptSessionId);
    } else {
      this.db
        .prepare('UPDATE bank_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(timestamp, userId);
    }
  }

  register(input: RegisterInput, meta: { ip?: string; userAgent?: string } = {}): RegisterResult {
    const name = normalizeName(input.name, 80);
    const { document } = assertDocument(input.document, 'CPF/CNPJ');
    const email = assertEmail(input.email);
    const phone = input.phone ? assertPhone(input.phone) : null;
    validatePassword(input.password, { name, document, email });

    const duplicateDocument = this.db.prepare('SELECT id FROM bank_users WHERE document = ?').get(document);
    if (duplicateDocument) throw new AppError('DOCUMENT_EXISTS', 'Já existe uma conta com este CPF/CNPJ.', 409);
    const duplicateEmail = this.db.prepare('SELECT id FROM bank_users WHERE lower(email) = ?').get(email);
    if (duplicateEmail) throw new AppError('EMAIL_EXISTS', 'Já existe uma conta com este e-mail.', 409);

    const isFirst = this.countUsers() === 0;
    let role: 'USER' | 'ADMIN' = 'USER';
    let status: 'PENDING' | 'ACTIVE' = 'PENDING';
    if (isFirst) {
      if (this.config.demoMode) {
        role = 'ADMIN';
        status = 'ACTIVE';
      } else if (
        this.config.bankBootstrapToken &&
        input.bootstrapToken &&
        input.bootstrapToken === this.config.bankBootstrapToken
      ) {
        role = 'ADMIN';
        status = 'ACTIVE';
      } else {
        throw new AppError(
          'BOOTSTRAP_REQUIRED',
          'Primeiro administrador exige o token de bootstrap configurado no servidor.',
          403,
        );
      }
    }

    const now = Date.now();
    const timestamp = nowIso(now);
    const id = newId('busr', now);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO bank_users
             (id, name, document, email, phone, password_hash, role, status, must_change_password,
              approved_by, approved_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          document,
          email,
          phone,
          hashPassword(input.password),
          role,
          status,
          status === 'ACTIVE' ? id : null,
          status === 'ACTIVE' ? timestamp : null,
          timestamp,
          timestamp,
        );
      if (status === 'ACTIVE') ensureAccount(this.db, id, now);
      audit(this.db, id, 'bank.user.registered', `bank_user:${id}`, { role, status });
      enqueueEvent(this.db, {
        topic: 'bank.user',
        type: status === 'ACTIVE' ? 'bank.user.activated' : 'bank.user.pending',
        key: id,
        payload: { userId: id, name, status, role },
      });
    });

    const row = this.userRow(id);
    if (!row) throw Errors.internal('Falha ao criar usuário.');
    const session = status === 'ACTIVE' ? this.createSession(id, meta.ip, meta.userAgent) : null;
    return {
      user: this.view(row, { self: true }),
      account: this.accountFor(id) ? accountView(this.accountFor(id) as BankAccountRow) : null,
      requiresApproval: status === 'PENDING',
      bootstrapAdmin: isFirst && role === 'ADMIN',
      session,
    };
  }

  login(input: LoginInput, meta: { ip?: string; userAgent?: string } = {}): {
    user: BankUserView;
    session: SessionTokens;
  } {
    const identifier = input.identifier.trim();
    if (!identifier) throw Errors.validation('Informe e-mail ou CPF/CNPJ.');
    this.throttle(`${meta.ip ?? 'unknown'}:${identifier.toLowerCase()}`);

    const row = identifier.includes('@')
      ? (this.db.prepare('SELECT * FROM bank_users WHERE lower(email) = ?').get(identifier.toLowerCase()) as
          | BankUserRow
          | undefined)
      : (this.db.prepare('SELECT * FROM bank_users WHERE document = ?').get(onlyDigits(identifier)) as
          | BankUserRow
          | undefined);

    if (!row || row.role === 'SYSTEM' || row.status === 'DELETED') {
      throw Errors.unauthorized('E-mail/CPF ou senha inválidos.');
    }
    if (row.locked_until && row.locked_until > nowIso()) {
      throw new AppError('ACCOUNT_LOCKED', 'Conta temporariamente bloqueada por tentativas inválidas.', 429, {
        lockedUntil: row.locked_until,
      });
    }
    if (!verifyPassword(input.password, row.password_hash)) {
      const failures = row.failed_attempts + 1;
      const lockUntil =
        failures >= MAX_FAILED_ATTEMPTS ? nowIso(Date.now() + LOCK_MINUTES * 60_000) : null;
      this.db
        .prepare('UPDATE bank_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(failures, lockUntil, nowIso(), row.id);
      audit(this.db, row.id, 'bank.login.failed', `bank_user:${row.id}`, { failures, locked: Boolean(lockUntil) });
      if (lockUntil) {
        throw new AppError('ACCOUNT_LOCKED', `Conta bloqueada por ${LOCK_MINUTES} minutos.`, 429, {
          lockedUntil: lockUntil,
        });
      }
      throw Errors.unauthorized('E-mail/CPF ou senha inválidos.');
    }
    if (row.status === 'PENDING') {
      throw new AppError('ACCOUNT_PENDING', 'Cadastro aguardando aprovação do administrador.', 403);
    }
    if (row.status === 'BLOCKED') {
      throw new AppError('ACCOUNT_BLOCKED', 'Conta bloqueada. Procure o administrador.', 403);
    }
    if (row.status !== 'ACTIVE') throw Errors.unauthorized();

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE bank_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nowIso(now), nowIso(now), row.id);
    const session = this.createSession(row.id, meta.ip ?? input.ip, meta.userAgent, now);
    audit(this.db, row.id, 'bank.login.success', `bank_user:${row.id}`, { sessionId: session.sessionId });
    return { user: this.view({ ...row, failed_attempts: 0, locked_until: null, last_login_at: nowIso(now) }, { self: true }), session };
  }

  authenticate(request: FastifyRequest): BankAuth {
    const token = bearerToken(request) ?? parseCookie(request.headers.cookie, BANK_SESSION_COOKIE);
    if (!token) throw Errors.unauthorized('Sessão bancária ausente.');
    const session = this.db
      .prepare('SELECT * FROM bank_sessions WHERE token_hash = ?')
      .get(sha256Hex(token)) as BankSessionRow | undefined;
    if (!session || session.revoked_at) throw Errors.unauthorized('Sessão inválida ou revogada.');
    if (session.expires_at <= nowIso()) throw Errors.unauthorized('Sessão expirada.');
    const user = this.userRow(session.user_id);
    if (!user || user.status !== 'ACTIVE' || user.role === 'SYSTEM') {
      throw Errors.unauthorized('Usuário inativo.');
    }
    const account = this.accountFor(user.id);
    if (!account || account.status === 'CLOSED') {
      throw new AppError('ACCOUNT_CLOSED', 'Conta bancária encerrada.', 403);
    }
    if (
      request.method !== 'GET' &&
      !bearerToken(request) &&
      request.headers['x-bank-csrf'] !== session.csrf_token
    ) {
      throw Errors.forbidden('Token CSRF ausente.');
    }
    if (nowIso(Date.now() - 5 * 60_000) > session.last_seen_at) {
      this.db.prepare('UPDATE bank_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), session.id);
    }
    return { user, account, session };
  }

  requireAdmin(auth: BankAuth): BankAuth {
    if (auth.user.role !== 'ADMIN') throw Errors.forbidden('Ação restrita ao administrador.');
    return auth;
  }

  logout(auth: BankAuth): void {
    this.db.prepare('UPDATE bank_sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), auth.session.id);
    audit(this.db, auth.user.id, 'bank.logout', `bank_user:${auth.user.id}`, { sessionId: auth.session.id });
  }

  changePassword(auth: BankAuth, currentPassword: string, newPassword: string): void {
    if (!verifyPassword(currentPassword, auth.user.password_hash)) {
      throw new AppError('INVALID_PASSWORD', 'Senha atual incorreta.', 401);
    }
    validatePassword(newPassword, {
      name: auth.user.name,
      document: auth.user.document,
      email: auth.user.email,
    });
    if (verifyPassword(newPassword, auth.user.password_hash)) {
      throw new AppError('SAME_PASSWORD', 'A nova senha deve ser diferente da atual.', 422);
    }
    this.db
      .prepare(
        'UPDATE bank_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      )
      .run(hashPassword(newPassword), nowIso(), auth.user.id);
    this.revokeSessions(auth.user.id, auth.session.id);
    audit(this.db, auth.user.id, 'bank.password.changed', `bank_user:${auth.user.id}`);
  }

  adminOverview(): {
    system: ReturnType<BankService['systemOverview']>;
    pending: BankUserView[];
    recentUsers: BankUserView[];
    audit: Array<{ actor: string; action: string; resource: string; metadata: unknown; createdAt: string }>;
  } {
    const pending = this.db
      .prepare("SELECT * FROM bank_users WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 20")
      .all() as unknown as BankUserRow[];
    const recent = this.db
      .prepare("SELECT * FROM bank_users WHERE role <> 'SYSTEM' ORDER BY created_at DESC LIMIT 8")
      .all() as unknown as BankUserRow[];
    const auditRows = this.db
      .prepare(
        `SELECT actor, action, resource, metadata, created_at FROM audit_log
          WHERE action LIKE 'bank.%' ORDER BY created_at DESC LIMIT 30`,
      )
      .all() as Array<{ actor: string; action: string; resource: string; metadata: string | null; created_at: string }>;
    return {
      system: this.bank.systemOverview(),
      pending: pending.map((row) => this.view(row)),
      recentUsers: recent.map((row) => this.view(row)),
      audit: auditRows.map((row) => ({
        actor: row.actor,
        action: row.action,
        resource: row.resource,
        metadata: row.metadata ? (JSON.parse(row.metadata) as unknown) : null,
        createdAt: row.created_at,
      })),
    };
  }

  listUsers(options: { status?: string; search?: string; limit?: number } = {}): BankUserView[] {
    const clauses = ["u.role <> 'SYSTEM'"];
    const params: Array<string | number> = [];
    if (options.status) {
      clauses.push('u.status = ?');
      params.push(options.status);
    }
    const search = options.search?.trim();
    if (search) {
      clauses.push('(u.name LIKE ? OR u.document LIKE ? OR u.email LIKE ? OR a.number LIKE ?)');
      const like = `%${search.replace(/[%_]/g, '')}%`;
      params.push(like, like, like, like);
    }
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT u.* FROM bank_users u
           LEFT JOIN bank_accounts a ON a.user_id = u.id
          WHERE ${clauses.join(' AND ')}
          ORDER BY CASE u.status WHEN 'PENDING' THEN 0 ELSE 1 END, u.created_at DESC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as BankUserRow[];
    return rows.map((row) => this.view(row));
  }

  adminUserDetail(userId: string): {
    user: BankUserView;
    credit: ReturnType<BankService['creditScore']> | null;
    statement: ReturnType<BankService['statement']> | null;
  } {
    const row = this.userRow(userId);
    if (!row || row.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    const account = this.accountFor(userId);
    return {
      user: this.view(row),
      credit: account ? this.bank.creditScore(account.id) : null,
      statement: account ? this.bank.statement(account.id, { limit: 25 }) : null,
    };
  }

  approve(actorId: string, userId: string): { user: BankUserView; account: BankAccountView } {
    const user = this.userRow(userId);
    if (!user || user.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    if (user.status !== 'PENDING') {
      throw Errors.conflict('Somente cadastros pendentes podem ser aprovados.');
    }
    const now = Date.now();
    const timestamp = nowIso(now);
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE bank_users SET status = 'ACTIVE', approved_by = ?, approved_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(actorId, timestamp, timestamp, userId);
      ensureAccount(this.db, userId, now);
      audit(this.db, actorId, 'bank.user.approved', `bank_user:${userId}`);
      enqueueEvent(this.db, {
        topic: 'bank.user',
        type: 'bank.user.approved',
        key: userId,
        payload: { userId, approvedBy: actorId },
      });
    });
    const account = this.accountFor(userId);
    return { user: this.view({ ...user, status: 'ACTIVE', approved_by: actorId, approved_at: timestamp }), account: accountView(account as BankAccountRow) };
  }

  reject(actorId: string, userId: string): void {
    const user = this.userRow(userId);
    if (!user || user.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    if (user.status !== 'PENDING') throw Errors.conflict('Somente cadastros pendentes podem ser recusados.');
    const timestamp = nowIso();
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE bank_users SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, userId);
      this.revokeSessions(userId);
      audit(this.db, actorId, 'bank.user.rejected', `bank_user:${userId}`);
    });
  }

  setBlocked(actorId: string, userId: string, blocked: boolean): BankUserView {
    const user = this.userRow(userId);
    if (!user || user.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    if (user.id === actorId) throw Errors.validation('O administrador não pode bloquear a própria conta.');
    if (user.status === 'DELETED') throw Errors.conflict('Usuário excluído.');
    if (blocked && user.status !== 'ACTIVE') throw Errors.conflict('Usuário não está ativo.');
    if (!blocked && user.status !== 'BLOCKED') throw Errors.conflict('Usuário não está bloqueado.');
    const timestamp = nowIso();
    tx(this.db, () => {
      this.db
        .prepare('UPDATE bank_users SET status = ?, updated_at = ? WHERE id = ?')
        .run(blocked ? 'BLOCKED' : 'ACTIVE', timestamp, userId);
      this.db
        .prepare('UPDATE bank_accounts SET status = ?, updated_at = ? WHERE user_id = ?')
        .run(blocked ? 'BLOCKED' : 'ACTIVE', timestamp, userId);
      if (blocked) this.revokeSessions(userId);
      audit(this.db, actorId, blocked ? 'bank.user.blocked' : 'bank.user.unblocked', `bank_user:${userId}`);
      enqueueEvent(this.db, {
        topic: 'bank.user',
        type: blocked ? 'bank.user.blocked' : 'bank.user.unblocked',
        key: userId,
        payload: { userId, by: actorId },
      });
    });
    return this.view({ ...user, status: blocked ? 'BLOCKED' : 'ACTIVE' });
  }

  delete(actorId: string, userId: string): void {
    const user = this.userRow(userId);
    if (!user || user.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    if (user.id === actorId) throw Errors.validation('O administrador não pode excluir a própria conta.');
    const account = this.accountFor(userId);
    if (account && account.balance_cents > 0) {
      throw new AppError(
        'BALANCE_NOT_ZERO',
        `Conta com saldo de ${formatBRL(account.balance_cents)}. Transfira ou resgate antes de excluir.`,
        409,
        { balanceCents: account.balance_cents, balanceFormatted: formatBRL(account.balance_cents) },
      );
    }
    const timestamp = nowIso();
    tx(this.db, () => {
      this.db
        .prepare('UPDATE bank_users SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?')
        .run('DELETED', timestamp, timestamp, userId);
      this.db
        .prepare("UPDATE bank_accounts SET status = 'CLOSED', updated_at = ? WHERE user_id = ?")
        .run(timestamp, userId);
      this.revokeSessions(userId);
      audit(this.db, actorId, 'bank.user.deleted', `bank_user:${userId}`);
      enqueueEvent(this.db, {
        topic: 'bank.user',
        type: 'bank.user.deleted',
        key: userId,
        payload: { userId, by: actorId },
      });
    });
  }

  resetPassword(actorId: string, userId: string): { user: BankUserView; tempPassword: string } {
    const user = this.userRow(userId);
    if (!user || user.role === 'SYSTEM') throw Errors.notFound('Usuário não encontrado.');
    if (user.id === actorId) throw Errors.validation('Use a troca de senha para a própria conta.');
    if (user.status === 'DELETED') throw Errors.conflict('Usuário excluído.');
    const tempPassword = generateTempPassword();
    const timestamp = nowIso();
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE bank_users SET password_hash = ?, must_change_password = 1, failed_attempts = 0,
             locked_until = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(hashPassword(tempPassword), timestamp, userId);
      this.revokeSessions(userId);
      audit(this.db, actorId, 'bank.password.reset', `bank_user:${userId}`);
    });
    return { user: this.view({ ...user, must_change_password: 1, failed_attempts: 0, locked_until: null }), tempPassword };
  }

  auditLog(limit = 50): Array<{ actor: string; action: string; resource: string; metadata: unknown; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT actor, action, resource, metadata, created_at FROM audit_log
          WHERE action LIKE 'bank.%' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit))) as Array<{
      actor: string;
      action: string;
      resource: string;
      metadata: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      actor: row.actor,
      action: row.action,
      resource: row.resource,
      metadata: row.metadata ? (JSON.parse(row.metadata) as unknown) : null,
      createdAt: row.created_at,
    }));
  }

  status(): {
    demoMode: boolean;
    firstUserBecomesAdmin: boolean;
    bootstrapTokenRequired: boolean;
    users: number;
    treasuryUserId: string;
  } {
    const count = this.countUsers();
    return {
      demoMode: this.config.demoMode,
      firstUserBecomesAdmin: count === 0 && this.config.demoMode,
      bootstrapTokenRequired: count === 0 && !this.config.demoMode,
      users: count,
      treasuryUserId: TREASURY_USER_ID,
    };
  }
}

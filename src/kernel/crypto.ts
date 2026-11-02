import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, Errors } from './errors.ts';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha1Hex(value: string | Buffer): string {
  return createHash('sha1').update(value).digest('hex');
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Deriva segredos por finalidade a partir da chave mestra (KMS em produção). */
export function deriveSecret(masterKey: string, purpose: string): string {
  return hmacHex(masterKey, `xpartner:v1:${purpose}`);
}

export function deviceSecret(masterKey: string, terminalId: string): string {
  return deriveSecret(masterKey, `device:${terminalId}`);
}

export function fingerprint(value: string, masterKey: string): string {
  return createHash('sha256').update(`fp:${masterKey}:${value}`).digest('hex').slice(0, 32);
}

export interface TokenPayload {
  sub: string;
  scope: string;
  merchantId: string;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(
  claims: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const payload: TokenPayload = {
    ...claims,
    sub: String(claims.sub ?? ''),
    scope: String(claims.scope ?? ''),
    merchantId: String(claims.merchantId ?? ''),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`v1.${body}`).digest('base64url');
  return `v1.${body}.${signature}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw Errors.unauthorized('Token malformado.');
  const [, body, signature] = parts;
  const expected = createHmac('sha256', secret).update(`v1.${body}`).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw Errors.unauthorized('Assinatura de token inválida.');
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    throw Errors.unauthorized('Token ilegível.');
  }
  if (!payload.exp || payload.exp * 1000 < now) throw Errors.unauthorized('Token expirado.');
  return payload;
}

export function requireScope(payload: TokenPayload, scope: string): void {
  const scopes = String(payload.scope).split(' ');
  if (!scopes.includes(scope) && !scopes.includes('*')) {
    throw Errors.forbidden(`Escopo ${scope} ausente.`);
  }
}

/** Cache de nonces para bloquear replay de requisições assinadas. */
export class NonceCache {
  private seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Retorna false quando o nonce já foi usado (replay). */
  use(nonce: string, now = Date.now()): boolean {
    const existing = this.seen.get(nonce);
    if (existing !== undefined && existing > now - this.ttlMs) return false;
    this.seen.set(nonce, now);
    if (this.seen.size > 20_000) this.gc(now);
    return true;
  }

  private gc(now: number): void {
    for (const [nonce, timestamp] of this.seen) {
      if (timestamp <= now - this.ttlMs) this.seen.delete(nonce);
    }
  }
}

export function safeCompareStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function assertNonEmptyString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError('VALIDATION_ERROR', `${field} inválido.`, 422, { field });
  }
  return value.trim();
}

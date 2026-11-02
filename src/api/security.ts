import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { Errors } from '../kernel/errors.ts';
import {
  constantTimeEqualHex,
  deriveSecret,
  deviceSecret,
  hmacHex,
  NonceCache,
  signToken,
  verifyToken,
  type TokenPayload,
} from '../kernel/crypto.ts';

import {
  certificateFingerprint,
  fingerprintsMatch,
  normalizeFingerprint,
  peerCertificate,
  terminalSerialFromCertificate,
} from './cert.ts';

export function tokenSecret(config: AppConfig): string {
  return deriveSecret(config.masterKey, 'token');
}

export function providerSecret(config: AppConfig): string {
  return deriveSecret(config.masterKey, 'pix-webhook');
}

export function issueMerchantToken(config: AppConfig, merchantId: string, scope = 'demo:read demo:write'): string {
  return signToken({ sub: merchantId, merchantId, scope }, tokenSecret(config), config.tokenTtlSeconds);
}

export interface DeviceAuth {
  terminalId: string;
  merchantId: string;
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export class DeviceAuthenticator {
  private readonly nonces: NonceCache;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.nonces = new NonceCache(config.hmacWindowSeconds * 1000);
  }

  verify(db: Db, request: FastifyRequest): DeviceAuth {
    const terminalId = header(request, 'x-device-id');
    const timestamp = header(request, 'x-timestamp');
    const nonce = header(request, 'x-nonce');
    const signature = header(request, 'x-signature');
    if (!terminalId || !timestamp || !nonce || !signature) {
      throw Errors.unauthorized(
        'Assinatura de dispositivo ausente (x-device-id, x-timestamp, x-nonce, x-signature).',
      );
    }
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.config.hmacWindowSeconds * 1000) {
      throw Errors.unauthorized('Timestamp fora da janela permitida.');
    }
    if (!this.nonces.use(`${terminalId}:${nonce}`)) {
      throw Errors.unauthorized('Nonce reutilizado (possível replay).');
    }

    const terminal = db
      .prepare('SELECT id, merchant_id, serial, status, cert_fingerprint FROM terminals WHERE id = ?')
      .get(terminalId) as
      | { id: string; merchant_id: string; serial: string; status: string; cert_fingerprint: string | null }
      | undefined;
    if (!terminal) throw Errors.unauthorized('Dispositivo desconhecido.');
    if (terminal.status !== 'ACTIVE') throw Errors.forbidden('Dispositivo bloqueado.');

    const cert = peerCertificate(request);
    if (cert) {
      const serial = terminalSerialFromCertificate(cert);
      if (serial !== terminal.serial) {
        throw Errors.forbidden('Certificado mTLS não pertence ao terminal informado.');
      }
    }

    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const expected = hmacHex(deviceSecret(this.config.masterKey, terminalId), `${timestamp}.${nonce}.${rawBody}`);
    if (!constantTimeEqualHex(signature, expected)) {
      throw Errors.unauthorized('Assinatura HMAC inválida.');
    }

    const presentedFingerprint =
      certificateFingerprint(cert) ?? normalizeFingerprint(header(request, 'x-client-cert-fingerprint'));
    if (this.config.isProduction && !presentedFingerprint) {
      throw Errors.unauthorized('Certificado mTLS do terminal não apresentado.');
    }
    const registeredFingerprint = normalizeFingerprint(terminal.cert_fingerprint);
    if (presentedFingerprint && registeredFingerprint && !fingerprintsMatch(registeredFingerprint, presentedFingerprint)) {
      throw Errors.forbidden('Fingerprint do certificado mTLS não confere com o terminal.');
    }

    db.prepare('UPDATE terminals SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), terminalId);
    return { terminalId: terminal.id, merchantId: terminal.merchant_id };
  }
}

export function hmacDeviceSignature(
  config: AppConfig,
  terminalId: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return hmacHex(deviceSecret(config.masterKey, terminalId), `${timestamp}.${nonce}.${rawBody}`);
}

export function authenticateBearer(config: AppConfig, request: FastifyRequest, scope?: string): TokenPayload {
  const authorization = header(request, 'authorization');
  if (!authorization.startsWith('Bearer ')) throw Errors.unauthorized('Token Bearer ausente.');
  const token = authorization.slice('Bearer '.length).trim();
  const claims = verifyToken(token, tokenSecret(config));
  if (scope) {
    const scopes = String(claims.scope).split(' ');
    if (!scopes.includes(scope) && !scopes.includes('*')) throw Errors.forbidden(`Escopo ${scope} ausente.`);
  }
  return claims;
}

export function assertMerchantScope(claims: TokenPayload, merchantId: string): void {
  if (claims.merchantId !== merchantId) throw Errors.forbidden('Token não pertence a este estabelecimento.');
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly limitPerMinute: number;

  constructor(limitPerMinute: number) {
    this.limitPerMinute = limitPerMinute;
  }

  consume(key: string, now = Date.now()): boolean {
    const windowStart = now - 60_000;
    const list = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    if (list.length >= this.limitPerMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.gc(now);
    return true;
  }

  private gc(now: number): void {
    for (const [key, list] of this.hits) {
      if (!list.length || list[list.length - 1] < now - 60_000) this.hits.delete(key);
    }
  }
}

export function verifyPixWebhook(config: AppConfig, timestamp: string, signature: string, rawBody: string): void {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) {
    throw Errors.unauthorized('Webhook expirado.');
  }
  const expected = hmacHex(providerSecret(config), `${timestamp}.${rawBody}`);
  if (!constantTimeEqualHex(signature, expected)) throw Errors.unauthorized('Assinatura de webhook inválida.');
}

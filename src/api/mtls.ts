import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit } from '../kernel/db.ts';
import { AppError, Errors, isAppError } from '../kernel/errors.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { log } from '../kernel/logger.ts';
import { metrics } from '../kernel/metrics.ts';
import type { TransactionService } from '../modules/transactions.ts';
import type { SlidingWindowLimiter } from './security.ts';
import { resolveTerminal, type PeerCertificate } from './cert.ts';

const METHODS = ['CREDIT', 'DEBIT', 'PIX', 'VOUCHER'] as const;

export interface SecureCheckoutBody {
  amountCents: number;
  method: string;
  installments?: number;
  paymentToken?: string;
  description?: string;
  items?: Array<{ name?: string; ncm?: string; quantity?: number; unitPriceCents?: number }>;
}

export interface SecureCheckoutDeps {
  config: AppConfig;
  db: Db;
  transactions: TransactionService;
  limiter?: SlidingWindowLimiter;
}

export interface SecureCheckoutInput {
  cert: PeerCertificate | undefined;
  body: SecureCheckoutBody;
  idempotencyKey: string;
  rawBody: string;
}

export interface SecureCheckoutOutput {
  statusCode: number;
  replayed: boolean;
  payload: Record<string, unknown>;
}

function validateBody(body: SecureCheckoutBody): SecureCheckoutBody {
  const amountCents = Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000) {
    throw Errors.validation('amountCents deve ser inteiro entre 1 e 100000000.');
  }
  const method = String(body.method ?? '').toUpperCase();
  if (!METHODS.includes(method as (typeof METHODS)[number])) {
    throw new AppError('INVALID_METHOD', 'Meio de pagamento inválido.', 422);
  }
  if (method !== 'PIX' && !body.paymentToken) {
    throw Errors.validation('paymentToken P2PE é obrigatório para cartão. PAN em claro é recusado.');
  }
  return { ...body, amountCents, method };
}

/**
 * Núcleo testável do checkout mTLS: autentica o terminal pelo certificado,
 * aplica idempotência e autoriza a venda pelo mesmo pipeline do /v1/transactions.
 */
export function authorizeSecureCheckout(
  deps: SecureCheckoutDeps,
  input: SecureCheckoutInput,
): SecureCheckoutOutput {
  const { db, config, transactions } = deps;
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 128) {
    throw Errors.validation('Header Idempotency-Key obrigatório (8 a 128 caracteres).');
  }

  const terminal = resolveTerminal(db, input.cert, { requireFingerprint: config.isProduction });
  if (deps.limiter && !deps.limiter.consume(`mtls:${terminal.id}`)) throw Errors.rateLimited();

  const body = validateBody(input.body);
  const requestHash = sha256Hex(input.rawBody || JSON.stringify(body));
  const scope = `mtls:${terminal.id}`;
  const existing = db
    .prepare('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE scope = ? AND key = ?')
    .get(scope, key) as { request_hash: string; status_code: number; response_json: string } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
    }
    return { statusCode: existing.status_code, replayed: true, payload: JSON.parse(existing.response_json) };
  }

  const result = transactions.createSale({
    merchantId: terminal.merchantId,
    terminalId: terminal.id,
    amountCents: body.amountCents,
    method: body.method,
    installments: body.installments,
    paymentToken: body.paymentToken,
    description: body.description,
    items: body.items,
    source: body.method === 'PIX' ? 'PIX' : 'CARD',
  });

  const payload = {
    ...result,
    secured_by: 'mTLS',
    terminal: {
      id: terminal.id,
      serial: terminal.serial,
      certificate_fingerprint: terminal.fingerprint,
      registered_fingerprint: terminal.certFingerprint,
    },
  };

  db.prepare(
    `INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response_json, created_at)
     VALUES (?, ?, ?, 201, ?, ?)`,
  ).run(scope, key, requestHash, JSON.stringify(payload), new Date().toISOString());
  audit(db, terminal.id, 'SECURE_CHECKOUT_MTLS', result.transaction.id, {
    serial: terminal.serial,
    fingerprint: terminal.fingerprint,
    amountCents: body.amountCents,
  });
  metrics.inc('sales_total', { status: result.status, method: result.transaction.method });

  return { statusCode: 201, replayed: false, payload };
}

const checkoutSchema = {
  type: 'object',
  required: ['amountCents', 'method'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    method: { type: 'string', enum: ['CREDIT', 'DEBIT', 'PIX', 'VOUCHER', 'credit', 'debit', 'pix', 'voucher'] },
    installments: { type: 'integer', minimum: 1, maximum: 12 },
    paymentToken: { type: 'string', maxLength: 128 },
    description: { type: 'string', maxLength: 120 },
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 120 },
          ncm: { type: 'string', maxLength: 8 },
          quantity: { type: 'number', minimum: 0.0001, maximum: 100_000 },
          unitPriceCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
        },
      },
    },
  },
} as const;

function sendError(reply: FastifyReply, error: Error & { statusCode?: number; validation?: unknown }): void {
  const appError = isAppError(error)
    ? error
    : error.validation
      ? Errors.validation('Payload inválido.', error.validation)
      : error.statusCode === 400
        ? Errors.validation(error.message)
        : Errors.internal();
  if (appError.status >= 500) log.error('mtls.error', { message: error.message, stack: error.stack });
  reply.status(appError.status).send({
    error: { code: appError.code, message: appError.message, details: appError.details ?? undefined },
  });
}

/**
 * Cria o listener HTTPS mutual-TLS. As chaves são lidas apenas em runtime, a
 * partir dos caminhos configurados por variável de ambiente.
 */
export function buildMtlsApp(deps: SecureCheckoutDeps & { logger?: boolean }): FastifyInstance {
  const tls = deps.config.mtls;
  if (!tls) {
    throw new Error('mTLS não configurado: informe MTLS_KEY_PATH, MTLS_CERT_PATH e MTLS_CA_PATH.');
  }
  const app = Fastify({
    logger: deps.logger ?? true,
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
    https: {
      key: readFileSync(tls.keyPath),
      cert: readFileSync(tls.certPath),
      ca: readFileSync(tls.caPath),
      requestCert: tls.requestCert,
      rejectUnauthorized: tls.rejectUnauthorized,
    },
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : '';
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) =>
    sendError(reply, error),
  );
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'xpartner-bank-mtls',
    mutual_tls: true,
  }));

  app.post('/v1/secure-checkout', { schema: { body: checkoutSchema } }, async (request, reply) => {
    const socket = (request.raw as { socket?: { getPeerCertificate?: () => PeerCertificate } }).socket;
    const cert = socket?.getPeerCertificate?.();
    const output = authorizeSecureCheckout(deps, {
      cert,
      body: request.body as SecureCheckoutBody,
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
      rawBody: (request as FastifyRequest & { rawBody?: string }).rawBody ?? '',
    });
    if (output.replayed) reply.header('x-idempotent-replayed', 'true');
    return reply.status(output.statusCode).send(output.payload);
  });

  return app;
}

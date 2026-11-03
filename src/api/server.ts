import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import type { EventBus, OutboxRelay } from '../kernel/bus.ts';
import { isAppError, AppError, Errors } from '../kernel/errors.ts';
import { sha256Hex } from '../kernel/crypto.ts';
import { formatBRL } from '../kernel/money.ts';
import { log } from '../kernel/logger.ts';
import { metrics } from '../kernel/metrics.ts';
import { trialBalance, listBalances } from '../domain/ledger.ts';
import { listAcquirers } from '../domain/routing.ts';
import { riskGraphStats } from '../domain/risk.ts';
import { buildOverview } from '../domain/overview.ts';
import { devTokenFor } from '../domain/vault.ts';
import { publicTransaction } from '../modules/transactions.ts';
import type { TransactionService } from '../modules/transactions.ts';
import type { PixService } from '../modules/pix.ts';
import type { FiscalWorker } from '../modules/fiscal-worker.ts';
import type { SettlementWorker } from '../modules/settlement-worker.ts';
import type { NotificationHub } from '../modules/notifications.ts';
import type { TokenizationHub } from '../modules/tokenization.ts';
import type { Web3Hub } from '../modules/web3.ts';
import type { AladdinEngine } from '../modules/aladdin.ts';
import type { CrossChainHub } from '../modules/crosschain.ts';
import type { CustomerService } from '../modules/customers.ts';
import type { BillingService } from '../modules/billing.ts';
import type { SubscriptionService } from '../modules/subscriptions.ts';
import type { OpenFinanceService } from '../modules/openfinance.ts';
import type { InvestmentService } from '../modules/investments.ts';
import { BankService, validateAccountNumber } from '../modules/bank.ts';
import type { BankAuthService } from '../modules/bank-auth.ts';
import type { BankPixService } from '../modules/bank-pix.ts';
import type { BankCreditService } from '../modules/bank-credit.ts';
import type { BankPdvService } from '../modules/bank-pdv.ts';
import type { BankFxService } from '../modules/bank-fx.ts';
import type { RsfnService } from '../modules/rsfn.ts';
import { clearSessionCookie, sessionCookie } from '../modules/bank-auth.ts';
import { buildReadiness } from '../modules/readiness.ts';
import { registerTokenizationRoutes } from './tokenization-routes.ts';
import { registerWeb3Routes } from './web3-routes.ts';
import { registerAladdinRoutes } from './aladdin-routes.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from '../modules/seed.ts';
import {
  assertMerchantScope,
  authenticateBearer,
  DeviceAuthenticator,
  issueMerchantToken,
  SlidingWindowLimiter,
  verifyPixWebhook,
} from './security.ts';

export interface AppContext {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  relay: OutboxRelay;
  transactions: TransactionService;
  pix: PixService;
  fiscal: FiscalWorker;
  settlements: SettlementWorker;
  hub: NotificationHub;
  tokenization: TokenizationHub;
  web3: Web3Hub;
  aladdin: AladdinEngine;
  crosschain: CrossChainHub;
  customers: CustomerService;
  billing: BillingService;
  subscriptions: SubscriptionService;
  openfinance: OpenFinanceService;
  investments: InvestmentService;
  bank: BankService;
  bankAuth: BankAuthService;
  bankPix: BankPixService;
  bankCredit: BankCreditService;
  bankPdv: BankPdvService;
  bankFx: BankFxService;
  rsfn: RsfnService;
  authenticator: DeviceAuthenticator;
  limiter: SlidingWindowLimiter;
}

const transactionBodySchema = {
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

const demoSaleSchema = {
  type: 'object',
  required: ['amountCents', 'method'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    method: { type: 'string', enum: ['CREDIT', 'DEBIT', 'PIX', 'VOUCHER'] },
    installments: { type: 'integer', minimum: 1, maximum: 12 },
    brand: { type: 'string', maxLength: 20 },
    last4: { type: 'string', pattern: '^[0-9]{4}$' },
    description: { type: 'string', maxLength: 120 },
    terminalId: { type: 'string', maxLength: 64 },
  },
} as const;

const customerBodySchema = {
  type: 'object',
  required: ['name', 'document'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 },
    document: { type: 'string', minLength: 11, maxLength: 20 },
    email: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 20 },
    city: { type: 'string', maxLength: 60 },
    uf: { type: 'string', maxLength: 2 },
  },
} as const;

const customerUpdateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 },
    email: { type: ['string', 'null'], maxLength: 120 },
    phone: { type: ['string', 'null'], maxLength: 20 },
    city: { type: ['string', 'null'], maxLength: 60 },
    uf: { type: ['string', 'null'], maxLength: 2 },
    status: { type: 'string', enum: ['ACTIVE', 'BLOCKED'] },
  },
} as const;

const boletoBodySchema = {
  type: 'object',
  required: ['amountCents'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string', maxLength: 120 },
    customerId: { type: 'string', maxLength: 64 },
    payerName: { type: 'string', maxLength: 80 },
    payerDocument: { type: 'string', maxLength: 20 },
    terminalId: { type: 'string', maxLength: 64 },
  },
} as const;

const linkBodySchema = {
  type: 'object',
  required: ['amountCents', 'kind'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    kind: { type: 'string', enum: ['PIX', 'BOLETO', 'pix', 'boleto'] },
    description: { type: 'string', maxLength: 120 },
    customerId: { type: 'string', maxLength: 64 },
    dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    payerName: { type: 'string', maxLength: 80 },
    payerDocument: { type: 'string', maxLength: 20 },
    expiresInSeconds: { type: 'integer', minimum: 60, maximum: 604_800 },
    terminalId: { type: 'string', maxLength: 64 },
  },
} as const;

const subscriptionBodySchema = {
  type: 'object',
  required: ['customerId', 'description', 'amountCents', 'period', 'method'],
  additionalProperties: false,
  properties: {
    customerId: { type: 'string', maxLength: 64 },
    description: { type: 'string', minLength: 2, maxLength: 120 },
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    period: { type: 'string', enum: ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'weekly', 'monthly', 'quarterly', 'yearly'] },
    method: { type: 'string', enum: ['PIX', 'BOLETO', 'pix', 'boleto'] },
    startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    terminalId: { type: 'string', maxLength: 64 },
  },
} as const;

const consentBodySchema = {
  type: 'object',
  required: ['provider', 'providerCode', 'kind', 'account'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 2, maxLength: 60 },
    providerCode: { type: 'string', minLength: 2, maxLength: 30 },
    kind: { type: 'string', enum: ['DATA_SHARING', 'EXTERNAL_DEBIT', 'PAYMENT_INITIATION'] },
    customerId: { type: 'string', maxLength: 64 },
    scopes: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
    expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
    account: {
      type: 'object',
      required: ['type', 'branch', 'number'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['CHECKING', 'SAVINGS', 'PAYMENT'] },
        branch: { type: 'string', minLength: 1, maxLength: 10 },
        number: { type: 'string', minLength: 4, maxLength: 24 },
        holderName: { type: 'string', maxLength: 80 },
        holderDocument: { type: 'string', maxLength: 20 },
        balanceCents: { type: 'integer', minimum: 0, maximum: 100_000_000_000 },
      },
    },
  },
} as const;

const externalDebitBodySchema = {
  type: 'object',
  required: ['consentId', 'amountCents'],
  additionalProperties: false,
  properties: {
    consentId: { type: 'string', maxLength: 64 },
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    description: { type: 'string', maxLength: 120 },
    dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
} as const;

const ofPaymentBodySchema = {
  type: 'object',
  required: ['consentId', 'amountCents', 'pixKey'],
  additionalProperties: false,
  properties: {
    consentId: { type: 'string', maxLength: 64 },
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    pixKey: { type: 'string', minLength: 5, maxLength: 120 },
    description: { type: 'string', maxLength: 120 },
  },
} as const;

const contributionBodySchema = {
  type: 'object',
  required: ['productId', 'amountCents'],
  additionalProperties: false,
  properties: {
    productId: { type: 'string', maxLength: 64 },
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
  },
} as const;

const redemptionBodySchema = {
  type: 'object',
  required: ['positionId', 'amountCents'],
  additionalProperties: false,
  properties: {
    positionId: { type: 'string', maxLength: 64 },
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
  },
} as const;

const proventoBodySchema = {
  type: 'object',
  required: ['positionId', 'kind', 'grossCents', 'exDate', 'paymentDate'],
  additionalProperties: false,
  properties: {
    positionId: { type: 'string', maxLength: 64 },
    kind: { type: 'string', enum: ['DIVIDENDO', 'JCP', 'RENDIMENTO'] },
    grossCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    exDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    paymentDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
} as const;

const bankRegisterSchema = {
  type: 'object',
  required: ['name', 'document', 'email', 'password'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 },
    document: { type: 'string', minLength: 11, maxLength: 20 },
    email: { type: 'string', minLength: 5, maxLength: 120 },
    phone: { type: 'string', maxLength: 20 },
    password: { type: 'string', minLength: 10, maxLength: 128 },
    bootstrapToken: { type: 'string', maxLength: 200 },
  },
} as const;

const bankLoginSchema = {
  type: 'object',
  required: ['identifier', 'password'],
  additionalProperties: false,
  properties: {
    identifier: { type: 'string', minLength: 3, maxLength: 120 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const bankPasswordSchema = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
    newPassword: { type: 'string', minLength: 10, maxLength: 128 },
  },
} as const;

const bankTransferSchema = {
  type: 'object',
  required: ['amountCents', 'recipient'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    description: { type: 'string', maxLength: 120 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    recipient: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        accountNumber: { type: 'string', maxLength: 24 },
        document: { type: 'string', maxLength: 20 },
        email: { type: 'string', maxLength: 120 },
        pixKey: { type: 'string', maxLength: 120 },
      },
    },
  },
} as const;

const bankPixKeySchema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', maxLength: 10 },
    value: { type: 'string', minLength: 1, maxLength: 100 },
    label: { type: 'string', maxLength: 40 },
  },
} as const;

const bankPixEvpSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', maxLength: 40 },
  },
} as const;

const bankFundingSchema = {
  type: 'object',
  required: ['amountCents'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    targetUserId: { type: 'string', maxLength: 64 },
    description: { type: 'string', maxLength: 120 },
  },
} as const;

const bankCapitalSchema = {
  type: 'object',
  required: ['targetUserId', 'amountCents'],
  additionalProperties: false,
  properties: {
    targetUserId: { type: 'string', minLength: 1, maxLength: 64 },
    amountCents: { type: 'integer', minimum: 1, maximum: 50_000_000_000_000 },
    description: { type: 'string', maxLength: 120 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
  },
} as const;

const bankFxFundSchema = {
  type: 'object',
  required: ['targetUserId', 'amountCents'],
  additionalProperties: false,
  properties: {
    targetUserId: { type: 'string', minLength: 1, maxLength: 64 },
    currency: { type: 'string', enum: ['USD'] },
    amountCents: { type: 'integer', minimum: 1, maximum: 2_000_000_000_000 },
    memo: { type: 'string', maxLength: 120 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
  },
} as const;

const bankCreditQuoteSchema = {
  type: 'object',
  required: ['product', 'amountCents'],
  additionalProperties: false,
  properties: {
    product: { type: 'string', enum: ['ANTECIPACAO', 'EMPRESTIMO', 'antecipacao', 'emprestimo'] },
    amountCents: { type: 'integer', minimum: 1, maximum: 5_000_000 },
    installments: { type: 'integer', minimum: 1, maximum: 12 },
  },
} as const;

const bankCreditContractSchema = {
  type: 'object',
  required: ['product', 'amountCents'],
  additionalProperties: false,
  properties: {
    ...bankCreditQuoteSchema.properties,
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
  },
} as const;

const bankPdvSaleSchema = {
  type: 'object',
  required: ['amountCents', 'method'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    method: { type: 'string', enum: ['CREDIT', 'DEBIT', 'PIX', 'VOUCHER', 'credit', 'debit', 'pix', 'voucher'] },
    installments: { type: 'integer', minimum: 1, maximum: 12 },
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
          unitPriceCents: { type: 'integer', minimum: 1, maximum: 10_000_000 },
        },
      },
    },
  },
} as const;

const rsfnValidateSchema = {
  type: 'object',
  required: ['xml'],
  additionalProperties: false,
  properties: {
    xml: { type: 'string', minLength: 10, maxLength: 20_000 },
  },
} as const;

const rsfnTransferSchema = {
  type: 'object',
  required: ['amountCents', 'destination'],
  additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    description: { type: 'string', maxLength: 120 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    clientCode: { type: 'string', maxLength: 8 },
    destination: {
      type: 'object',
      required: ['ispb', 'branch', 'account', 'document', 'name'],
      additionalProperties: false,
      properties: {
        ispb: { type: 'string', minLength: 8, maxLength: 8 },
        branch: { type: 'string', minLength: 1, maxLength: 10 },
        account: { type: 'string', minLength: 1, maxLength: 20 },
        document: { type: 'string', minLength: 11, maxLength: 20 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
  },
} as const;

const rsfnAckSchema = {
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['ACCEPT', 'REJECT'] },
    rejectionCode: { type: 'string', maxLength: 20 },
    rejectionReason: { type: 'string', maxLength: 200 },
  },
} as const;

const OPERATIONAL_LANDING = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>xPartner Bank — API em produção</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050908; color: #e9f5ef;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(560px, 90vw); padding: 40px; border: 1px solid rgba(148,255,205,.14);
         border-radius: 20px; background: linear-gradient(160deg, #0b1613, #060c0a); }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: #5ef2b2; color: #07110d;
          display: grid; place-items: center; font-weight: 800; font-size: 22px; }
  h1 { font-size: 26px; margin: 20px 0 8px; }
  p { color: #87a397; line-height: 1.6; margin: 0 0 22px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  a { display: flex; justify-content: space-between; padding: 12px 16px; border-radius: 12px;
      border: 1px solid rgba(148,255,205,.12); color: #c9f76f; text-decoration: none; font-size: 14px; }
  a span { color: #5d766c; }
  footer { margin-top: 26px; font-size: 12px; color: #5d766c; }
</style>
</head>
<body>
<main>
  <div class="mark">X</div>
  <h1>xPartner Bank</h1>
  <p>Ambiente de produção. O dashboard de demonstração fica disponível apenas com <code>DEMO_MODE=true</code>.</p>
  <ul>
    <li><a href="/health">Health check <span>GET /health</span></a></li>
    <li><a href="/health/ready">Readiness <span>GET /health/ready</span></a></li>
    <li><a href="/metrics">Métricas Prometheus <span>GET /metrics</span></a></li>
    <li><a href="/openapi.json">Contrato OpenAPI <span>GET /openapi.json</span></a></li>
  </ul>
  <footer>Autentique-se com Bearer token emitido pelo seu provedor de identidade para acessar /v1.</footer>
</main>
</body>
</html>`;

function publicMerchant(db: Db, merchantId: string) {
  return db
    .prepare('SELECT id, name, trade_name, document, mcc, city, uf, pix_key, status FROM merchants WHERE id = ?')
    .get(merchantId);
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config, db } = ctx;
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
    trustProxy: true,
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

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith('/v1')) {
      const key = String(request.headers['x-device-id'] ?? request.ip ?? 'anon');
      if (!ctx.limiter.consume(key)) {
        metrics.inc('http_rate_limited_total');
        throw Errors.rateLimited();
      }
    }
    (request as FastifyRequest & { startedAt?: number }).startedAt = Date.now();
    metrics.inc('http_requests_total', { method: request.method });
    reply.header('x-request-id', request.id);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const startedAt = (request as FastifyRequest & { startedAt?: number }).startedAt ?? Date.now();
    const elapsed = Date.now() - startedAt;
    metrics.observe('http_request_duration_ms', elapsed, {
      method: request.method,
      status: reply.statusCode,
    });
    reply.header('x-response-time', `${elapsed}ms`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:",
    );
    if (request.url.startsWith('/v1')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    const appError =
      isAppError(error)
        ? error
        : error.validation
          ? Errors.validation('Payload inválido.', error.validation)
          : error.statusCode === 400
            ? Errors.validation(error.message)
            : error.statusCode === 404
              ? Errors.notFound()
              : Errors.internal();
    if (appError.status >= 500) {
      log.error('http.error', {
        requestId: request.id,
        path: request.url,
        message: error.message,
        stack: error.stack,
      });
    }
    reply.status(appError.status).send({
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details ?? undefined,
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.', requestId: request.id } });
  });

  // Leitura dos módulos no próprio banco usa a sessão; escrita continua exigindo Bearer.
  const requireRead = (request: FastifyRequest) => {
    const authorization = String(request.headers.authorization ?? '');
    if (authorization.toLowerCase().startsWith('bearer ')) return authenticateBearer(config, request, 'demo:read');
    if (request.headers.cookie) {
      try {
        const auth = ctx.bankAuth.authenticate(request);
        const now = Math.floor(Date.now() / 1000);
        return { sub: auth.user.id, scope: 'demo:read', merchantId: auth.user.id, exp: now + 60, iat: now };
      } catch {
        // sem sessão válida: cai no erro padrão de credencial de integração
      }
    }
    return authenticateBearer(config, request, 'demo:read');
  };
  const requireWrite = (request: FastifyRequest) => authenticateBearer(config, request, 'demo:write');
  const assertDemo = (): void => {
    if (!config.demoMode) throw Errors.notFound();
  };

  app.get('/health/live', async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
  app.get('/health', async () => ({ status: 'ok', service: 'xpartner-bank', env: config.env }));
  app.get('/health/ready', async () => {
    db.prepare('SELECT 1').get();
    const pending = ctx.relay.pendingCount();
    metrics.gauge('outbox_pending_events', pending);
    return { status: pending > 5000 ? 'degraded' : 'ready', outboxPending: pending, demoMode: config.demoMode };
  });

  app.get('/v1/readiness', async () => buildReadiness(config));

  app.get('/metrics', async (request, reply) => {
    metrics.gauge('outbox_pending_events', ctx.relay.pendingCount());
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });

  app.get('/openapi.json', async () => ({
    openapi: '3.1.0',
    info: {
      title: 'xPartner Bank API',
      version: '1.0.0',
      description:
        'Core bancário com ledger de dupla entrada, autorização de cartões, Pix, antifraude em grafo e NFC-e em tempo real.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/v1/transactions': { post: { summary: 'Autoriza venda com idempotência e assinatura HMAC de dispositivo' } },
      '/v1/transactions/{id}': { get: { summary: 'Detalha transação, nota fiscal e liquidação' } },
      '/v1/overview': { get: { summary: 'KPIs do estabelecimento' } },
      '/v1/pix/charges': { post: { summary: 'Cria cobrança Pix (BR Code + CRC16)' } },
      '/v1/pix/webhook': { post: { summary: 'Webhook do PSP com assinatura HMAC' } },
      '/v1/settlements/{transactionId}/advance': { post: { summary: 'Antecipação preditiva de recebíveis' } },
      '/v1/fiscal/{transactionId}': { get: { summary: 'XML assinado, QR Code e DANFE' } },
      '/v1/demo/sales': { post: { summary: 'Simulador de venda da maquininha (apenas demo)' } },
      '/v1/customers': { get: { summary: 'Lista clientes do estabelecimento' }, post: { summary: 'Cadastra cliente com CPF/CNPJ validado' } },
      '/v1/customers/{id}': { get: { summary: 'Detalha cliente e boletos recentes' }, patch: { summary: 'Atualiza dados cadastrais ou bloqueia o cliente' }, delete: { summary: 'Remove o cliente da base ativa com histórico fiscal preservado' } },
      '/v1/boletos': { get: { summary: 'Lista boletos com status e vencimento' }, post: { summary: 'Emite boleto 077 com linha digitável válida' } },
      '/v1/boletos/{reference}': { get: { summary: 'Consulta boleto por id, nosso número, código de barras ou linha digitável' } },
      '/v1/boletos/{reference}/pay': { post: { summary: 'Baixa boleto e dispara liquidação e NFC-e (demo)' } },
      '/v1/boletos/{reference}/cancel': { post: { summary: 'Cancela boleto ainda não pago' } },
      '/v1/payment-links': { get: { summary: 'Lista links de pagamento' }, post: { summary: 'Cria link Pix ou boleto com checkout público' } },
      '/v1/payment-links/{code}': { get: { summary: 'Detalha link de pagamento' } },
      '/v1/payment-links/{code}/pay': { post: { summary: 'Liquida link em ambiente demo' } },
      '/v1/payment-links/{code}/cancel': { post: { summary: 'Cancela link ativo' } },
      '/v1/public/links/{code}': { get: { summary: 'Checkout público do link (sem autenticação)' } },
      '/v1/public/links/{code}/pay': { post: { summary: 'Simula pagamento do link (apenas demo)' } },
      '/v1/subscriptions': { get: { summary: 'Lista assinaturas recorrentes' }, post: { summary: 'Cria assinatura e primeira fatura' } },
      '/v1/subscriptions/{id}': { get: { summary: 'Detalha assinatura com faturas' } },
      '/v1/subscriptions/{id}/pause': { post: { summary: 'Pausa cobranças da assinatura' } },
      '/v1/subscriptions/{id}/resume': { post: { summary: 'Retoma assinatura pausada' } },
      '/v1/subscriptions/{id}/cancel': { post: { summary: 'Cancela assinatura' } },
      '/v1/subscription-invoices': { get: { summary: 'Lista faturas de assinatura' } },
      '/v1/subscription-invoices/{id}': { get: { summary: 'Detalha fatura com Pix ou boleto' } },
      '/v1/subscription-invoices/{id}/pay': { post: { summary: 'Baixa fatura de assinatura (demo)' } },
      '/v1/subscription-invoices/{id}/renew': { post: { summary: 'Gera nova cobrança Pix para fatura vencida' } },
      '/v1/statement': { get: { summary: 'Extrato do lojista com saldo e movimentações' } },
      '/v1/statement.csv': { get: { summary: 'Exporta extrato em CSV' } },
      '/v1/settlements': { get: { summary: 'Lista liquidações agendadas e pagas' } },
      '/v1/app/overview': { get: { summary: 'Payload consolidado do aplicativo bancário' } },
      '/v1/open-finance/overview': { get: { summary: 'KPIs de consentimentos, contas vinculadas, débitos e pagamentos' } },
      '/v1/open-finance/consents': { post: { summary: 'Cria consentimento com conta vinculada (dados, débito ou iniciação)' } },
      '/v1/open-finance/consents/{id}/authorize': { post: { summary: 'Autoriza consentimento pendente' } },
      '/v1/open-finance/consents/{id}/reject': { post: { summary: 'Recusa consentimento pendente' } },
      '/v1/open-finance/consents/{id}/revoke': { post: { summary: 'Revoga consentimento e encerra a conta vinculada' } },
      '/v1/open-finance/debits': { post: { summary: 'Agenda débito externo em conta vinculada' } },
      '/v1/open-finance/debits/{id}/settle': { post: { summary: 'Liquida débito externo com NFC-e e recebível (demo)' } },
      '/v1/open-finance/debits/{id}/cancel': { post: { summary: 'Cancela débito externo agendado' } },
      '/v1/open-finance/payments': { post: { summary: 'Inicia pagamento Pix via consentimento de iniciação' } },
      '/v1/open-finance/payments/{id}/settle': { post: { summary: 'Liquida pagamento iniciado com tarifa e lançamento contábil (demo)' } },
      '/v1/open-finance/payments/{id}/cancel': { post: { summary: 'Cancela pagamento pendente' } },
      '/v1/investments/overview': { get: { summary: 'KPIs de posições, aportes e proventos' } },
      '/v1/investments/products': { get: { summary: 'Lista produtos de investimento disponíveis' } },
      '/v1/investments/contributions': { post: { summary: 'Aplica aporte em produto com débito do saldo disponível' } },
      '/v1/investments/redemptions': { post: { summary: 'Resgata posição respeitando liquidez' } },
      '/v1/investments/positions': { get: { summary: 'Lista posições de investimento do lojista' } },
      '/v1/investments/proventos': { get: { summary: 'Lista proventos com retenção de IR' }, post: { summary: 'Agenda provento (dividendo, JCP ou rendimento)' } },
      '/v1/tokenization/overview': { get: { summary: 'KPIs de tokenização, bioativos, DePIN, DAO e agentes' } },
      '/v1/tokenization/assets': { get: { summary: 'Lista ativos tokenizados' }, post: { summary: 'Cria ativo com lastro 1:1' } },
      '/v1/tokenization/assets/{id}/mint': { post: { summary: 'Emite unidades com lançamento de lastro' } },
      '/v1/tokenization/assets/{id}/transfer': { post: { summary: 'Transfere unidades entre carteiras' } },
      '/v1/tokenization/assets/{id}/redeem': { post: { summary: 'Resgata unidades e baixa o lastro' } },
      '/v1/tokenization/bio': { get: { summary: 'Bioativos com consentimento verificável' }, post: { summary: 'Registra bioativo pendente de admissão DAO' } },
      '/v1/tokenization/bio/{id}/royalties': { post: { summary: 'Paga royalty vinculado ao consentimento' } },
      '/v1/tokenization/depin/devices': { get: { summary: 'Dispositivos DePIN registrados' }, post: { summary: 'Registra dispositivo com prova física' } },
      '/v1/tokenization/dao/proposals': { get: { summary: 'Propostas de governança ADLA' }, post: { summary: 'Abre proposta ponderada por ADLA' } },
      '/v1/tokenization/agents/evaluate': { post: { summary: 'Avalia ação de agente contra guardrails' } },
      '/v1/tokenization/bridges/quote': { post: { summary: 'Cotação de ponte Pix, Lightning, Drex ou TCA' } },
      '/v1/tokenization/zk/prove': { post: { summary: 'Prova Merkle de inclusão de credencial' } },
      '/v1/web3/overview': { get: { summary: 'KPIs de DVP, crédito agro, ZK, agentes e paymaster' } },
      '/v1/web3/networks': { get: { summary: 'Redes, appchains e subnets registradas' }, post: { summary: 'Registra rede com contratos e governança' } },
      '/v1/web3/networks/{id}': { get: { summary: 'Detalhe da rede por id ou chainId' } },
      '/v1/web3/oracle/feeds': { get: { summary: 'Feeds de oráculo com última cotação' }, post: { summary: 'Registra feed com staleness máximo' } },
      '/v1/web3/oracle/prices': { post: { summary: 'Publica rodada de preço assinada e ancorada' } },
      '/v1/web3/oracle/prices/{symbol}': { get: { summary: 'Lê preço validando staleness' } },
      '/v1/web3/dvp/offers': { get: { summary: 'Ofertas DVP abertas e histórico' }, post: { summary: 'Cria oferta DVP com digest tipado e nonce' } },
      '/v1/web3/dvp/offers/{id}': { get: { summary: 'Detalhe da oferta DVP' } },
      '/v1/web3/dvp/offers/{id}/accept': { post: { summary: 'Aceita oferta e liquida atomicamente com partidas dobradas' } },
      '/v1/web3/dvp/offers/{id}/cancel': { post: { summary: 'Cancela oferta própria ainda aberta' } },
      '/v1/web3/dvp/trades': { get: { summary: 'Trades DVP liquidados' } },
      '/v1/web3/agro/contracts': { get: { summary: 'Contratos de crédito agro com colateral tokenizado' }, post: { summary: 'Abre crédito agro com LTV, oráculo e escrow' } },
      '/v1/web3/agro/contracts/{id}': { get: { summary: 'Detalhe do contrato agro com LTV atual' } },
      '/v1/web3/agro/contracts/{id}/repay': { post: { summary: 'Amortiza ou quita contrato agro liberando escrow' } },
      '/v1/web3/agro/contracts/{id}/liquidate': { post: { summary: 'Liquidação permissionless acima do limiar de LTV' } },
      '/v1/web3/zk/attestations': { get: { summary: 'Atestações de predicado emitidas' }, post: { summary: 'Emite atestação assinada com expiração' } },
      '/v1/web3/zk/attestations/{id}/revoke': { post: { summary: 'Revoga atestação' } },
      '/v1/web3/zk/verify': { post: { summary: 'Verifica predicado com nullifier e anti-replay' } },
      '/v1/web3/zk/verifications': { get: { summary: 'Histórico de verificações ZK' } },
      '/v1/web3/agents/sessions': { get: { summary: 'Sessões de agente com política e teto' }, post: { summary: 'Emite session key com seletores e teto de gasto' } },
      '/v1/web3/agents/sessions/{id}/authorize': { post: { summary: 'Autoriza ação de agente contra política, sessão e teto' } },
      '/v1/web3/agents/sessions/{id}/revoke': { post: { summary: 'Revoga session key imediatamente' } },
      '/v1/web3/paymaster/budgets': { get: { summary: 'Orçamentos de patrocínio de gas' }, post: { summary: 'Cria orçamento de paymaster com teto por UserOp' } },
      '/v1/web3/paymaster/ops': { get: { summary: 'UserOps patrocinadas' } },
      '/v1/web3/paymaster/sponsor': { post: { summary: 'Patrocina UserOp com anti-replay por hash' } },
      '/v1/web3/aladdin/overview': { get: { summary: 'Risco, provas Groth16, empréstimos algorítmicos e política' } },
      '/v1/web3/aladdin/risk/metrics': { get: { summary: 'Histórico de métricas de risco do titular' }, post: { summary: 'Injeta métricas de risco assinadas por operador/oráculo' } },
      '/v1/web3/aladdin/risk/simulate': { post: { summary: 'Monte Carlo determinístico de VaR, volatilidade e score' } },
      '/v1/web3/aladdin/zk/prove': { post: { summary: 'Gera prova Groth16 de patrimônio (demo/client SDK)' } },
      '/v1/web3/aladdin/zk/proofs': { get: { summary: 'Provas Groth16 registradas' }, post: { summary: 'Verifica e registra prova Groth16 com anti-replay' } },
      '/v1/web3/aladdin/loans': { get: { summary: 'Empréstimos algorítmicos do titular' }, post: { summary: 'Abre crédito com score, VaR e prova ZK' } },
      '/v1/web3/aladdin/loans/{id}': { get: { summary: 'Detalhe do empréstimo algorítmico' } },
      '/v1/web3/aladdin/loans/{id}/repay': { post: { summary: 'Amortiza ou quita o empréstimo algorítmico' } },
      '/v1/web3/ccip/lanes': { get: { summary: 'Lanes CCIP source→dest' }, post: { summary: 'Registra lane CCIP com router, receiver e seletores' } },
      '/v1/web3/ccip/liquidity': { get: { summary: 'Liquidez P2P por lane e ativo' }, post: { summary: 'Anuncia liquidez de solver no destino' } },
      '/v1/web3/ccip/messages': { get: { summary: 'Mensagens CCIP emitidas e liquidadas' } },
      '/v1/web3/intents': { get: { summary: 'Intents cross-chain do titular' }, post: { summary: 'Abre intent com escrow, mínimo e prazo' } },
      '/v1/web3/intents/overview': { get: { summary: 'KPIs de intents, liquidez e entrega' } },
      '/v1/web3/intents/{id}': { get: { summary: 'Intent com cotações e mensagem CCIP' } },
      '/v1/web3/intents/{id}/quotes': { post: { summary: 'Registra cotação de solver com score de IA' } },
      '/v1/web3/intents/{id}/select': { post: { summary: 'Seleciona a melhor cotação por score auditável' } },
      '/v1/web3/intents/{id}/execute': { post: { summary: 'Liquida intent, move escrow e emite mensagem CCIP' } },
      '/v1/web3/intents/{id}/cancel': { post: { summary: 'Cancela intent e devolve o escrow' } },
      '/v1/bank/status': { get: { summary: 'Estado público do cadastro e do bootstrap do banco' } },
      '/v1/readiness': { get: { summary: 'Diagnóstico do que falta para operar com dinheiro real' } },
      '/v1/bank/auth/register': { post: { summary: 'Cadastro com CPF/CNPJ validado e aprovação do administrador' } },
      '/v1/bank/auth/login': { post: { summary: 'Login com sessão HttpOnly, CSRF e Bearer' } },
      '/v1/bank/auth/logout': { post: { summary: 'Encerra a sessão bancária' } },
      '/v1/bank/auth/change-password': { post: { summary: 'Troca a própria senha e revoga outras sessões' } },
      '/v1/bank/me': { get: { summary: 'Perfil, conta e token CSRF da sessão' } },
      '/v1/bank/account': { get: { summary: 'Conta, saldo e limites' } },
      '/v1/bank/statement': { get: { summary: 'Extrato do livro-razão com saldo após cada lançamento' } },
      '/v1/bank/statement.csv': { get: { summary: 'Extrato em CSV' } },
      '/v1/bank/recipients/lookup': { get: { summary: 'Consulta exata de favorecido por conta, CPF/CNPJ ou e-mail' } },
      '/v1/bank/transfers': { post: { summary: 'Transferência interna real entre contas do xPartner Bank' } },
      '/v1/bank/transfers/{id}': { get: { summary: 'Comprovante com hash de integridade e partidas dobradas' } },
      '/v1/bank/accounts/validate': { get: { summary: 'Valida dígito verificador FEBRABAN (módulo 11) de uma conta' } },
      '/v1/bank/pix/keys': { get: { summary: 'Chaves Pix do titular' }, post: { summary: 'Registra chave Pix (CPF/CNPJ do titular, e-mail, telefone ou EVP)' } },
      '/v1/bank/pix/keys/evp': { post: { summary: 'Gera chave Pix aleatória (EVP/UUID v4)' } },
      '/v1/bank/pix/keys/{id}': { delete: { summary: 'Remove (soft delete) uma chave Pix do titular' } },
      '/v1/bank/pix/keys/{id}/brcode': { get: { summary: 'BR Code EMV com CRC16, com valor opcional' } },
      '/v1/bank/pix/lookup': { get: { summary: 'Consulta chave Pix ativa com dados mascarados' } },
      '/v1/bank/admin/pix/keys': { get: { summary: 'Todas as chaves Pix com titular mascarado (admin)' } },
      '/v1/bank/credit/score': { get: { summary: 'Score de crédito interno e limite sugerido' } },
      '/v1/bank/credit/line': { get: { summary: 'Linha de crédito: score, exposição e limite disponível' } },
      '/v1/bank/credit/quote': { post: { summary: 'Simulação de antecipação ou empréstimo com agenda de parcelas' } },
      '/v1/bank/credit/contracts': { get: { summary: 'Contratos de crédito do titular' }, post: { summary: 'Contrata crédito com desembolso da tesouraria no ledger' } },
      '/v1/bank/credit/contracts.csv': { get: { summary: 'Exporta contratos de crédito em CSV' } },
      '/v1/bank/credit/contracts/{id}': { get: { summary: 'Contrato de crédito com agenda completa' } },
      '/v1/bank/credit/contracts/{id}/installments/{number}/pay': { post: { summary: 'Paga uma parcela do contrato' } },
      '/v1/bank/credit/contracts/{id}/settle': { post: { summary: 'Liquida antecipadamente com desconto de juros futuros' } },
      '/v1/bank/pdv/sales': { get: { summary: 'Vendas do PDV com NFC-e e liquidação' }, post: { summary: 'Venda presencial demo com NFC-e síncrona e crédito do líquido' } },
      '/v1/bank/pdv/sales.csv': { get: { summary: 'Exporta vendas do PDV em CSV' } },
      '/v1/bank/pdv/sales/{id}/fiscal': { get: { summary: 'Documento fiscal da venda (XML, DANFE e ESC-POS)' } },
      '/v1/bank/pdv/sales/{id}/xml': { get: { summary: 'Download do XML da NFC-e' } },
      '/v1/bank/demo/credit': { post: { summary: 'Aporte da tesouraria para testes (somente demo)' } },
      '/v1/bank/demo/capital': { post: { summary: 'Aporte de capital de laboratório com lastro contábil (admin, demo)' } },
      '/v1/bank/fx/wallets': { get: { summary: 'Carteiras internacionais do titular (USD, demo)' } },
      '/v1/bank/fx/wallets/{currency}/statement': { get: { summary: 'Extrato da carteira internacional com saldo após cada partida' } },
      '/v1/bank/demo/fx': { post: { summary: 'Aporte internacional de laboratório da tesouraria USD (admin, demo)' } },
      '/v1/bank/rsfn/config': { get: { summary: 'Configuração do canal RSFN/PAG0004 e limites' } },
      '/v1/bank/rsfn/validate': { post: { summary: 'Valida um XML PAG0004 sem executar movimento' } },
      '/v1/bank/rsfn/transfers': { post: { summary: 'Transferência interbancária RSFN com XML PAG0004 e partidas dobradas' } },
      '/v1/bank/rsfn/messages': { get: { summary: 'Mensagens RSFN do titular' } },
      '/v1/bank/rsfn/messages/{id}': { get: { summary: 'Detalhe da mensagem RSFN com XML' } },
      '/v1/bank/rsfn/messages/{id}/xml': { get: { summary: 'Download do XML PAG0004' } },
      '/v1/bank/rsfn/messages/{id}/ack': { post: { summary: 'Simula retorno da RSFN (aceite/recusa) em demo' } },
      '/v1/bank/rsfn/pag0004.xsd': { get: { summary: 'XSD do subconjunto PAG0004 usado pelo banco' } },
      '/v1/bank/admin/rsfn/messages': { get: { summary: 'Todas as mensagens RSFN (admin)' } },
      '/v1/bank/admin/overview': { get: { summary: 'KPIs, pendências e auditoria (admin)' } },
      '/v1/bank/admin/users': { get: { summary: 'Lista cadastros com filtros (admin)' } },
      '/v1/bank/admin/users/{id}': { get: { summary: 'Detalhe do cliente, extrato e score (admin)' }, delete: { summary: 'Exclusão lógica com saldo zero (admin)' } },
      '/v1/bank/admin/users/{id}/approve': { post: { summary: 'Aprova cadastro pendente e cria conta (admin)' } },
      '/v1/bank/admin/users/{id}/reject': { post: { summary: 'Recusa cadastro pendente (admin)' } },
      '/v1/bank/admin/users/{id}/block': { post: { summary: 'Bloqueia usuário e revoga sessões (admin)' } },
      '/v1/bank/admin/users/{id}/unblock': { post: { summary: 'Reativa usuário bloqueado (admin)' } },
      '/v1/bank/admin/users/{id}/reset-password': { post: { summary: 'Gera senha temporária e revoga sessões (admin)' } },
      '/v1/bank/admin/audit': { get: { summary: 'Trilha de auditoria bancária (admin)' } },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        deviceHmac: { type: 'apiKey', in: 'header', name: 'x-signature' },
      },
    },
  }));

  // ── Demo / sessão ─────────────────────────────────────────────────────────
  app.post('/v1/auth/demo', async (request) => {
    assertDemo();
    const body = (request.body ?? {}) as { merchantId?: string };
    const merchantId = body.merchantId ?? DEMO_MERCHANT_ID;
    const merchant = publicMerchant(db, merchantId);
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    const token = issueMerchantToken(config, merchantId);
    return { token, tokenType: 'Bearer', expiresIn: config.tokenTtlSeconds, merchant };
  });

  app.get('/v1/demo/bootstrap', async (request) => {
    assertDemo();
    const merchant = publicMerchant(db, DEMO_MERCHANT_ID);
    if (!merchant) throw Errors.notFound('Estabelecimento de demonstração não encontrado.');
    const terminals = db
      .prepare('SELECT id, serial, model, status FROM terminals WHERE merchant_id = ?')
      .all(DEMO_MERCHANT_ID);
    const token = issueMerchantToken(config, DEMO_MERCHANT_ID);
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: config.tokenTtlSeconds,
      merchant,
      terminals,
      acquirers: listAcquirers(db).map((acquirer) => ({
        id: acquirer.id,
        name: acquirer.name,
        debitBps: acquirer.debitBps,
        creditBps: acquirer.creditBps,
        pixBps: acquirer.pixBps,
        successRate: acquirer.successRate,
      })),
      suggestions: [
        { name: 'Café especial 1kg', amountCents: 4990, ncm: '09012100' },
        { name: 'Combo almoço', amountCents: 3890, ncm: '21069090' },
        { name: 'Cesta de café da manhã', amountCents: 12900, ncm: '21069090' },
        { name: 'Vinho reserva', amountCents: 18990, ncm: '22042100' },
      ],
      terminalId: DEMO_TERMINAL_ID,
      mode: 'demo',
    };
  });

  app.post('/v1/demo/sales', { schema: { body: demoSaleSchema } }, async (request) => {
    assertDemo();
    requireWrite(request);
    const body = request.body as {
      amountCents: number;
      method: 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER';
      installments?: number;
      brand?: string;
      last4?: string;
      description?: string;
      terminalId?: string;
    };
    const terminalId = body.terminalId ?? DEMO_TERMINAL_ID;
    const token =
      body.method === 'PIX'
        ? undefined
        : devTokenFor(body.brand ?? 'visa', body.last4 ?? '4242', `${body.brand ?? 'visa'}:${body.last4 ?? '4242'}`);
    const result = ctx.transactions.createSale({
      merchantId: DEMO_MERCHANT_ID,
      terminalId,
      amountCents: body.amountCents,
      method: body.method,
      installments: body.installments,
      paymentToken: token,
      description: body.description,
    });
    metrics.inc('sales_total', { status: result.status, method: result.transaction.method });
    return result;
  });

  app.post('/v1/demo/pix', async (request) => {
    assertDemo();
    requireWrite(request);
    const body = request.body as { amountCents?: number; description?: string };
    if (!body.amountCents) throw Errors.validation('amountCents é obrigatório.');
    return ctx.pix.createCharge({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      amountCents: body.amountCents,
      description: body.description,
    });
  });

  // ── Transações (maquininha / app Tap to Pay) ─────────────────────────────
  app.post('/v1/transactions', { schema: { body: transactionBodySchema } }, async (request, reply) => {
    const device = ctx.authenticator.verify(db, request);
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey.length < 8) {
      throw Errors.validation('Header Idempotency-Key obrigatório (mínimo 8 caracteres).');
    }
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const requestHash = sha256Hex(rawBody);
    const existing = db
      .prepare(
        'SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE scope = ? AND key = ?',
      )
      .get(device.terminalId, idempotencyKey) as
      | { request_hash: string; status_code: number; response_json: string }
      | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw Errors.conflict('Idempotency-Key reutilizada com payload diferente.');
      }
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(existing.status_code).send(JSON.parse(existing.response_json));
    }

    const body = request.body as {
      amountCents: number;
      method: string;
      installments?: number;
      paymentToken?: string;
      description?: string;
      items?: Array<{ name?: string; ncm?: string; quantity?: number; unitPriceCents?: number }>;
    };
    const result = ctx.transactions.createSale({
      merchantId: device.merchantId,
      terminalId: device.terminalId,
      amountCents: body.amountCents,
      method: body.method,
      installments: body.installments,
      paymentToken: body.paymentToken,
      description: body.description,
      items: body.items,
    });
    db.prepare(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response_json, created_at)
       VALUES (?, ?, ?, 201, ?, ?)`,
    ).run(device.terminalId, idempotencyKey, requestHash, JSON.stringify(result), new Date().toISOString());
    metrics.inc('sales_total', { status: result.status, method: result.transaction.method });
    reply.header('x-transaction-id', result.transaction.id);
    return reply.status(201).send(result);
  });

  app.get('/v1/transactions', async (request) => {
    const claims = requireRead(request);
    const { limit } = request.query as { limit?: string };
    return {
      data: ctx.transactions.list(claims.merchantId, Number.parseInt(limit ?? '25', 10) || 25),
    };
  });

  app.get('/v1/transactions/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    const row = ctx.transactions.getRow(id);
    assertMerchantScope(claims, row.merchant_id);
    return {
      transaction: publicTransaction(row),
      fiscal: ctx.fiscal.getDocument(id),
      settlement: db.prepare('SELECT * FROM settlements WHERE transaction_id = ?').get(id) ?? null,
      ledger: db
        .prepare(
          `SELECT e.direction, e.amount_cents, a.kind, e.memo, e.created_at
             FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
            WHERE e.transaction_id = ? ORDER BY e.created_at ASC`,
        )
        .all(id),
    };
  });

  app.get('/v1/overview', async (request) => {
    const claims = requireRead(request);
    const overview = buildOverview(db, claims.merchantId);
    if (!overview) throw Errors.notFound('Estabelecimento não encontrado.');
    return overview;
  });

  // ── Fiscal ────────────────────────────────────────────────────────────────
  app.get('/v1/fiscal/recent', async (request) => {
    const claims = requireRead(request);
    return { data: ctx.fiscal.listRecent(claims.merchantId, 20) };
  });

  app.get('/v1/fiscal/:transactionId', async (request) => {
    const claims = requireRead(request);
    const { transactionId } = request.params as { transactionId: string };
    const row = ctx.transactions.getRow(transactionId);
    assertMerchantScope(claims, row.merchant_id);
    const document = ctx.fiscal.getDocument(transactionId);
    if (!document) throw Errors.notFound('Nota fiscal ainda não emitida para esta transação.');
    return document;
  });

  // ── Pix ───────────────────────────────────────────────────────────────────
  app.post('/v1/pix/charges', async (request) => {
    const claims = requireWrite(request);
    const body = request.body as {
      amountCents?: number;
      description?: string;
      terminalId?: string;
      expiresInSeconds?: number;
    };
    if (!body.amountCents) throw Errors.validation('amountCents é obrigatório.');
    const result = ctx.pix.createCharge({
      merchantId: claims.merchantId,
      terminalId: body.terminalId ?? DEMO_TERMINAL_ID,
      amountCents: body.amountCents,
      description: body.description,
      expiresInSeconds: body.expiresInSeconds,
    });
    metrics.inc('pix_charges_total');
    return result;
  });

  app.get('/v1/pix/charges', async (request) => {
    const claims = requireRead(request);
    return { data: ctx.pix.listCharges(claims.merchantId, 20) };
  });

  app.get('/v1/pix/charges/:txid', async (request) => {
    const claims = requireRead(request);
    const { txid } = request.params as { txid: string };
    const result = ctx.pix.getCharge(txid);
    assertMerchantScope(claims, result.transaction.merchantId);
    return result;
  });

  app.post('/v1/pix/charges/:txid/simulate-payment', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { txid } = request.params as { txid: string };
    const current = ctx.pix.getCharge(txid);
    assertMerchantScope(claims, current.transaction.merchantId);
    return ctx.pix.payCharge(txid);
  });

  app.post('/v1/pix/webhook', async (request) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    verifyPixWebhook(
      config,
      String(request.headers['x-timestamp'] ?? ''),
      String(request.headers['x-signature'] ?? ''),
      rawBody,
    );
    const body = request.body as { txid?: string; endToEndId?: string };
    if (!body.txid) throw Errors.validation('txid é obrigatório.');
    const result = ctx.pix.payCharge(body.txid, { endToEndId: body.endToEndId });
    return { received: true, status: result.charge.status };
  });

  // ── Clientes ──────────────────────────────────────────────────────────────
  app.get('/v1/customers', async (request) => {
    const claims = requireRead(request);
    const { limit, search } = request.query as { limit?: string; search?: string };
    return {
      data: ctx.customers.list(claims.merchantId, {
        limit: Number.parseInt(limit ?? '50', 10) || 50,
        search,
      }),
    };
  });

  app.post('/v1/customers', { schema: { body: customerBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      name: string;
      document: string;
      email?: string;
      phone?: string;
      city?: string;
      uf?: string;
    };
    const customer = ctx.customers.create({ merchantId: claims.merchantId, ...body });
    metrics.inc('customers_created_total');
    return reply.status(201).send({ customer });
  });

  app.get('/v1/customers/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    return ctx.customers.get(claims.merchantId, id);
  });

  app.patch('/v1/customers/:id', { schema: { body: customerUpdateSchema } }, async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      email?: string | null;
      phone?: string | null;
      city?: string | null;
      uf?: string | null;
      status?: string;
    };
    return { customer: ctx.customers.update(claims.merchantId, id, body) };
  });

  app.delete('/v1/customers/:id', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return ctx.customers.archive(claims.merchantId, id);
  });

  // ── Boletos ───────────────────────────────────────────────────────────────
  app.get('/v1/boletos', async (request) => {
    const claims = requireRead(request);
    const { status, limit } = request.query as { status?: string; limit?: string };
    return {
      data: ctx.billing.listBoletos(claims.merchantId, {
        status,
        limit: Number.parseInt(limit ?? '50', 10) || 50,
      }),
    };
  });

  app.post('/v1/boletos', { schema: { body: boletoBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      amountCents: number;
      dueDate?: string;
      description?: string;
      customerId?: string;
      payerName?: string;
      payerDocument?: string;
      terminalId?: string;
    };
    const result = ctx.billing.createBoleto({ merchantId: claims.merchantId, ...body });
    metrics.inc('boletos_created_total');
    return reply.status(201).send(result);
  });

  app.get('/v1/boletos/:reference', async (request) => {
    const claims = requireRead(request);
    const { reference } = request.params as { reference: string };
    return ctx.billing.getBoleto(claims.merchantId, reference);
  });

  app.post('/v1/boletos/:reference/pay', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { reference } = request.params as { reference: string };
    const row = ctx.billing.findBoleto(claims.merchantId, reference);
    const result = ctx.billing.payBoleto(row.id);
    metrics.inc('boletos_paid_total');
    return result;
  });

  app.post('/v1/boletos/:reference/cancel', async (request) => {
    const claims = requireWrite(request);
    const { reference } = request.params as { reference: string };
    return { boleto: ctx.billing.cancelBoleto(claims.merchantId, reference) };
  });

  // ── Links de pagamento ────────────────────────────────────────────────────
  app.get('/v1/payment-links', async (request) => {
    const claims = requireRead(request);
    const { limit } = request.query as { limit?: string };
    return {
      data: ctx.billing.listLinks(claims.merchantId, {
        limit: Number.parseInt(limit ?? '50', 10) || 50,
      }),
    };
  });

  app.post('/v1/payment-links', { schema: { body: linkBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      amountCents: number;
      kind: string;
      description?: string;
      customerId?: string;
      dueDate?: string;
      payerName?: string;
      payerDocument?: string;
      expiresInSeconds?: number;
      terminalId?: string;
    };
    const result = ctx.billing.createLink({
      merchantId: claims.merchantId,
      ...body,
      kind: body.kind.toUpperCase() as 'PIX' | 'BOLETO',
    });
    metrics.inc('payment_links_created_total', { kind: body.kind.toUpperCase() });
    return reply.status(201).send(result);
  });

  app.get('/v1/payment-links/:code', async (request) => {
    const claims = requireRead(request);
    const { code } = request.params as { code: string };
    return ctx.billing.getLink(claims.merchantId, code);
  });

  app.post('/v1/payment-links/:code/pay', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { code } = request.params as { code: string };
    const row = ctx.billing.getLinkRowByCode(code);
    assertMerchantScope(claims, row.merchant_id);
    const result = ctx.billing.payLink(code);
    metrics.inc('payment_links_paid_total');
    return result;
  });

  app.post('/v1/payment-links/:code/cancel', async (request) => {
    const claims = requireWrite(request);
    const { code } = request.params as { code: string };
    return { link: ctx.billing.cancelLink(claims.merchantId, code) };
  });

  // ── Assinaturas e faturas ─────────────────────────────────────────────────
  app.get('/v1/subscriptions', async (request) => {
    const claims = requireRead(request);
    const { limit } = request.query as { limit?: string };
    return {
      data: ctx.subscriptions.list(claims.merchantId, {
        limit: Number.parseInt(limit ?? '50', 10) || 50,
      }),
    };
  });

  app.post('/v1/subscriptions', { schema: { body: subscriptionBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      customerId: string;
      description: string;
      amountCents: number;
      period: string;
      method: string;
      startDate?: string;
      terminalId?: string;
    };
    const subscription = ctx.subscriptions.create({ merchantId: claims.merchantId, ...body });
    metrics.inc('subscriptions_created_total');
    return reply.status(201).send(subscription);
  });

  app.get('/v1/subscriptions/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    return ctx.subscriptions.get(claims.merchantId, id);
  });

  app.post('/v1/subscriptions/:id/pause', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return ctx.subscriptions.setStatus(claims.merchantId, id, 'PAUSED');
  });

  app.post('/v1/subscriptions/:id/resume', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return ctx.subscriptions.setStatus(claims.merchantId, id, 'ACTIVE');
  });

  app.post('/v1/subscriptions/:id/cancel', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return ctx.subscriptions.setStatus(claims.merchantId, id, 'CANCELED');
  });

  app.get('/v1/subscription-invoices', async (request) => {
    const claims = requireRead(request);
    const { status, limit } = request.query as { status?: string; limit?: string };
    return {
      data: ctx.subscriptions.listInvoices(claims.merchantId, {
        status,
        limit: Number.parseInt(limit ?? '50', 10) || 50,
      }),
    };
  });

  app.get('/v1/subscription-invoices/:id', async (request) => {
    const claims = requireRead(request);
    const { id } = request.params as { id: string };
    ctx.subscriptions.ensureInvoice(claims.merchantId, id);
    return ctx.subscriptions.invoiceDetail(id);
  });

  app.post('/v1/subscription-invoices/:id/pay', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const result = ctx.subscriptions.payInvoice(claims.merchantId, id);
    metrics.inc('subscription_invoices_paid_total');
    return result;
  });

  app.post('/v1/subscription-invoices/:id/renew', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return ctx.subscriptions.renewInvoice(claims.merchantId, id);
  });

  // ── Extrato, liquidações e visão do app ───────────────────────────────────
  app.get('/v1/statement', async (request) => {
    const claims = requireRead(request);
    const { from, to, limit } = request.query as { from?: string; to?: string; limit?: string };
    return ctx.billing.statement(claims.merchantId, {
      from,
      to,
      limit: Number.parseInt(limit ?? '200', 10) || 200,
    });
  });

  app.get('/v1/statement.csv', async (request, reply) => {
    const claims = requireRead(request);
    const { from, to } = request.query as { from?: string; to?: string };
    const csv = ctx.billing.statementCsv(claims.merchantId, { from, to });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="extrato-xpartner.csv"')
      .send(csv);
  });

  app.get('/v1/settlements', async (request) => {
    const claims = requireRead(request);
    const { status, limit } = request.query as { status?: string; limit?: string };
    return {
      data: ctx.billing.listSettlements(claims.merchantId, {
        status,
        limit: Number.parseInt(limit ?? '50', 10) || 50,
      }),
    };
  });

  app.get('/v1/app/overview', async (request) => {
    const claims = requireRead(request);
    const overview = buildOverview(db, claims.merchantId);
    if (!overview) throw Errors.notFound('Estabelecimento não encontrado.');
    return {
      overview,
      billing: ctx.billing.overview(claims.merchantId),
      boletos: ctx.billing.listBoletos(claims.merchantId, { limit: 6 }),
      links: ctx.billing.listLinks(claims.merchantId, { limit: 6 }),
      subscriptions: ctx.subscriptions.list(claims.merchantId, { limit: 6 }),
      invoices: ctx.subscriptions.listInvoices(claims.merchantId, { limit: 6 }),
      customers: ctx.customers.list(claims.merchantId, { limit: 6 }),
      settlements: ctx.billing.listSettlements(claims.merchantId, { limit: 6 }),
      statement: ctx.billing.statement(claims.merchantId, { limit: 20 }),
      openFinance: ctx.openfinance.overview(claims.merchantId),
      investments: ctx.investments.overview(claims.merchantId),
    };
  });

  // ── Open Finance (consentimentos, débito externo e iniciação Pix) ─────────
  app.get('/v1/open-finance/overview', async (request) => {
    const claims = requireRead(request);
    return ctx.openfinance.overview(claims.merchantId);
  });

  app.post('/v1/open-finance/consents', { schema: { body: consentBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      provider: string;
      providerCode: string;
      kind: 'DATA_SHARING' | 'EXTERNAL_DEBIT' | 'PAYMENT_INITIATION';
      customerId?: string;
      scopes?: string[];
      expiresInDays?: number;
      account: {
        type: 'CHECKING' | 'SAVINGS' | 'PAYMENT';
        branch: string;
        number: string;
        holderName?: string;
        holderDocument?: string;
        balanceCents?: number;
      };
    };
    const consent = ctx.openfinance.createConsent({ merchantId: claims.merchantId, ...body });
    metrics.inc('open_finance_consents_total', { kind: body.kind });
    return reply.status(201).send({ consent });
  });

  app.post('/v1/open-finance/consents/:id/authorize', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return { consent: ctx.openfinance.authorize(claims.merchantId, id) };
  });

  app.post('/v1/open-finance/consents/:id/reject', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return { consent: ctx.openfinance.reject(claims.merchantId, id, body.reason) };
  });

  app.post('/v1/open-finance/consents/:id/revoke', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return { consent: ctx.openfinance.revoke(claims.merchantId, id, body.reason) };
  });

  app.post('/v1/open-finance/debits', { schema: { body: externalDebitBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as { consentId: string; amountCents: number; description?: string; dueDate?: string };
    const debit = ctx.openfinance.createDebit({ merchantId: claims.merchantId, ...body });
    metrics.inc('open_finance_debits_total');
    return reply.status(201).send({ debit });
  });

  app.post('/v1/open-finance/debits/:id/settle', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const result = ctx.openfinance.settleDebit(claims.merchantId, id);
    metrics.inc('open_finance_debits_settled_total');
    return result;
  });

  app.post('/v1/open-finance/debits/:id/cancel', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return { debit: ctx.openfinance.cancelDebit(claims.merchantId, id) };
  });

  app.post('/v1/open-finance/payments', { schema: { body: ofPaymentBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as { consentId: string; amountCents: number; pixKey: string; description?: string };
    const payment = ctx.openfinance.createPayment({ merchantId: claims.merchantId, ...body });
    metrics.inc('open_finance_payments_total');
    return reply.status(201).send({ payment });
  });

  app.post('/v1/open-finance/payments/:id/settle', async (request) => {
    assertDemo();
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    const payment = ctx.openfinance.settlePayment(claims.merchantId, id);
    metrics.inc('open_finance_payments_settled_total');
    return { payment };
  });

  app.post('/v1/open-finance/payments/:id/cancel', async (request) => {
    const claims = requireWrite(request);
    const { id } = request.params as { id: string };
    return { payment: ctx.openfinance.cancelPayment(claims.merchantId, id) };
  });

  // ── Investimentos e proventos ─────────────────────────────────────────────
  app.get('/v1/investments/overview', async (request) => {
    const claims = requireRead(request);
    return ctx.investments.overview(claims.merchantId);
  });

  app.get('/v1/investments/products', async (request) => {
    requireRead(request);
    const { kind, limit } = request.query as { kind?: string; limit?: string };
    return {
      data: ctx.investments.listProducts({
        kind,
        limit: Number.parseInt(limit ?? '20', 10) || 20,
      }),
    };
  });

  app.get('/v1/investments/positions', async (request) => {
    const claims = requireRead(request);
    const { limit } = request.query as { limit?: string };
    return { data: ctx.investments.positions(claims.merchantId, { limit: Number.parseInt(limit ?? '20', 10) || 20 }) };
  });

  app.post('/v1/investments/contributions', { schema: { body: contributionBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as { productId: string; amountCents: number };
    const result = ctx.investments.invest({ merchantId: claims.merchantId, ...body });
    metrics.inc('investment_contributions_total');
    return reply.status(201).send(result);
  });

  app.post('/v1/investments/redemptions', { schema: { body: redemptionBodySchema } }, async (request) => {
    const claims = requireWrite(request);
    const body = request.body as { positionId: string; amountCents: number };
    const result = ctx.investments.redeem({ merchantId: claims.merchantId, ...body });
    metrics.inc('investment_redemptions_total');
    return result;
  });

  app.get('/v1/investments/proventos', async (request) => {
    const claims = requireRead(request);
    const { status, limit } = request.query as { status?: string; limit?: string };
    return {
      data: ctx.investments.proventos(claims.merchantId, {
        status,
        limit: Number.parseInt(limit ?? '20', 10) || 20,
      }),
    };
  });

  app.post('/v1/investments/proventos', { schema: { body: proventoBodySchema } }, async (request, reply) => {
    const claims = requireWrite(request);
    const body = request.body as {
      positionId: string;
      kind: 'DIVIDENDO' | 'JCP' | 'RENDIMENTO';
      grossCents: number;
      exDate: string;
      paymentDate: string;
    };
    const provento = ctx.investments.createProvento({ merchantId: claims.merchantId, ...body });
    metrics.inc('investment_proventos_total', { kind: body.kind });
    return reply.status(201).send({ provento });
  });

  // ── Checkout público (link de pagamento) ──────────────────────────────────
  app.get('/v1/public/links/:code', async (request) => {
    const { code } = request.params as { code: string };
    return { ...ctx.billing.linkDetail(code), demoMode: config.demoMode };
  });

  app.post('/v1/public/links/:code/pay', async (request) => {
    assertDemo();
    const { code } = request.params as { code: string };
    metrics.inc('public_link_payments_total');
    return { ...ctx.billing.payLink(code), demoMode: true };
  });

  // ── Liquidação e antecipação ──────────────────────────────────────────────
  app.get('/v1/settlements/:transactionId', async (request) => {
    const claims = requireRead(request);
    const { transactionId } = request.params as { transactionId: string };
    const row = ctx.transactions.getRow(transactionId);
    assertMerchantScope(claims, row.merchant_id);
    return ctx.settlements.getByTransaction(transactionId);
  });

  app.get('/v1/settlements/:transactionId/offer', async (request) => {
    const claims = requireRead(request);
    const { transactionId } = request.params as { transactionId: string };
    const row = ctx.transactions.getRow(transactionId);
    assertMerchantScope(claims, row.merchant_id);
    return ctx.settlements.offer(transactionId);
  });

  app.post('/v1/settlements/:transactionId/advance', async (request) => {
    const claims = requireWrite(request);
    const { transactionId } = request.params as { transactionId: string };
    const row = ctx.transactions.getRow(transactionId);
    assertMerchantScope(claims, row.merchant_id);
    const result = ctx.settlements.anticipate(transactionId);
    metrics.inc('advances_total');
    return result;
  });

  // ── Ledger, risco e adquirentes ───────────────────────────────────────────
  app.get('/v1/ledger/trial', async (request) => {
    requireRead(request);
    return { trial: trialBalance(db), balances: listBalances(db) };
  });

  app.get('/v1/ledger/balances/:merchantId', async (request) => {
    const claims = requireRead(request);
    const { merchantId } = request.params as { merchantId: string };
    assertMerchantScope(claims, merchantId);
    return { data: listBalances(db, { ownerType: 'MERCHANT', ownerId: merchantId }) };
  });

  app.get('/v1/risk/overview', async (request) => {
    const claims = requireRead(request);
    const declined = db
      .prepare(
        `SELECT id, amount_cents, risk_score, risk_decision, risk_reasons, failure_reason, created_at
           FROM transactions WHERE merchant_id = ? AND status = 'DECLINED'
          ORDER BY created_at DESC LIMIT 8`,
      )
      .all(claims.merchantId) as Array<{
      id: string;
      amount_cents: number;
      risk_score: number;
      risk_decision: string;
      risk_reasons: string;
      failure_reason: string;
      created_at: string;
    }>;
    return {
      graph: riskGraphStats(db),
      declined: declined.map((row) => ({
        id: row.id,
        amountCents: row.amount_cents,
        amountFormatted: formatBRL(row.amount_cents),
        riskScore: row.risk_score,
        riskDecision: row.risk_decision,
        reasons: JSON.parse(row.risk_reasons) as unknown[],
        failureReason: row.failure_reason,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/v1/acquirers', async (request) => {
    requireRead(request);
    return { data: listAcquirers(db) };
  });

  // ── Núcleo bancário: identidade, contas e transferências reais ────────────
  const bankSession = (request: FastifyRequest) => ctx.bankAuth.authenticate(request);
  const bankAdminSession = (request: FastifyRequest) =>
    ctx.bankAuth.requireAdmin(ctx.bankAuth.authenticate(request));
  const attachBankCookie = (reply: FastifyReply, token: string | undefined) => {
    if (token) {
      reply.header('set-cookie', sessionCookie(token, config.bankSessionTtlSeconds, config.isProduction));
    }
  };
  const requirePasswordChanged = (auth: ReturnType<typeof bankSession>) => {
    if (auth.user.must_change_password === 1) {
      throw new AppError(
        'PASSWORD_CHANGE_REQUIRED',
        'Troque a senha temporária antes de movimentar a conta.',
        403,
      );
    }
  };

  app.get('/v1/bank/status', async () => ctx.bankAuth.status());

  app.get('/v1/bank/rsfn/pag0004.xsd', async (_request, reply) => {
    const xsd = readFileSync(new URL('../../db/rsfn-pag0004.xsd', import.meta.url), 'utf8');
    return reply.type('application/xml; charset=utf-8').send(xsd);
  });

  app.post('/v1/bank/auth/register', { schema: { body: bankRegisterSchema } }, async (request, reply) => {
    const body = request.body as {
      name: string;
      document: string;
      email: string;
      phone?: string;
      password: string;
      bootstrapToken?: string;
    };
    const result = ctx.bankAuth.register(body, {
      ip: request.ip,
      userAgent: String(request.headers['user-agent'] ?? ''),
    });
    attachBankCookie(reply, result.session?.token);
    metrics.inc('bank_registrations_total', { approval: result.requiresApproval ? 'pending' : 'active' });
    return reply.status(201).send({
      user: result.user,
      account: result.account,
      requiresApproval: result.requiresApproval,
      bootstrapAdmin: result.bootstrapAdmin,
      token: result.session?.token,
      csrfToken: result.session?.csrfToken,
      expiresAt: result.session?.expiresAt,
    });
  });

  app.post('/v1/bank/auth/login', { schema: { body: bankLoginSchema } }, async (request, reply) => {
    const body = request.body as { identifier: string; password: string };
    const result = ctx.bankAuth.login(body, {
      ip: request.ip,
      userAgent: String(request.headers['user-agent'] ?? ''),
    });
    attachBankCookie(reply, result.session.token);
    metrics.inc('bank_logins_total');
    return {
      user: result.user,
      account: result.user.account,
      token: result.session.token,
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
    };
  });

  app.post('/v1/bank/auth/logout', async (request, reply) => {
    const auth = bankSession(request);
    ctx.bankAuth.logout(auth);
    reply.header('set-cookie', clearSessionCookie(config.isProduction));
    return { ok: true };
  });

  app.post('/v1/bank/auth/change-password', { schema: { body: bankPasswordSchema } }, async (request) => {
    const auth = bankSession(request);
    const body = request.body as { currentPassword: string; newPassword: string };
    ctx.bankAuth.changePassword(auth, body.currentPassword, body.newPassword);
    metrics.inc('bank_password_changes_total');
    return { ok: true, user: ctx.bankAuth.view(auth.user, { self: true }) };
  });

  app.get('/v1/bank/me', async (request) => {
    const auth = bankSession(request);
    const view = ctx.bankAuth.view(auth.user, { self: true });
    return {
      user: view,
      account: view.account,
      csrfToken: auth.session.csrf_token,
      session: { expiresAt: auth.session.expires_at, createdAt: auth.session.created_at },
    };
  });

  app.get('/v1/bank/account', async (request) => {
    const auth = bankSession(request);
    return { account: ctx.bankAuth.view(auth.user, { self: true }).account };
  });

  app.get('/v1/bank/statement', async (request) => {
    const auth = bankSession(request);
    const { from, to, limit } = request.query as { from?: string; to?: string; limit?: string };
    if (!auth.account) throw Errors.notFound('Conta bancária não encontrada.');
    return ctx.bank.statement(auth.account.id, {
      from,
      to,
      limit: Number.parseInt(limit ?? '100', 10) || 100,
    });
  });

  app.get('/v1/bank/statement.csv', async (request, reply) => {
    const auth = bankSession(request);
    const { from, to } = request.query as { from?: string; to?: string };
    if (!auth.account) throw Errors.notFound('Conta bancária não encontrada.');
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="extrato-xpartner.csv"')
      .send(ctx.bank.statementCsv(auth.account.id, { from, to }));
  });

  app.get('/v1/bank/recipients/lookup', async (request) => {
    const auth = bankSession(request);
    const { q, type } = request.query as { q?: string; type?: string };
    const query = String(q ?? '').trim();
    if (!query) throw Errors.validation('Informe conta, CPF/CNPJ, e-mail ou chave Pix do favorecido.');
    if (type === 'pix') {
      return { recipient: ctx.bankPix.lookup(auth.user.id, query), channel: 'PIX' };
    }
    const digits = query.replace(/\D/g, '');
    if (type === 'email' || query.includes('@')) {
      return { recipient: ctx.bank.lookupRecipient(auth.user.id, { email: query }) };
    }
    if (type === 'document' || digits.length === 11 || digits.length === 14) {
      return { recipient: ctx.bank.lookupRecipient(auth.user.id, { document: digits }) };
    }
    return { recipient: ctx.bank.lookupRecipient(auth.user.id, { accountNumber: digits }) };
  });

  app.post('/v1/bank/transfers', { schema: { body: bankTransferSchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    if (!auth.account) throw Errors.notFound('Conta bancária não encontrada.');
    const body = request.body as {
      amountCents: number;
      description?: string;
      idempotencyKey?: string;
      recipient: { accountNumber?: string; document?: string; email?: string; pixKey?: string };
    };
    const pix = body.recipient.pixKey
      ? ctx.bankPix.resolveRecipient(auth.user.id, body.recipient.pixKey)
      : null;
    const recipient = pix
      ? { accountNumber: pix.accountNumber }
      : body.recipient.accountNumber
        ? { accountNumber: body.recipient.accountNumber }
        : body.recipient.document
          ? { document: body.recipient.document }
          : body.recipient.email
            ? { email: body.recipient.email }
            : null;
    if (!recipient) throw Errors.validation('Informe a conta, CPF/CNPJ, e-mail ou chave Pix do favorecido.');
    const idempotencyKey =
      body.idempotencyKey ?? (String(request.headers['idempotency-key'] ?? '').trim() || undefined);
    const result = ctx.bank.transfer({
      userId: auth.user.id,
      accountId: auth.account.id,
      amountCents: body.amountCents,
      description: body.description,
      recipient,
      idempotencyKey,
      channel: pix ? 'PIX' : undefined,
    });
    metrics.inc('bank_transfers_total', { replayed: String(result.replayed) });
    const extra = pix ? { pix: pix.contact } : {};
    if (result.replayed) {
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(200).send({ ...result, ...extra, replayed: true });
    }
    return reply.status(201).send({ ...result, ...extra, replayed: false });
  });

  // ── Pix: chaves, BR Code e pagamento por chave ─────────────────────────────
  app.get('/v1/bank/accounts/validate', async (request) => {
    bankSession(request);
    const { number, base, digit } = request.query as { number?: string; base?: string; digit?: string };
    if (number) {
      const full = String(number).replace(/\D/g, '');
      if (full.length < 5) throw Errors.validation('Informe o número completo da conta.');
      return { check: validateAccountNumber(full.slice(0, -1), full.slice(-1)) };
    }
    if (!base) throw Errors.validation('Informe o número base da conta.');
    return { check: validateAccountNumber(base, digit ?? '') };
  });

  app.get('/v1/bank/pix/keys', async (request) => {
    const auth = bankSession(request);
    return ctx.bankPix.list(auth.user.id);
  });

  app.post('/v1/bank/pix/keys', { schema: { body: bankPixKeySchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const body = request.body as { type?: string; value: string; label?: string };
    const key = ctx.bankPix.create(auth.user.id, body);
    metrics.inc('bank_pix_keys_total', { type: key.type });
    return reply.status(201).send({ key });
  });

  app.post('/v1/bank/pix/keys/evp', { schema: { body: bankPixEvpSchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const body = request.body as { label?: string };
    const key = ctx.bankPix.createEvp(auth.user.id, body.label);
    metrics.inc('bank_pix_keys_total', { type: key.type });
    return reply.status(201).send({ key });
  });

  app.delete('/v1/bank/pix/keys/:id', async (request) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const { id } = request.params as { id: string };
    const result = ctx.bankPix.remove(auth.user.id, id);
    metrics.inc('bank_pix_keys_deleted_total');
    return result;
  });

  app.get('/v1/bank/pix/lookup', async (request) => {
    const auth = bankSession(request);
    const { key } = request.query as { key?: string };
    if (!key) throw Errors.validation('Informe a chave Pix.');
    return { recipient: ctx.bankPix.lookup(auth.user.id, key) };
  });

  app.get('/v1/bank/pix/keys/:id/brcode', async (request) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    const { amountCents } = request.query as { amountCents?: string };
    let amount: number | undefined;
    if (amountCents !== undefined && amountCents !== '') {
      amount = Number(amountCents);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw Errors.validation('amountCents deve ser um inteiro positivo em centavos.');
      }
    }
    return ctx.bankPix.brCode(auth.user.id, id, amount);
  });

  app.get('/v1/bank/admin/pix/keys', async (request) => {
    bankAdminSession(request);
    const { type, status, limit } = request.query as { type?: string; status?: string; limit?: string };
    return {
      data: ctx.bankPix.adminList({
        type,
        status,
        limit: Number.parseInt(limit ?? '100', 10) || 100,
      }),
    };
  });

  app.get('/v1/bank/transfers/:id', async (request) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    return ctx.bank.receipt(id, { userId: auth.user.id, role: auth.user.role });
  });

  app.get('/v1/bank/credit/score', async (request) => {
    const auth = bankSession(request);
    if (!auth.account) throw Errors.notFound('Conta bancária não encontrada.');
    return ctx.bank.creditScore(auth.account.id);
  });

  app.post('/v1/bank/demo/credit', { schema: { body: bankFundingSchema } }, async (request, reply) => {
    assertDemo();
    const auth = bankSession(request);
    const body = request.body as { amountCents: number; targetUserId?: string; description?: string };
    const targetUserId = body.targetUserId ?? auth.user.id;
    if (targetUserId !== auth.user.id) ctx.bankAuth.requireAdmin(auth);
    const result = ctx.bank.funding({
      actorUserId: auth.user.id,
      targetUserId,
      amountCents: body.amountCents,
      description: body.description,
    });
    metrics.inc('bank_demo_funding_total');
    return reply.status(201).send(result);
  });

  // ── Capital de laboratório e carteira internacional (demo) ────────────────
  app.post('/v1/bank/demo/capital', { schema: { body: bankCapitalSchema } }, async (request, reply) => {
    assertDemo();
    const auth = bankSession(request);
    ctx.bankAuth.requireAdmin(auth);
    requirePasswordChanged(auth);
    const body = request.body as {
      targetUserId: string;
      amountCents: number;
      description?: string;
      idempotencyKey?: string;
    };
    const idempotencyKey =
      body.idempotencyKey ?? (String(request.headers['idempotency-key'] ?? '').trim() || undefined);
    const result = ctx.bank.demoCapital({
      actorUserId: auth.user.id,
      targetUserId: body.targetUserId,
      amountCents: body.amountCents,
      description: body.description,
      idempotencyKey,
    });
    metrics.inc('bank_demo_capital_total', { replayed: String(result.replayed) });
    if (result.replayed) {
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(200).send(result);
    }
    return reply.status(201).send(result);
  });

  app.get('/v1/bank/fx/wallets', async (request) => {
    const auth = bankSession(request);
    return ctx.bankFx.wallets(auth.user.id);
  });

  app.get('/v1/bank/fx/wallets/:currency/statement', async (request) => {
    const auth = bankSession(request);
    const { currency } = request.params as { currency: string };
    const { limit } = request.query as { limit?: string };
    return ctx.bankFx.statement(auth.user.id, currency, Number.parseInt(limit ?? '50', 10) || 50);
  });

  app.post('/v1/bank/demo/fx', { schema: { body: bankFxFundSchema } }, async (request, reply) => {
    assertDemo();
    const auth = bankSession(request);
    ctx.bankAuth.requireAdmin(auth);
    requirePasswordChanged(auth);
    const body = request.body as {
      targetUserId: string;
      currency?: string;
      amountCents: number;
      memo?: string;
      idempotencyKey?: string;
    };
    const idempotencyKey =
      body.idempotencyKey ?? (String(request.headers['idempotency-key'] ?? '').trim() || undefined);
    const result = ctx.bankFx.fund({
      actorUserId: auth.user.id,
      targetUserId: body.targetUserId,
      currency: body.currency,
      amountCents: body.amountCents,
      memo: body.memo,
      idempotencyKey,
    });
    metrics.inc('bank_demo_fx_total', { replayed: String(result.replayed) });
    if (result.replayed) {
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(200).send(result);
    }
    return reply.status(201).send(result);
  });

  // ── Crédito: antecipação, empréstimo Price, parcelas e liquidação ─────────
  app.get('/v1/bank/credit/line', async (request) => {
    const auth = bankSession(request);
    return { line: ctx.bankCredit.line(auth.user.id) };
  });

  app.post('/v1/bank/credit/quote', { schema: { body: bankCreditQuoteSchema } }, async (request) => {
    const auth = bankSession(request);
    const body = request.body as { product: string; amountCents: number; installments?: number };
    return { quote: ctx.bankCredit.quote(auth.user.id, body) };
  });

  app.get('/v1/bank/credit/contracts', async (request) => {
    const auth = bankSession(request);
    return ctx.bankCredit.list(auth.user.id);
  });

  app.get('/v1/bank/credit/contracts.csv', async (request, reply) => {
    const auth = bankSession(request);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="credito-xpartner.csv"')
      .send(ctx.bankCredit.exportCsv(auth.user.id));
  });

  app.post('/v1/bank/credit/contracts', { schema: { body: bankCreditContractSchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const body = request.body as {
      product: string;
      amountCents: number;
      installments?: number;
      idempotencyKey?: string;
    };
    const idempotencyKey =
      body.idempotencyKey ?? (String(request.headers['idempotency-key'] ?? '').trim() || undefined);
    const result = ctx.bankCredit.create(auth.user.id, {
      product: body.product,
      amountCents: body.amountCents,
      installments: body.installments,
      idempotencyKey,
    });
    metrics.inc('bank_credit_contracts_total', { replayed: String(result.replayed) });
    if (result.replayed) {
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(200).send(result);
    }
    return reply.status(201).send(result);
  });

  app.get('/v1/bank/credit/contracts/:id', async (request) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    return { contract: ctx.bankCredit.get(auth.user.id, id) };
  });

  app.post('/v1/bank/credit/contracts/:id/installments/:number/pay', async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const { id, number } = request.params as { id: string; number: string };
    const result = ctx.bankCredit.payInstallment(auth.user.id, id, Number.parseInt(number, 10));
    metrics.inc('bank_credit_payments_total');
    return reply.status(201).send(result);
  });

  app.post('/v1/bank/credit/contracts/:id/settle', async (request) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const { id } = request.params as { id: string };
    const result = ctx.bankCredit.settleEarly(auth.user.id, id);
    metrics.inc('bank_credit_settlements_total');
    return result;
  });

  // ── PDV: venda presencial com NFC-e síncrona e liquidação na conta ────────
  app.get('/v1/bank/pdv/sales', async (request) => {
    const auth = bankSession(request);
    const { limit } = request.query as { limit?: string };
    return ctx.bankPdv.list(auth.user.id, Number.parseInt(limit ?? '30', 10) || 30);
  });

  app.get('/v1/bank/pdv/sales.csv', async (request, reply) => {
    const auth = bankSession(request);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="pdv-xpartner.csv"')
      .send(ctx.bankPdv.salesCsv(auth.user.id));
  });

  app.post('/v1/bank/pdv/sales', { schema: { body: bankPdvSaleSchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    const body = request.body as {
      amountCents: number;
      method: string;
      installments?: number;
      description?: string;
      items?: Array<{ name?: string; ncm?: string; quantity?: number; unitPriceCents?: number }>;
    };
    const result = await ctx.bankPdv.sell({
      userId: auth.user.id,
      amountCents: body.amountCents,
      method: body.method,
      installments: body.installments,
      description: body.description,
      items: body.items,
    });
    metrics.inc('bank_pdv_sales_total', { method: result.sale.method });
    return reply.status(201).send(result);
  });

  app.get('/v1/bank/pdv/sales/:id/fiscal', async (request) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    return ctx.bankPdv.document(auth.user.id, id);
  });

  app.get('/v1/bank/pdv/sales/:id/xml', async (request, reply) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    const doc = ctx.bankPdv.document(auth.user.id, id);
    return reply
      .type('application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="nfce-${doc.sale.fiscal?.accessKey ?? id}.xml"`)
      .send(doc.xml);
  });

  // ── RSFN / PAG0004: transferência interbancária com XML e compensação ─────
  app.get('/v1/bank/rsfn/config', async (request) => {
    bankSession(request);
    return { config: ctx.rsfn.configView() };
  });

  app.post('/v1/bank/rsfn/validate', { schema: { body: rsfnValidateSchema } }, async (request) => {
    bankSession(request);
    const body = request.body as { xml: string };
    return ctx.rsfn.validateXml(body.xml);
  });

  app.post('/v1/bank/rsfn/transfers', { schema: { body: rsfnTransferSchema } }, async (request, reply) => {
    const auth = bankSession(request);
    requirePasswordChanged(auth);
    if (!auth.account) throw Errors.notFound('Conta bancária não encontrada.');
    const body = request.body as {
      amountCents: number;
      description?: string;
      idempotencyKey?: string;
      clientCode?: string;
      destination: { ispb: string; branch: string; account: string; document: string; name: string };
    };
    const idempotencyKey =
      body.idempotencyKey ?? (String(request.headers['idempotency-key'] ?? '').trim() || undefined);
    const result = ctx.rsfn.create({
      userId: auth.user.id,
      accountId: auth.account.id,
      amountCents: body.amountCents,
      description: body.description,
      destination: body.destination,
      clientCode: body.clientCode,
      idempotencyKey,
    });
    metrics.inc('bank_rsfn_transfers_total', { replayed: String(result.replayed) });
    if (result.replayed) {
      reply.header('x-idempotent-replayed', 'true');
      return reply.status(200).send(result);
    }
    return reply.status(201).send(result);
  });

  app.get('/v1/bank/rsfn/messages', async (request) => {
    const auth = bankSession(request);
    const { limit } = request.query as { limit?: string };
    return { data: ctx.rsfn.list(auth.user.id, Number.parseInt(limit ?? '50', 10) || 50) };
  });

  app.get('/v1/bank/rsfn/messages/:id', async (request) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    return ctx.rsfn.get(id, { userId: auth.user.id, role: auth.user.role });
  });

  app.get('/v1/bank/rsfn/messages/:id/xml', async (request, reply) => {
    const auth = bankSession(request);
    const { id } = request.params as { id: string };
    const message = ctx.rsfn.get(id, { userId: auth.user.id, role: auth.user.role });
    return reply
      .type('application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${message.numCtrlIf}.xml"`)
      .send(message.xml);
  });

  app.post('/v1/bank/rsfn/messages/:id/ack', { schema: { body: rsfnAckSchema } }, async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    const body = request.body as { decision: 'ACCEPT' | 'REJECT'; rejectionCode?: string; rejectionReason?: string };
    const result = ctx.rsfn.ack(id, {
      decision: body.decision,
      rejectionCode: body.rejectionCode,
      rejectionReason: body.rejectionReason,
      actorUserId: auth.user.id,
    });
    metrics.inc('bank_rsfn_acked_total', { decision: body.decision });
    return result;
  });

  app.get('/v1/bank/admin/rsfn/messages', async (request) => {
    bankAdminSession(request);
    const { limit } = request.query as { limit?: string };
    return { data: ctx.rsfn.adminList(Number.parseInt(limit ?? '100', 10) || 100) };
  });

  app.get('/v1/bank/admin/overview', async (request) => {
    bankAdminSession(request);
    const overview = ctx.bankAuth.adminOverview();
    return { ...overview, system: { ...overview.system, fx: ctx.bankFx.systemOverview() } };
  });

  app.get('/v1/bank/admin/users', async (request) => {
    bankAdminSession(request);
    const { status, search, limit } = request.query as { status?: string; search?: string; limit?: string };
    return {
      data: ctx.bankAuth.listUsers({
        status: status?.toUpperCase(),
        search,
        limit: Number.parseInt(limit ?? '100', 10) || 100,
      }),
    };
  });

  app.get('/v1/bank/admin/users/:id', async (request) => {
    bankAdminSession(request);
    const { id } = request.params as { id: string };
    return ctx.bankAuth.adminUserDetail(id);
  });

  app.post('/v1/bank/admin/users/:id/approve', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    const result = ctx.bankAuth.approve(auth.user.id, id);
    metrics.inc('bank_users_approved_total');
    return result;
  });

  app.post('/v1/bank/admin/users/:id/reject', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    ctx.bankAuth.reject(auth.user.id, id);
    metrics.inc('bank_users_rejected_total');
    return { ok: true };
  });

  app.post('/v1/bank/admin/users/:id/block', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    return { user: ctx.bankAuth.setBlocked(auth.user.id, id, true) };
  });

  app.post('/v1/bank/admin/users/:id/unblock', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    return { user: ctx.bankAuth.setBlocked(auth.user.id, id, false) };
  });

  app.delete('/v1/bank/admin/users/:id', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    ctx.bankAuth.delete(auth.user.id, id);
    metrics.inc('bank_users_deleted_total');
    return { ok: true };
  });

  app.post('/v1/bank/admin/users/:id/reset-password', async (request) => {
    const auth = bankAdminSession(request);
    const { id } = request.params as { id: string };
    const result = ctx.bankAuth.resetPassword(auth.user.id, id);
    metrics.inc('bank_password_resets_total');
    return result;
  });

  app.get('/v1/bank/admin/audit', async (request) => {
    bankAdminSession(request);
    const { limit } = request.query as { limit?: string };
    return { data: ctx.bankAuth.auditLog(Number.parseInt(limit ?? '50', 10) || 50) };
  });

  // ── Tokenização, Web3 e agentes ───────────────────────────────────────────
  registerTokenizationRoutes(app, ctx.tokenization, { requireRead, requireWrite, assertDemo });
  registerWeb3Routes(app, ctx.web3, { requireRead, requireWrite });
  registerAladdinRoutes(app, ctx.aladdin, ctx.crosschain, { requireRead, requireWrite });

  // ── Dashboard ─────────────────────────────────────────────────────────────
  let dashboardHtml: string | undefined;
  let tokenizationHtml: string | undefined;
  let web3Html: string | undefined;
  let docsHtml: string | undefined;
  let appHtml: string | undefined;
  let bankHtml: string | undefined;
  let coreHtml: string | undefined;
  let checkoutHtml: string | undefined;
  const swaggerAssets = new Map<string, string>();
  app.get('/', async (request, reply) => {
    if (!config.demoMode) {
      reply.type('text/html; charset=utf-8').send(OPERATIONAL_LANDING);
      return;
    }
    if (!dashboardHtml) {
      dashboardHtml = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(dashboardHtml);
  });

  app.get('/tokenization.html', async (request, reply) => {
    assertDemo();
    if (!tokenizationHtml) {
      tokenizationHtml = readFileSync(new URL('../../public/tokenization.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(tokenizationHtml);
  });

  app.get('/tokenization', async (request, reply) => {
    assertDemo();
    if (!tokenizationHtml) {
      tokenizationHtml = readFileSync(new URL('../../public/tokenization.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(tokenizationHtml);
  });

  app.get('/web3', async (request, reply) => {
    assertDemo();
    if (!web3Html) {
      web3Html = readFileSync(new URL('../../public/web3.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(web3Html);
  });

  app.get('/docs', async (request, reply) => {
    if (!docsHtml) {
      docsHtml = readFileSync(new URL('../../public/docs.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(docsHtml);
  });

  app.get('/vendor/swagger/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (file !== 'swagger-ui.css' && file !== 'swagger-ui-bundle.js') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Arquivo não encontrado.', requestId: request.id } });
      return;
    }
    if (!swaggerAssets.has(file)) {
      swaggerAssets.set(file, readFileSync(new URL(`../../public/vendor/swagger/${file}`, import.meta.url), 'utf8'));
    }
    reply.type(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8').send(swaggerAssets.get(file));
  });

  app.get('/app', async (request, reply) => {
    assertDemo();
    if (!appHtml) {
      appHtml = readFileSync(new URL('../../public/app.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(appHtml);
  });

  app.get('/bank', async (request, reply) => {
    if (!bankHtml || !config.isProduction) {
      bankHtml = readFileSync(new URL('../../public/bank.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(bankHtml);
  });

  app.get('/core', async (request, reply) => {
    if (!coreHtml || !config.isProduction) {
      coreHtml = readFileSync(new URL('../../public/core.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(coreHtml);
  });

  app.get('/pay/:code', async (request, reply) => {
    if (!checkoutHtml) {
      checkoutHtml = readFileSync(new URL('../../public/pay.html', import.meta.url), 'utf8');
    }
    reply.type('text/html; charset=utf-8').send(checkoutHtml);
  });

  return app;
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (isAppError(error)) {
    return reply.status(error.status).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Falha interna.' } });
}

export { AppError };

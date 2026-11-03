import type { AppConfig } from '../../../src/config.ts';
import type { Db } from '../../../src/kernel/db.ts';
import { migrate } from '../../../src/kernel/db.ts';
import { isAppError, Errors } from '../../../src/kernel/errors.ts';
import { deriveSecret, randomSecret, sha256Hex, signToken, verifyToken } from '../../../src/kernel/crypto.ts';
import { formatBRL } from '../../../src/kernel/money.ts';
import { numericCodeFrom } from '../../../src/kernel/fiscal-digits.ts';
import { listBalances, trialBalance } from '../../../src/domain/ledger.ts';
import { listAcquirers } from '../../../src/domain/routing.ts';
import { riskGraphStats } from '../../../src/domain/risk.ts';
import { buildOverview } from '../../../src/domain/overview.ts';
import { devTokenFor } from '../../../src/domain/vault.ts';
import { buildDanfeText, buildQrCodeUrl, generateAccessKey } from '../../../src/domain/fiscal.ts';
import { publicTransaction, TransactionService } from '../../../src/modules/transactions.ts';
import { PixService } from '../../../src/modules/pix.ts';
import { FiscalWorker } from '../../../src/modules/fiscal-worker.ts';
import { SettlementWorker } from '../../../src/modules/settlement-worker.ts';
import { CustomerService } from '../../../src/modules/customers.ts';
import { BillingService } from '../../../src/modules/billing.ts';
import { SubscriptionService } from '../../../src/modules/subscriptions.ts';
import { OpenFinanceService } from '../../../src/modules/openfinance.ts';
import { InvestmentService } from '../../../src/modules/investments.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID, seedCore, seedDemoData } from '../../../src/modules/seed.ts';
import { seedBilling } from '../../../src/modules/billing-seed.ts';
import { seedOpenFinance } from '../../../src/modules/openfinance-seed.ts';
import { seedInvestments } from '../../../src/modules/investments-seed.ts';
import { DoDb, type SqlStorageLike } from './sqlite.ts';
import { PURGE_CONFIRM_PHRASE, previewPurge, purgeDemoData } from '../../../src/modules/demo-purge.ts';

const TOKEN_TTL_SECONDS = 86_400;

interface MerchantServices {
  transactions: TransactionService;
  pix: PixService;
  fiscal: FiscalWorker;
  settlements: SettlementWorker;
  customers: CustomerService;
  billing: BillingService;
  subscriptions: SubscriptionService;
  openfinance: OpenFinanceService;
  investments: InvestmentService;
}

function demoConfig(masterKey: string): AppConfig {
  return {
    env: 'edge',
    isProduction: false,
    port: 0,
    host: '0.0.0.0',
    dbPath: ':memory:',
    demoMode: true,
    seedDemo: false,
    masterKey,
    tokenTtlSeconds: TOKEN_TTL_SECONDS,
    hmacWindowSeconds: 300,
    rateLimitPerMinute: 10_000,
    settlementIntervalMs: 60_000,
    subscriptionIntervalMs: 60_000,
    bankSessionTtlSeconds: 28_800,
    rsfn: { ispb: '' },
    fiscal: {
      uf: 'SP',
      cUF: '35',
      cMun: '3550308',
      ambiente: 'homologacao',
      serie: 1,
      rejectionPct: 0.05,
      latencyMs: 0,
      companyName: 'xPartner Demo',
    },
  };
}

function createServices(db: Db, config: AppConfig): MerchantServices {
  const transactions = new TransactionService(db, config);
  const pix = new PixService(db, config, transactions);
  const customers = new CustomerService(db);
  const billing = new BillingService(db, transactions, pix, customers);
  return {
    transactions,
    pix,
    fiscal: new FiscalWorker(db, config),
    settlements: new SettlementWorker(db, config),
    customers,
    billing,
    subscriptions: new SubscriptionService(db, billing, pix, customers),
    openfinance: new OpenFinanceService(db, billing, customers),
    investments: new InvestmentService(db),
  };
}

interface FiscalSeedRow {
  id: string;
  amount_cents: number;
  method: 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER';
  installments: number;
  nsu: string | null;
  created_at: string;
}

interface MerchantSeedRow {
  name: string;
  trade_name: string;
  document: string;
  ie: string | null;
  city: string;
  uf: string;
}

/**
 * NFC-e de demonstração gerada a partir das vendas aprovadas. O XML é claramente
 * identificado como demonstração e não é assinado — evita depender de chaves
 * privadas no edge e mantém a tela de notas fiscais útil.
 */
function seedFiscalDocuments(db: Db, merchantId: string): void {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM fiscal_documents').get() as { count: number };
  if (existing.count > 0) return;
  const merchant = db
    .prepare('SELECT name, trade_name, document, ie, city, uf FROM merchants WHERE id = ?')
    .get(merchantId) as MerchantSeedRow | undefined;
  if (!merchant) return;
  const rows = db
    .prepare(
      `SELECT id, amount_cents, method, installments, nsu, created_at
         FROM transactions
        WHERE merchant_id = ? AND status = 'APPROVED'
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(merchantId) as FiscalSeedRow[];
  if (!rows.length) return;

  const insert = db.prepare(
    `INSERT INTO fiscal_documents
       (id, transaction_id, merchant_id, status, serie, number, access_key, protocol, qr_code_url,
        rejection_reason, contingency, xml, danfe_text, escpos, attempts, issued_at, created_at)
     VALUES (?, ?, ?, 'AUTHORIZED', 1, ?, ?, ?, ?, NULL, 0, ?, ?, ?, 1, ?, ?)`,
  );
  const now = new Date().toISOString();
  rows.forEach((row, index) => {
    const emittedAt = new Date(row.created_at);
    const number = index + 1;
    const accessKey = generateAccessKey({
      cUF: '35',
      emittedAt,
      cnpj: merchant.document,
      serie: 1,
      number,
      tpEmis: '1',
      cNF: numericCodeFrom(row.id),
    });
    const qrCodeUrl = buildQrCodeUrl(accessKey, 'homologacao');
    const danfeText = buildDanfeText({
      merchant: {
        cnpj: merchant.document,
        legalName: merchant.name,
        tradeName: merchant.trade_name,
        ie: merchant.ie ?? '',
        city: merchant.city,
        uf: merchant.uf,
        cMun: '3550308',
        crt: '1',
      },
      accessKey,
      number,
      serie: 1,
      emittedAt,
      items: [],
      amountCents: row.amount_cents,
      method: row.method,
      installments: row.installments,
      nsu: row.nsu ?? '',
      contingency: false,
      qrCodeUrl,
    });
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<notaFiscalDemo chave="${accessKey}" ambiente="homologacao">`,
      `  <emitente cnpj="${merchant.document}" nome="${merchant.trade_name}"/>`,
      `  <total>${row.amount_cents}</total>`,
      '  <observacao>Documento de demonstração do xPartner Bank. Sem valor fiscal.</observacao>',
      '</notaFiscalDemo>',
    ].join('\n');
    const protocol = `135${sha256Hex(accessKey).replace(/\D/g, '').padEnd(12, '0').slice(0, 12)}`;
    insert.run(
      `fis_${row.id}`,
      row.id,
      merchantId,
      number,
      accessKey,
      protocol,
      qrCodeUrl,
      xml,
      danfeText,
      danfeText,
      row.created_at,
      now,
    );
  });
}

interface Claims {
  merchantId: string;
  scope: string;
}

type Json = Record<string, unknown>;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function errorResponse(error: unknown): Response {
  if (isAppError(error)) {
    return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  const message = error instanceof Error ? error.message : 'Falha interna.';
  return json({ error: { code: 'INTERNAL_ERROR', message } }, 500);
}

function publicMerchant(db: Db, merchantId: string) {
  return db
    .prepare('SELECT id, name, trade_name, document, mcc, city, uf, pix_key, status FROM merchants WHERE id = ?')
    .get(merchantId);
}

function assertMerchantScope(claims: Claims, merchantId: string | undefined): void {
  if (merchantId !== claims.merchantId) throw Errors.forbidden('Token não pertence a este estabelecimento.');
}

function assertDemo(): void {
  // O núcleo do DO só é montado em modo demonstração no edge.
}

export class MerchantCore {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly services: MerchantServices;
  private readonly tokenSecret: string;

  constructor(ctx: DurableObjectState) {
    const storage = ctx.storage.sql as unknown as SqlStorageLike;
    storage.exec('CREATE TABLE IF NOT EXISTS merchant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const existing = storage.exec("SELECT value FROM merchant_meta WHERE key = 'masterKey'").toArray();
    let masterKey = existing[0]?.value as string | undefined;
    if (!masterKey) {
      masterKey = randomSecret(32);
      storage.exec('INSERT INTO merchant_meta (key, value) VALUES (?, ?)', 'masterKey', masterKey);
    }

    this.db = new DoDb(storage);
    this.config = demoConfig(masterKey);
    this.services = createServices(this.db, this.config);
    this.tokenSecret = deriveSecret(masterKey, 'token');

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        migrate(this.db);
        seedCore(this.db);
        seedDemoData(this.db, this.config, this.services.transactions, this.services.pix);
        seedBilling(
          this.db,
          this.config,
          this.services.customers,
          this.services.billing,
          this.services.subscriptions,
        );
        seedOpenFinance(this.db, this.config, this.services.openfinance);
        seedInvestments(this.db, this.config, this.services.investments);
        seedFiscalDocuments(this.db, DEMO_MERCHANT_ID);
      });
    });
  }

  private issueToken(merchantId: string): string {
    return signToken(
      { sub: merchantId, merchantId, scope: 'demo:read demo:write' },
      this.tokenSecret,
      TOKEN_TTL_SECONDS,
    );
  }

  private authenticate(request: Request, write = false): Claims {
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw Errors.unauthorized('Token Bearer ausente.');
    const claims = verifyToken(header.slice('Bearer '.length).trim(), this.tokenSecret);
    const scopes = String(claims.scope).split(' ');
    if (write && !scopes.includes('demo:write') && !scopes.includes('*')) {
      throw Errors.forbidden('Escopo demo:write ausente.');
    }
    if (!write && !scopes.includes('demo:read') && !scopes.includes('*')) {
      throw Errors.forbidden('Escopo demo:read ausente.');
    }
    return { merchantId: claims.merchantId, scope: claims.scope };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const query = url.searchParams;
    const segments = path.split('/').filter(Boolean);
    const body = async (): Promise<Json> => {
      const text = await request.text();
      if (!text) return {};
      try {
        return JSON.parse(text) as Json;
      } catch {
        throw Errors.validation('Corpo JSON inválido.');
      }
    };
    const db = this.db;
    const services = this.services;

    // ── Limpeza de demonstração (chamada apenas pelo Worker) ───────────────
    // Durable Objects não têm URL pública: só o Worker reaches este caminho.
    if (path === '/internal/admin/demo-data' && method === 'GET') {
      return json(previewPurge(db));
    }
    if (path === '/internal/admin/demo-data/purge' && method === 'POST') {
      const payload = await body();
      if (payload.confirm !== PURGE_CONFIRM_PHRASE) {
        throw Errors.validation('Frase de confirmação ausente ou incorreta.');
      }
      return json(purgeDemoData(db, { actor: String(payload.actor ?? 'edge:worker') }));
    }

    // ── Sessão demo ────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/v1/auth/demo') {
      assertDemo();
      const payload = await body();
      const merchantId = (payload.merchantId as string | undefined) ?? DEMO_MERCHANT_ID;
      const merchant = publicMerchant(db, merchantId);
      if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
      return json({
        token: this.issueToken(merchantId),
        tokenType: 'Bearer',
        expiresIn: TOKEN_TTL_SECONDS,
        merchant,
      });
    }

    if (method === 'GET' && path === '/v1/demo/bootstrap') {
      assertDemo();
      const merchant = publicMerchant(db, DEMO_MERCHANT_ID);
      if (!merchant) throw Errors.notFound('Estabelecimento de demonstração não encontrado.');
      const terminals = db
        .prepare('SELECT id, serial, model, status FROM terminals WHERE merchant_id = ?')
        .all(DEMO_MERCHANT_ID);
      return json({
        token: this.issueToken(DEMO_MERCHANT_ID),
        tokenType: 'Bearer',
        expiresIn: TOKEN_TTL_SECONDS,
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
      });
    }

    if (method === 'POST' && path === '/v1/demo/sales') {
      assertDemo();
      this.authenticate(request, true);
      const payload = await body();
      const terminalId = (payload.terminalId as string | undefined) ?? DEMO_TERMINAL_ID;
      const saleMethod = String(payload.method ?? '').toUpperCase();
      const brand = (payload.brand as string | undefined) ?? 'visa';
      const last4 = (payload.last4 as string | undefined) ?? '4242';
      return json(
        services.transactions.createSale({
          merchantId: DEMO_MERCHANT_ID,
          terminalId,
          amountCents: Number(payload.amountCents),
          method: saleMethod,
          installments: payload.installments as number | undefined,
          paymentToken:
            saleMethod === 'PIX' ? undefined : devTokenFor(brand, last4, `${brand}:${last4}`),
          description: payload.description as string | undefined,
        }),
      );
    }

    if (method === 'POST' && path === '/v1/demo/pix') {
      assertDemo();
      this.authenticate(request, true);
      const payload = await body();
      if (!payload.amountCents) throw Errors.validation('amountCents é obrigatório.');
      return json(
        services.pix.createCharge({
          merchantId: DEMO_MERCHANT_ID,
          terminalId: DEMO_TERMINAL_ID,
          amountCents: Number(payload.amountCents),
          description: payload.description as string | undefined,
        }),
      );
    }

    // ── Transações ─────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/transactions') {
      const claims = this.authenticate(request);
      const limit = Number.parseInt(query.get('limit') ?? '25', 10) || 25;
      return json({ data: services.transactions.list(claims.merchantId, limit) });
    }

    if (method === 'GET' && segments.length === 3 && segments[1] === 'transactions') {
      const claims = this.authenticate(request);
      const row = services.transactions.getRow(segments[2]);
      assertMerchantScope(claims, row.merchant_id);
      return json({
        transaction: publicTransaction(row),
        fiscal: services.fiscal.getDocument(segments[2]),
        settlement: db.prepare('SELECT * FROM settlements WHERE transaction_id = ?').get(segments[2]) ?? null,
        ledger: db
          .prepare(
            `SELECT e.direction, e.amount_cents, a.kind, e.memo, e.created_at
               FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
              WHERE e.transaction_id = ? ORDER BY e.created_at ASC`,
          )
          .all(segments[2]),
      });
    }

    if (method === 'GET' && path === '/v1/overview') {
      const claims = this.authenticate(request);
      const overview = buildOverview(db, claims.merchantId);
      if (!overview) throw Errors.notFound('Estabelecimento não encontrado.');
      return json(overview);
    }

    // ── Fiscal ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/fiscal/recent') {
      const claims = this.authenticate(request);
      return json({ data: services.fiscal.listRecent(claims.merchantId, 20) });
    }

    if (method === 'GET' && segments.length === 3 && segments[1] === 'fiscal') {
      const claims = this.authenticate(request);
      const row = services.transactions.getRow(segments[2]);
      assertMerchantScope(claims, row.merchant_id);
      const document = services.fiscal.getDocument(segments[2]);
      if (!document) throw Errors.notFound('Nota fiscal ainda não emitida para esta transação.');
      return json(document);
    }

    // ── Pix ────────────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/v1/pix/charges') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      if (!payload.amountCents) throw Errors.validation('amountCents é obrigatório.');
      return json(
        services.pix.createCharge({
          merchantId: claims.merchantId,
          terminalId: (payload.terminalId as string | undefined) ?? DEMO_TERMINAL_ID,
          amountCents: Number(payload.amountCents),
          description: payload.description as string | undefined,
          expiresInSeconds: payload.expiresInSeconds as number | undefined,
        }),
      );
    }

    if (method === 'GET' && path === '/v1/pix/charges') {
      const claims = this.authenticate(request);
      return json({ data: services.pix.listCharges(claims.merchantId, 20) });
    }

    if (method === 'GET' && segments.length === 4 && segments[1] === 'pix' && segments[2] === 'charges') {
      const claims = this.authenticate(request);
      const result = services.pix.getCharge(segments[3]);
      assertMerchantScope(claims, result.transaction.merchantId);
      return json(result);
    }

    if (
      method === 'POST' &&
      segments.length === 5 &&
      segments[1] === 'pix' &&
      segments[2] === 'charges' &&
      segments[4] === 'simulate-payment'
    ) {
      assertDemo();
      const claims = this.authenticate(request, true);
      const current = services.pix.getCharge(segments[3]);
      assertMerchantScope(claims, current.transaction.merchantId);
      return json(services.pix.payCharge(segments[3]));
    }

    // ── Clientes ───────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/customers') {
      const claims = this.authenticate(request);
      return json({
        data: services.customers.list(claims.merchantId, {
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
          search: query.get('search') ?? undefined,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/customers') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      const customer = services.customers.create({
        merchantId: claims.merchantId,
        name: payload.name as string,
        document: payload.document as string,
        email: payload.email as string | undefined,
        phone: payload.phone as string | undefined,
        city: payload.city as string | undefined,
        uf: payload.uf as string | undefined,
      });
      return json({ customer }, 201);
    }

    if (segments.length === 3 && segments[1] === 'customers' && (method === 'GET' || method === 'PATCH')) {
      const claims = this.authenticate(request, method === 'PATCH');
      if (method === 'GET') return json(services.customers.get(claims.merchantId, segments[2]));
      const payload = await body();
      return json({
        customer: services.customers.update(claims.merchantId, segments[2], {
          name: payload.name as string | undefined,
          email: payload.email as string | null | undefined,
          phone: payload.phone as string | null | undefined,
          city: payload.city as string | null | undefined,
          uf: payload.uf as string | null | undefined,
          status: payload.status as string | undefined,
        }),
      });
    }

    if (method === 'DELETE' && segments.length === 3 && segments[1] === 'customers') {
      const claims = this.authenticate(request, true);
      return json(services.customers.archive(claims.merchantId, segments[2]));
    }

    // ── Boletos ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/boletos') {
      const claims = this.authenticate(request);
      return json({
        data: services.billing.listBoletos(claims.merchantId, {
          status: query.get('status') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/boletos') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        services.billing.createBoleto({
          merchantId: claims.merchantId,
          amountCents: Number(payload.amountCents),
          dueDate: payload.dueDate as string | undefined,
          description: payload.description as string | undefined,
          customerId: payload.customerId as string | undefined,
          payerName: payload.payerName as string | undefined,
          payerDocument: payload.payerDocument as string | undefined,
          terminalId: payload.terminalId as string | undefined,
        }),
        201,
      );
    }

    if (segments.length === 3 && segments[1] === 'boletos' && method === 'GET') {
      const claims = this.authenticate(request);
      return json(services.billing.getBoleto(claims.merchantId, segments[2]));
    }

    if (segments.length === 4 && segments[1] === 'boletos' && method === 'POST') {
      const claims = this.authenticate(request, true);
      if (segments[3] === 'pay') {
        assertDemo();
        const row = services.billing.findBoleto(claims.merchantId, segments[2]);
        return json(services.billing.payBoleto(row.id));
      }
      if (segments[3] === 'cancel') {
        return json({ boleto: services.billing.cancelBoleto(claims.merchantId, segments[2]) });
      }
    }

    // ── Links de pagamento ─────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/payment-links') {
      const claims = this.authenticate(request);
      return json({
        data: services.billing.listLinks(claims.merchantId, {
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/payment-links') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      const kind = String(payload.kind ?? '').toUpperCase();
      if (kind !== 'PIX' && kind !== 'BOLETO') throw Errors.validation('kind deve ser PIX ou BOLETO.');
      return json(
        services.billing.createLink({
          merchantId: claims.merchantId,
          amountCents: Number(payload.amountCents),
          kind,
          description: payload.description as string | undefined,
          customerId: payload.customerId as string | undefined,
          dueDate: payload.dueDate as string | undefined,
          payerName: payload.payerName as string | undefined,
          payerDocument: payload.payerDocument as string | undefined,
          expiresInSeconds: payload.expiresInSeconds as number | undefined,
          terminalId: payload.terminalId as string | undefined,
        }),
        201,
      );
    }

    if (segments.length === 3 && segments[1] === 'payment-links' && method === 'GET') {
      const claims = this.authenticate(request);
      return json(services.billing.getLink(claims.merchantId, segments[2]));
    }

    if (segments.length === 4 && segments[1] === 'payment-links' && method === 'POST') {
      const claims = this.authenticate(request, true);
      if (segments[3] === 'pay') {
        assertDemo();
        const row = services.billing.getLinkRowByCode(segments[2]);
        assertMerchantScope(claims, row.merchant_id);
        return json(services.billing.payLink(segments[2]));
      }
      if (segments[3] === 'cancel') {
        return json({ link: services.billing.cancelLink(claims.merchantId, segments[2]) });
      }
    }

    // ── Assinaturas e faturas ──────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/subscriptions') {
      const claims = this.authenticate(request);
      return json({
        data: services.subscriptions.list(claims.merchantId, {
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/subscriptions') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        services.subscriptions.create({
          merchantId: claims.merchantId,
          customerId: payload.customerId as string,
          description: payload.description as string,
          amountCents: Number(payload.amountCents),
          period: payload.period as string,
          method: payload.method as string,
          startDate: payload.startDate as string | undefined,
          terminalId: payload.terminalId as string | undefined,
        }),
        201,
      );
    }

    if (segments.length === 3 && segments[1] === 'subscriptions' && method === 'GET') {
      const claims = this.authenticate(request);
      return json(services.subscriptions.get(claims.merchantId, segments[2]));
    }

    if (segments.length === 4 && segments[1] === 'subscriptions' && method === 'POST') {
      const claims = this.authenticate(request, true);
      const status = ({ pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELED' } as const)[
        segments[3] as 'pause' | 'resume' | 'cancel'
      ];
      if (status) return json(services.subscriptions.setStatus(claims.merchantId, segments[2], status));
    }

    if (method === 'GET' && path === '/v1/subscription-invoices') {
      const claims = this.authenticate(request);
      return json({
        data: services.subscriptions.listInvoices(claims.merchantId, {
          status: query.get('status') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
        }),
      });
    }

    if (segments.length === 3 && segments[1] === 'subscription-invoices' && method === 'GET') {
      const claims = this.authenticate(request);
      services.subscriptions.ensureInvoice(claims.merchantId, segments[2]);
      return json(services.subscriptions.invoiceDetail(segments[2]));
    }

    if (segments.length === 4 && segments[1] === 'subscription-invoices' && method === 'POST') {
      const claims = this.authenticate(request, true);
      if (segments[3] === 'pay') {
        assertDemo();
        return json(services.subscriptions.payInvoice(claims.merchantId, segments[2]));
      }
      if (segments[3] === 'renew') {
        return json(services.subscriptions.renewInvoice(claims.merchantId, segments[2]));
      }
    }

    // ── Extrato e liquidações ──────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/statement') {
      const claims = this.authenticate(request);
      return json(
        services.billing.statement(claims.merchantId, {
          from: query.get('from') ?? undefined,
          to: query.get('to') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '200', 10) || 200,
        }),
      );
    }

    if (method === 'GET' && path === '/v1/statement.csv') {
      const claims = this.authenticate(request);
      const csv = services.billing.statementCsv(claims.merchantId, {
        from: query.get('from') ?? undefined,
        to: query.get('to') ?? undefined,
      });
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="extrato-xpartner.csv"',
          'cache-control': 'no-store',
        },
      });
    }

    if (method === 'GET' && path === '/v1/settlements') {
      const claims = this.authenticate(request);
      return json({
        data: services.billing.listSettlements(claims.merchantId, {
          status: query.get('status') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '50', 10) || 50,
        }),
      });
    }

    if (method === 'GET' && path === '/v1/app/overview') {
      const claims = this.authenticate(request);
      const overview = buildOverview(db, claims.merchantId);
      if (!overview) throw Errors.notFound('Estabelecimento não encontrado.');
      return json({
        overview,
        billing: services.billing.overview(claims.merchantId),
        boletos: services.billing.listBoletos(claims.merchantId, { limit: 6 }),
        links: services.billing.listLinks(claims.merchantId, { limit: 6 }),
        subscriptions: services.subscriptions.list(claims.merchantId, { limit: 6 }),
        invoices: services.subscriptions.listInvoices(claims.merchantId, { limit: 6 }),
        customers: services.customers.list(claims.merchantId, { limit: 6 }),
        settlements: services.billing.listSettlements(claims.merchantId, { limit: 6 }),
        statement: services.billing.statement(claims.merchantId, { limit: 20 }),
        openFinance: services.openfinance.overview(claims.merchantId),
        investments: services.investments.overview(claims.merchantId),
      });
    }

    // ── Open Finance ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/open-finance/overview') {
      const claims = this.authenticate(request);
      return json(services.openfinance.overview(claims.merchantId));
    }

    if (method === 'POST' && path === '/v1/open-finance/consents') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      const consent = services.openfinance.createConsent({
        merchantId: claims.merchantId,
        provider: payload.provider as string,
        providerCode: payload.providerCode as string,
        kind: payload.kind as 'DATA_SHARING' | 'EXTERNAL_DEBIT' | 'PAYMENT_INITIATION',
        customerId: payload.customerId as string | undefined,
        scopes: payload.scopes as string[] | undefined,
        expiresInDays: payload.expiresInDays as number | undefined,
        account: payload.account as {
          type: 'CHECKING' | 'SAVINGS' | 'PAYMENT';
          branch: string;
          number: string;
          holderName?: string;
          holderDocument?: string;
          balanceCents?: number;
        },
      });
      return json({ consent }, 201);
    }

    if (
      segments.length === 5 &&
      segments[1] === 'open-finance' &&
      segments[2] === 'consents' &&
      method === 'POST'
    ) {
      const claims = this.authenticate(request, true);
      const payload = await body();
      if (segments[4] === 'authorize') {
        return json({ consent: services.openfinance.authorize(claims.merchantId, segments[3]) });
      }
      if (segments[4] === 'reject') {
        return json({
          consent: services.openfinance.reject(claims.merchantId, segments[3], payload.reason as string | undefined),
        });
      }
      if (segments[4] === 'revoke') {
        return json({
          consent: services.openfinance.revoke(claims.merchantId, segments[3], payload.reason as string | undefined),
        });
      }
    }

    if (method === 'POST' && path === '/v1/open-finance/debits') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        {
          debit: services.openfinance.createDebit({
            merchantId: claims.merchantId,
            consentId: payload.consentId as string,
            amountCents: Number(payload.amountCents),
            description: payload.description as string | undefined,
            dueDate: payload.dueDate as string | undefined,
          }),
        },
        201,
      );
    }

    if (segments.length === 5 && segments[1] === 'open-finance' && segments[2] === 'debits' && method === 'POST') {
      const claims = this.authenticate(request, true);
      if (segments[4] === 'settle') {
        assertDemo();
        return json(services.openfinance.settleDebit(claims.merchantId, segments[3]));
      }
      if (segments[4] === 'cancel') {
        return json({ debit: services.openfinance.cancelDebit(claims.merchantId, segments[3]) });
      }
    }

    if (method === 'POST' && path === '/v1/open-finance/payments') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        {
          payment: services.openfinance.createPayment({
            merchantId: claims.merchantId,
            consentId: payload.consentId as string,
            amountCents: Number(payload.amountCents),
            pixKey: payload.pixKey as string,
            description: payload.description as string | undefined,
          }),
        },
        201,
      );
    }

    if (
      segments.length === 5 &&
      segments[1] === 'open-finance' &&
      segments[2] === 'payments' &&
      method === 'POST'
    ) {
      const claims = this.authenticate(request, true);
      if (segments[4] === 'settle') {
        assertDemo();
        return json({ payment: services.openfinance.settlePayment(claims.merchantId, segments[3]) });
      }
      if (segments[4] === 'cancel') {
        return json({ payment: services.openfinance.cancelPayment(claims.merchantId, segments[3]) });
      }
    }

    // ── Investimentos ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v1/investments/overview') {
      const claims = this.authenticate(request);
      return json(services.investments.overview(claims.merchantId));
    }

    if (method === 'GET' && path === '/v1/investments/products') {
      this.authenticate(request);
      return json({
        data: services.investments.listProducts({
          kind: query.get('kind') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '20', 10) || 20,
        }),
      });
    }

    if (method === 'GET' && path === '/v1/investments/positions') {
      const claims = this.authenticate(request);
      return json({
        data: services.investments.positions(claims.merchantId, {
          limit: Number.parseInt(query.get('limit') ?? '20', 10) || 20,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/investments/contributions') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        services.investments.invest({
          merchantId: claims.merchantId,
          productId: payload.productId as string,
          amountCents: Number(payload.amountCents),
        }),
        201,
      );
    }

    if (method === 'POST' && path === '/v1/investments/redemptions') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        services.investments.redeem({
          merchantId: claims.merchantId,
          positionId: payload.positionId as string,
          amountCents: Number(payload.amountCents),
        }),
      );
    }

    if (method === 'GET' && path === '/v1/investments/proventos') {
      const claims = this.authenticate(request);
      return json({
        data: services.investments.proventos(claims.merchantId, {
          status: query.get('status') ?? undefined,
          limit: Number.parseInt(query.get('limit') ?? '20', 10) || 20,
        }),
      });
    }

    if (method === 'POST' && path === '/v1/investments/proventos') {
      const claims = this.authenticate(request, true);
      const payload = await body();
      return json(
        {
          provento: services.investments.createProvento({
            merchantId: claims.merchantId,
            positionId: payload.positionId as string,
            kind: payload.kind as 'DIVIDENDO' | 'JCP' | 'RENDIMENTO',
            grossCents: Number(payload.grossCents),
            exDate: payload.exDate as string,
            paymentDate: payload.paymentDate as string,
          }),
        },
        201,
      );
    }

    // ── Checkout público ───────────────────────────────────────────────────
    if (segments.length === 4 && segments[1] === 'public' && segments[2] === 'links' && method === 'GET') {
      return json({ ...services.billing.linkDetail(segments[3]), demoMode: this.config.demoMode });
    }

    if (segments.length === 5 && segments[1] === 'public' && segments[2] === 'links' && method === 'POST') {
      assertDemo();
      return json({ ...services.billing.payLink(segments[3]), demoMode: true });
    }

    // ── Liquidação e antecipação ───────────────────────────────────────────
    if (segments.length === 3 && segments[1] === 'settlements' && method === 'GET') {
      const claims = this.authenticate(request);
      const row = services.transactions.getRow(segments[2]);
      assertMerchantScope(claims, row.merchant_id);
      return json(services.settlements.getByTransaction(segments[2]));
    }

    if (
      segments.length === 4 &&
      segments[1] === 'settlements' &&
      segments[3] === 'offer' &&
      method === 'GET'
    ) {
      const claims = this.authenticate(request);
      const row = services.transactions.getRow(segments[2]);
      assertMerchantScope(claims, row.merchant_id);
      return json(services.settlements.offer(segments[2]));
    }

    if (
      segments.length === 4 &&
      segments[1] === 'settlements' &&
      segments[3] === 'advance' &&
      method === 'POST'
    ) {
      const claims = this.authenticate(request, true);
      const row = services.transactions.getRow(segments[2]);
      assertMerchantScope(claims, row.merchant_id);
      return json(services.settlements.anticipate(segments[2]));
    }

    // ── Ledger, risco e adquirentes ────────────────────────────────────────
    if (method === 'GET' && path === '/v1/ledger/trial') {
      this.authenticate(request);
      return json({ trial: trialBalance(db), balances: listBalances(db) });
    }

    if (method === 'GET' && segments.length === 4 && segments[1] === 'ledger' && segments[2] === 'balances') {
      const claims = this.authenticate(request);
      assertMerchantScope(claims, segments[3]);
      return json({ data: listBalances(db, { ownerType: 'MERCHANT', ownerId: segments[3] }) });
    }

    if (method === 'GET' && path === '/v1/risk/overview') {
      const claims = this.authenticate(request);
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
      return json({
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
      });
    }

    if (method === 'GET' && path === '/v1/acquirers') {
      this.authenticate(request);
      return json({ data: listAcquirers(db) });
    }

    throw Errors.notFound(`Rota ${method} ${path} não encontrada no núcleo do lojista.`);
  }
}

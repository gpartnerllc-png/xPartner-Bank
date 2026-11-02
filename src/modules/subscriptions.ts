import type { Db } from '../kernel/db.ts';
import { addDays, audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { log } from '../kernel/logger.ts';
import { assertPositiveCents, formatBRL } from '../kernel/money.ts';
import { maskDocument } from '../domain/documents.ts';
import type { BillingService } from './billing.ts';
import type { CustomerService } from './customers.ts';
import type { PixService } from './pix.ts';

export type BillingPeriod = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export type SubscriptionMethod = 'PIX' | 'BOLETO';
const PERIODS: BillingPeriod[] = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
const METHODS: SubscriptionMethod[] = ['PIX', 'BOLETO'];

export interface SubscriptionRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  description: string;
  amount_cents: number;
  period: BillingPeriod;
  method: SubscriptionMethod;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELED';
  next_due_date: string;
  cycles: number;
  created_at: string;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  subscription_id: string;
  merchant_id: string;
  period_start: string;
  due_date: string;
  amount_cents: number;
  status: 'OPEN' | 'PAID' | 'OVERDUE' | 'CANCELED';
  boleto_id: string | null;
  pix_charge_id: string | null;
  transaction_id: string | null;
  paid_at: string | null;
  created_at: string;
}

interface SubscriptionJoinRow extends SubscriptionRow {
  customer_name: string;
  customer_document: string;
}

export interface CreateSubscriptionInput {
  merchantId: string;
  terminalId?: string;
  customerId: string;
  description: string;
  amountCents: number;
  period: string;
  method: string;
  startDate?: string;
  now?: number;
}

function isoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function assertIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DATE', 'Data deve estar no formato YYYY-MM-DD.', 422);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('INVALID_DATE', 'Data inexistente.', 422);
  }
  return value;
}

export function advancePeriod(date: string, period: BillingPeriod): string {
  if (period === 'WEEKLY') return addDays(`${date}T00:00:00.000Z`, 7).slice(0, 10);
  const months = period === 'MONTHLY' ? 1 : period === 'QUARTERLY' ? 3 : 12;
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

type InvoiceSummary = {
  id: string;
  status: string;
  dueDate: string;
  amountCents: number;
  paidAt: string | null;
};

function publicSubscription(row: SubscriptionJoinRow, invoices?: InvoiceSummary[]) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerDocumentMasked: maskDocument(row.customer_document),
    description: row.description,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    period: row.period,
    method: row.method,
    status: row.status,
    nextDueDate: row.next_due_date,
    cycles: row.cycles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(invoices ? { invoices } : {}),
  };
}

export class SubscriptionService {
  private readonly db: Db;
  private readonly billing: BillingService;
  private readonly pix: PixService;
  private readonly customers: CustomerService;

  constructor(db: Db, billing: BillingService, pix: PixService, customers: CustomerService) {
    this.db = db;
    this.billing = billing;
    this.pix = pix;
    this.customers = customers;
  }

  create(input: CreateSubscriptionInput) {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    const period = input.period.toUpperCase() as BillingPeriod;
    const method = input.method.toUpperCase() as SubscriptionMethod;
    if (!PERIODS.includes(period)) throw new AppError('INVALID_PERIOD', 'Periodicidade inválida.', 422);
    if (!METHODS.includes(method)) throw new AppError('INVALID_METHOD', 'Meio de cobrança da assinatura inválido.', 422);
    const merchant = this.billing.merchant(input.merchantId);
    const customer = this.customers.ensureCustomer(input.merchantId, input.customerId);
    if (method === 'PIX' && !merchant.pix_key) {
      throw new AppError('PIX_KEY_MISSING', 'Estabelecimento sem chave Pix para assinaturas.', 409);
    }
    this.billing.resolveTerminal(input.merchantId, input.terminalId);
    const amountCents = assertPositiveCents(input.amountCents);
    const description = input.description?.trim();
    if (!description) throw new AppError('INVALID_DESCRIPTION', 'Descrição da assinatura é obrigatória.', 422);
    const startDate = assertIsoDate(input.startDate ?? isoDate(now));

    const id = newId('sub', now);
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, merchant_id, customer_id, description, amount_cents, period, method, status,
            next_due_date, cycles, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 0, ?, ?)`,
      )
      .run(id, input.merchantId, customer.id, description.slice(0, 120), amountCents, period, method, startDate, createdAt, createdAt);
    audit(this.db, 'merchant', 'SUBSCRIPTION_CREATED', id, { period, method, amountCents });

    const row = this.getRow(id);
    try {
      this.generateInvoice(row, now);
    } catch (error) {
      this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
      throw error;
    }
    return this.get(input.merchantId, id);
  }

  getRow(subscriptionId: string): SubscriptionRow {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as
      | SubscriptionRow
      | undefined;
    if (!row) throw Errors.notFound('Assinatura não encontrada.');
    return row;
  }

  private getJoinRow(subscriptionId: string): SubscriptionJoinRow {
    const row = this.db
      .prepare(
        `SELECT s.*, c.name AS customer_name, c.document AS customer_document
           FROM subscriptions s JOIN customers c ON c.id = s.customer_id
          WHERE s.id = ?`,
      )
      .get(subscriptionId) as SubscriptionJoinRow | undefined;
    if (!row) throw Errors.notFound('Assinatura não encontrada.');
    return row;
  }

  ensureSubscription(merchantId: string, subscriptionId: string): SubscriptionJoinRow {
    const row = this.getJoinRow(subscriptionId);
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Assinatura não pertence ao estabelecimento.');
    return row;
  }

  list(merchantId: string, options: { limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT s.*, c.name AS customer_name, c.document AS customer_document
           FROM subscriptions s JOIN customers c ON c.id = s.customer_id
          WHERE s.merchant_id = ? ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(merchantId, limit) as unknown as SubscriptionJoinRow[];
    return rows.map((row) => publicSubscription(row));
  }

  get(merchantId: string, subscriptionId: string) {
    const row = this.ensureSubscription(merchantId, subscriptionId);
    const invoices = this.db
      .prepare('SELECT * FROM subscription_invoices WHERE subscription_id = ? ORDER BY due_date DESC LIMIT 24')
      .all(subscriptionId) as unknown as InvoiceRow[];
    return publicSubscription(
      row,
      invoices.map((invoice) => this.invoiceSummary(invoice, row)),
    );
  }

  private invoiceSummary(invoice: InvoiceRow, subscription: SubscriptionJoinRow) {
    return {
      id: invoice.id,
      subscriptionId: invoice.subscription_id,
      description: subscription.description,
      method: subscription.method,
      amountCents: invoice.amount_cents,
      amountFormatted: formatBRL(invoice.amount_cents),
      dueDate: invoice.due_date,
      status: invoice.status,
      paidAt: invoice.paid_at,
      transactionId: invoice.transaction_id,
      createdAt: invoice.created_at,
    };
  }

  generateInvoice(subscription: SubscriptionRow, now: number = Date.now()) {
    const dueDate = subscription.next_due_date;
    const existing = this.db
      .prepare('SELECT * FROM subscription_invoices WHERE subscription_id = ? AND period_start = ?')
      .get(subscription.id, dueDate) as InvoiceRow | undefined;
    if (existing) return this.invoiceDetail(existing.id);

    const join = this.getJoinRow(subscription.id);
    const terminalId = this.billing.resolveTerminal(subscription.merchant_id);
    const description = `Assinatura · ${subscription.description}`.slice(0, 120);

    let boletoId: string | null = null;
    let pixChargeId: string | null = null;
    let transactionId: string;

    if (subscription.method === 'BOLETO') {
      const created = this.billing.createBoleto({
        merchantId: subscription.merchant_id,
        terminalId,
        customerId: subscription.customer_id,
        amountCents: subscription.amount_cents,
        dueDate,
        description,
        payerName: join.customer_name,
        payerDocument: join.customer_document,
        now,
      });
      boletoId = created.boleto.id;
      transactionId = created.boleto.transactionId ?? '';
      if (!transactionId) throw new AppError('BOLETO_WITHOUT_TRANSACTION', 'Boleto sem transação vinculada.', 500);
    } else {
      const { charge } = this.pix.createCharge({
        merchantId: subscription.merchant_id,
        terminalId,
        amountCents: subscription.amount_cents,
        description,
        expiresInSeconds: 259_200,
        now,
      });
      pixChargeId = charge.id;
      transactionId = charge.transactionId;
    }

    const invoiceId = newId('inv', now);
    const createdAt = nowIso(now);
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO subscription_invoices
           (id, subscription_id, merchant_id, period_start, due_date, amount_cents, status,
            boleto_id, pix_charge_id, transaction_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      )
      .run(
        invoiceId,
        subscription.id,
        subscription.merchant_id,
        dueDate,
        dueDate,
        subscription.amount_cents,
        boletoId,
        pixChargeId,
        transactionId,
        createdAt,
      );
    if (insert.changes === 0) {
      return this.invoiceDetail(
        (this.db
          .prepare('SELECT * FROM subscription_invoices WHERE subscription_id = ? AND period_start = ?')
          .get(subscription.id, dueDate) as unknown as InvoiceRow).id,
      );
    }

    const nextDueDate = advancePeriod(dueDate, subscription.period);
    tx(this.db, () => {
      this.db
        .prepare("UPDATE transactions SET source = 'SUBSCRIPTION', updated_at = ? WHERE id = ? AND status = 'PENDING'")
        .run(createdAt, transactionId);
      this.db
        .prepare('UPDATE subscriptions SET next_due_date = ?, cycles = cycles + 1, updated_at = ? WHERE id = ?')
        .run(nextDueDate, createdAt, subscription.id);
      audit(this.db, 'merchant', 'SUBSCRIPTION_INVOICE_CREATED', invoiceId, {
        subscriptionId: subscription.id,
        dueDate,
        amountCents: subscription.amount_cents,
      });
    });
    return this.invoiceDetail(invoiceId);
  }

  invoiceDetail(invoiceId: string) {
    const invoice = this.db.prepare('SELECT * FROM subscription_invoices WHERE id = ?').get(invoiceId) as
      | InvoiceRow
      | undefined;
    if (!invoice) throw Errors.notFound('Fatura da assinatura não encontrada.');
    const subscription = this.getJoinRow(invoice.subscription_id);
    const base = {
      ...this.invoiceSummary(invoice, subscription),
      customer: {
        id: subscription.customer_id,
        name: subscription.customer_name,
        documentMasked: maskDocument(subscription.customer_document),
      },
    };
    if (invoice.boleto_id) {
      return {
        ...base,
        boleto: (() => {
          const boleto = this.billing.getBoletoRow(invoice.boleto_id!);
          return {
            id: boleto.id,
            ourNumber: boleto.our_number,
            barcode: boleto.barcode,
            digitableLine: boleto.digitable_line,
            dueDate: boleto.due_date,
            status: boleto.status,
          };
        })(),
      };
    }
    if (invoice.pix_charge_id) {
      const charge = this.db
        .prepare('SELECT txid, status, emv_payload, expires_at, paid_at FROM pix_charges WHERE id = ?')
        .get(invoice.pix_charge_id) as
        | { txid: string; status: string; emv_payload: string; expires_at: string; paid_at: string | null }
        | undefined;
      return {
        ...base,
        pix: charge
          ? {
              txid: charge.txid,
              status: charge.status,
              emvPayload: charge.emv_payload,
              expiresAt: charge.expires_at,
              paidAt: charge.paid_at,
            }
          : null,
      };
    }
    return base;
  }

  listInvoices(merchantId: string, options: { status?: string; limit?: number } = {}) {
    this.billing.refreshOverdue();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const status = options.status?.toUpperCase();
    if (status && !['OPEN', 'PAID', 'OVERDUE', 'CANCELED'].includes(status)) {
      throw new AppError('INVALID_STATUS', 'Status de fatura inválido.', 422);
    }
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT i.*, s.description, s.method, c.name AS customer_name, c.document AS customer_document
                 FROM subscription_invoices i
                 JOIN subscriptions s ON s.id = i.subscription_id
                 JOIN customers c ON c.id = s.customer_id
                WHERE i.merchant_id = ? AND i.status = ?
                ORDER BY i.due_date DESC LIMIT ?`,
            )
            .all(merchantId, status, limit)
        : this.db
            .prepare(
              `SELECT i.*, s.description, s.method, c.name AS customer_name, c.document AS customer_document
                 FROM subscription_invoices i
                 JOIN subscriptions s ON s.id = i.subscription_id
                 JOIN customers c ON c.id = s.customer_id
                WHERE i.merchant_id = ?
                ORDER BY i.due_date DESC LIMIT ?`,
            )
            .all(merchantId, limit)
    ) as unknown as Array<
      InvoiceRow & { description: string; method: SubscriptionMethod; customer_name: string; customer_document: string }
    >;
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      description: row.description,
      method: row.method,
      customerName: row.customer_name,
      customerDocumentMasked: maskDocument(row.customer_document),
      amountCents: row.amount_cents,
      amountFormatted: formatBRL(row.amount_cents),
      dueDate: row.due_date,
      status: row.status,
      paidAt: row.paid_at,
      transactionId: row.transaction_id,
      createdAt: row.created_at,
    }));
  }

  ensureInvoice(merchantId: string, invoiceId: string): InvoiceRow {
    const row = this.db.prepare('SELECT * FROM subscription_invoices WHERE id = ?').get(invoiceId) as
      | InvoiceRow
      | undefined;
    if (!row) throw Errors.notFound('Fatura da assinatura não encontrada.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Fatura não pertence ao estabelecimento.');
    return row;
  }

  payInvoice(merchantId: string, invoiceId: string, options: { paidAt?: number } = {}) {
    const invoice = this.ensureInvoice(merchantId, invoiceId);
    if (invoice.status === 'PAID') return this.invoiceDetail(invoice.id);
    if (invoice.status === 'CANCELED') throw new AppError('INVOICE_CANCELED', 'Fatura cancelada.', 409);

    const now = options.paidAt ?? Date.now();
    const paidAt = nowIso(now);
    if (invoice.boleto_id) {
      this.billing.payBoleto(invoice.boleto_id, { paidAt: now });
    } else if (invoice.pix_charge_id) {
      const charge = this.db
        .prepare('SELECT txid, status FROM pix_charges WHERE id = ?')
        .get(invoice.pix_charge_id) as { txid: string; status: string } | undefined;
      if (!charge) throw Errors.notFound('Cobrança Pix da fatura não encontrada.');
      if (charge.status === 'PAID') {
        // Sincroniza apenas o status local; o pagamento já foi conciliado.
      } else if (charge.status !== 'ACTIVE') {
        throw new AppError('PIX_CHARGE_CLOSED', 'Cobrança Pix expirada. Gere uma nova cobrança.', 409);
      } else {
        this.pix.payCharge(charge.txid, { paidAt: now });
      }
    } else {
      throw new AppError('INVOICE_WITHOUT_CHARGE', 'Fatura sem cobrança vinculada.', 500);
    }

    this.db
      .prepare("UPDATE subscription_invoices SET status = 'PAID', paid_at = ? WHERE id = ?")
      .run(paidAt, invoice.id);
    return this.invoiceDetail(invoice.id);
  }

  renewInvoice(merchantId: string, invoiceId: string, now: number = Date.now()) {
    const invoice = this.ensureInvoice(merchantId, invoiceId);
    if (invoice.status === 'PAID') throw new AppError('INVOICE_PAID', 'Fatura já paga.', 409);
    if (invoice.status === 'CANCELED') throw new AppError('INVOICE_CANCELED', 'Fatura cancelada.', 409);
    const subscription = this.getJoinRow(invoice.subscription_id);
    if (subscription.method !== 'PIX') {
      throw new AppError('RENEW_UNSUPPORTED', 'Renovação disponível apenas para faturas Pix.', 422);
    }
    const terminalId = this.billing.resolveTerminal(subscription.merchant_id);
    const previous = invoice.pix_charge_id;
    const { charge } = this.pix.createCharge({
      merchantId: subscription.merchant_id,
      terminalId,
      amountCents: invoice.amount_cents,
      description: `Assinatura · ${subscription.description}`.slice(0, 120),
      expiresInSeconds: 259_200,
      now,
    });
    tx(this.db, () => {
      if (previous) {
        const old = this.db.prepare('SELECT transaction_id, status FROM pix_charges WHERE id = ?').get(previous) as
          | { transaction_id: string; status: string }
          | undefined;
        if (old?.status === 'ACTIVE') {
          this.db.prepare("UPDATE pix_charges SET status = 'EXPIRED' WHERE id = ?").run(previous);
          this.db
            .prepare("UPDATE transactions SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status = 'PENDING'")
            .run(nowIso(now), old.transaction_id);
        }
      }
      this.db
        .prepare('UPDATE subscription_invoices SET pix_charge_id = ?, transaction_id = ? WHERE id = ?')
        .run(charge.id, charge.transactionId, invoice.id);
    });
    return this.invoiceDetail(invoice.id);
  }

  setStatus(merchantId: string, subscriptionId: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELED') {
    const subscription = this.ensureSubscription(merchantId, subscriptionId);
    if (subscription.status === 'CANCELED' && status !== 'CANCELED') {
      throw new AppError('SUBSCRIPTION_CANCELED', 'Assinatura cancelada não pode ser reativada.', 409);
    }
    this.db
      .prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), subscriptionId);
    audit(this.db, 'merchant', `SUBSCRIPTION_${status}`, subscriptionId);
    return this.get(merchantId, subscriptionId);
  }

  runDue(now: number = Date.now()): number {
    this.billing.refreshOverdue(now);
    const today = isoDate(now);
    const rows = this.db
      .prepare("SELECT * FROM subscriptions WHERE status = 'ACTIVE' AND next_due_date <= ? ORDER BY next_due_date LIMIT 25")
      .all(today) as unknown as SubscriptionRow[];
    let generated = 0;
    for (const row of rows) {
      try {
        this.generateInvoice(row, now);
        generated += 1;
      } catch (error) {
        log.error('subscription.invoice_failed', {
          subscriptionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return generated;
  }
}

export class SubscriptionWorker {
  private timer: NodeJS.Timeout | undefined;
  private readonly service: SubscriptionService;
  private readonly intervalMs: number;

  constructor(service: SubscriptionService, intervalMs = 30_000) {
    this.service = service;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.service.runDue();
      } catch (error) {
        log.error('subscription.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, this.intervalMs);
    this.timer.unref();
    this.service.runDue();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

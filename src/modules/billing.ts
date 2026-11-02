import type { Db } from '../kernel/db.ts';
import { addDays, audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { alphanumeric, newId } from '../kernel/ids.ts';
import { assertPositiveCents, formatBRL } from '../kernel/money.ts';
import {
  buildBarcode,
  buildFreeField,
  dueDateFactor,
  formatDigitableLine,
  isBarcode,
  toBarcode,
} from '../domain/boleto.ts';
import { assertDocument, maskDocument, normalizeName, onlyDigits } from '../domain/documents.ts';
import { routeTransaction } from '../domain/routing.ts';
import { settleReceivable } from './receivable-settlement.ts';
import type { CustomerService } from './customers.ts';
import type { PixService } from './pix.ts';
import type { TransactionService } from './transactions.ts';

const DESCRIPTION_MAX = 120;
const BOLETO_STATUSES = ['OPEN', 'PAID', 'OVERDUE', 'CANCELED'] as const;

type BoletoStatus = (typeof BOLETO_STATUSES)[number];

interface MerchantRow {
  id: string;
  name: string;
  trade_name: string;
  document: string;
  mcc: string;
  city: string;
  uf: string;
  pix_key: string | null;
  status: string;
}

export interface BoletoRow {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  transaction_id: string | null;
  our_number: string;
  barcode: string;
  digitable_line: string;
  amount_cents: number;
  due_date: string;
  description: string | null;
  payer_name: string;
  payer_document: string;
  status: BoletoStatus;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: string;
  merchant_id: string;
  code: string;
  kind: 'PIX' | 'BOLETO';
  amount_cents: number;
  description: string | null;
  status: 'ACTIVE' | 'PAID' | 'CANCELED';
  pix_charge_id: string | null;
  boleto_id: string | null;
  transaction_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBoletoInput {
  merchantId: string;
  terminalId?: string;
  customerId?: string;
  amountCents: number;
  dueDate?: string;
  description?: string;
  payerName?: string;
  payerDocument?: string;
  now?: number;
}

export interface CreateLinkInput {
  merchantId: string;
  terminalId?: string;
  kind: 'PIX' | 'BOLETO';
  amountCents: number;
  description?: string;
  customerId?: string;
  dueDate?: string;
  payerName?: string;
  payerDocument?: string;
  expiresInSeconds?: number;
  now?: number;
}

export function publicBoleto(row: BoletoRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    transactionId: row.transaction_id,
    ourNumber: row.our_number,
    barcode: row.barcode,
    digitableLine: row.digitable_line,
    digitableLineFormatted: formatDigitableLine(row.digitable_line),
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    dueDate: row.due_date,
    description: row.description,
    payerName: row.payer_name,
    payerDocumentMasked: maskDocument(row.payer_document),
    status: row.status,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export function publicLink(row: LinkRow) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    description: row.description,
    status: row.status,
    path: `/pay/${row.code}`,
    pixChargeId: row.pix_charge_id,
    boletoId: row.boleto_id,
    transactionId: row.transaction_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function todayIso(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function validateDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DUE_DATE', 'Vencimento deve estar no formato YYYY-MM-DD.', 422);
  }
  dueDateFactor(value);
  return value;
}

function rangeBounds(from?: string, to?: string): { fromIso: string; toIso: string } {
  const end = to ? (to.length === 10 ? `${to}T23:59:59.999Z` : to) : new Date().toISOString();
  const endMs = Date.parse(end);
  if (!Number.isFinite(endMs)) throw new AppError('INVALID_RANGE', 'Data final inválida.', 422);
  const start = from ? (from.length === 10 ? `${from}T00:00:00.000Z` : from) : new Date(endMs - 30 * 86_400_000).toISOString();
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) throw new AppError('INVALID_RANGE', 'Data inicial inválida.', 422);
  if (startMs > endMs) throw new AppError('INVALID_RANGE', 'Data inicial posterior à data final.', 422);
  return { fromIso: new Date(startMs).toISOString(), toIso: new Date(endMs).toISOString() };
}

export type ReceivableSource = 'BOLETO' | 'LINK' | 'SUBSCRIPTION' | 'OPEN_FINANCE';

/**
 * Cria a transação PENDING de uma cobrança Pix com a taxa roteada.
 * O chamador é responsável por confirmar a cobrança via `settleReceivable`.
 */
export function insertPendingPixTransaction(
  db: Db,
  input: {
    merchantId: string;
    terminalId: string;
    amountCents: number;
    description: string;
    source: ReceivableSource;
    now: number;
  },
): string {
  const routing = routeTransaction(db, { method: 'PIX', installments: 1, amountCents: input.amountCents });
  const transactionId = newId('txn', input.now);
  const createdAt = nowIso(input.now);
  const feeCents = routing.selected.feeCents;
  db.prepare(
    `INSERT INTO transactions (
       id, merchant_id, terminal_id, amount_cents, currency, method, installments, status,
       acquirer_id, brand, risk_score, risk_decision, fee_cents, net_cents, description,
       fiscal_status, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'BRL', 'PIX', 1, 'PENDING', ?, 'Pix', 0, 'APPROVE', ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    transactionId,
    input.merchantId,
    input.terminalId,
    input.amountCents,
    routing.selected.acquirerId,
    feeCents,
    input.amountCents - feeCents,
    input.description.slice(0, DESCRIPTION_MAX),
    input.source,
    createdAt,
    createdAt,
  );
  return transactionId;
}

export class BillingService {
  private readonly db: Db;
  private readonly transactions: TransactionService;
  private readonly pix: PixService;
  private readonly customers: CustomerService;

  constructor(db: Db, transactions: TransactionService, pix: PixService, customers: CustomerService) {
    this.db = db;
    this.transactions = transactions;
    this.pix = pix;
    this.customers = customers;
  }

  merchant(merchantId: string): MerchantRow {
    const merchant = this.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchantId) as
      | MerchantRow
      | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);
    return merchant;
  }

  resolveTerminal(merchantId: string, terminalId?: string): string {
    if (terminalId) {
      const terminal = this.db.prepare('SELECT id, merchant_id, status FROM terminals WHERE id = ?').get(terminalId) as
        | { id: string; merchant_id: string; status: string }
        | undefined;
      if (!terminal || terminal.merchant_id !== merchantId) throw Errors.notFound('Terminal não encontrado.');
      if (terminal.status !== 'ACTIVE') throw new AppError('TERMINAL_BLOCKED', 'Terminal bloqueado.', 409);
      return terminal.id;
    }
    const row = this.db
      .prepare("SELECT id FROM terminals WHERE merchant_id = ? AND status = 'ACTIVE' ORDER BY created_at LIMIT 1")
      .get(merchantId) as { id: string } | undefined;
    if (!row) throw new AppError('NO_TERMINAL', 'Estabelecimento sem terminal ativo.', 409);
    return row.id;
  }

  private merchantSuffix(merchantId: string): number {
    let hash = 7;
    for (const char of merchantId) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000;
    return hash;
  }

  private nextOurNumber(merchantId: string): number {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM boletos WHERE merchant_id = ?').get(merchantId) as {
      count: number;
    };
    let sequence = count.count + 1;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const ourNumber = String(sequence).padStart(11, '0');
      const exists = this.db
        .prepare('SELECT 1 AS found FROM boletos WHERE merchant_id = ? AND our_number = ?')
        .get(merchantId, ourNumber);
      if (!exists) return sequence;
      sequence += 1;
    }
    throw new AppError('BOLETO_SEQUENCE_EXHAUSTED', 'Não foi possível gerar o nosso número.', 500);
  }

  private insertPendingTransaction(input: {
    merchantId: string;
    terminalId: string;
    amountCents: number;
    description: string;
    source: ReceivableSource;
    now: number;
  }): string {
    return insertPendingPixTransaction(this.db, input);
  }

  // ── Boleto ────────────────────────────────────────────────────────────────
  createBoleto(input: CreateBoletoInput) {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    this.merchant(input.merchantId);
    const terminalId = this.resolveTerminal(input.merchantId, input.terminalId);
    const amountCents = assertPositiveCents(input.amountCents);
    const customer = input.customerId ? this.customers.ensureCustomer(input.merchantId, input.customerId) : null;
    const payerName = normalizeName(input.payerName?.trim() || customer?.name || '');
    const payer = assertDocument(input.payerDocument?.trim() || customer?.document || '', 'documento do pagador');
    const dueDate = validateDueDate(input.dueDate ?? addDays(createdAt, 7).slice(0, 10));
    const description = (input.description?.trim() || 'Cobrança por boleto').slice(0, DESCRIPTION_MAX);

    const sequence = this.nextOurNumber(input.merchantId);
    const ourNumber = String(sequence).padStart(11, '0');
    const parts = buildBarcode({
      freeField: buildFreeField(this.merchantSuffix(input.merchantId), sequence),
      dueDate,
      amountCents,
    });

    const boletoId = newId('bol', now);
    const transactionId = tx(this.db, () => {
      const id = this.insertPendingTransaction({
        merchantId: input.merchantId,
        terminalId,
        amountCents,
        description: `Boleto ${ourNumber} · ${description}`,
        source: 'BOLETO',
        now,
      });
      this.db
        .prepare(
          `INSERT INTO boletos
             (id, merchant_id, customer_id, transaction_id, our_number, barcode, digitable_line,
              amount_cents, due_date, description, payer_name, payer_document, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        )
        .run(
          boletoId,
          input.merchantId,
          customer?.id ?? null,
          id,
          ourNumber,
          parts.barcode,
          parts.digitableLine,
          amountCents,
          dueDate,
          description,
          payerName,
          payer.document,
          createdAt,
          createdAt,
        );
      audit(this.db, terminalId, 'BOLETO_CREATED', boletoId, { ourNumber, amountCents, dueDate });
      return id;
    });

    return {
      boleto: publicBoleto(this.getBoletoRow(boletoId)),
      transaction: this.transactions.getTransaction(transactionId),
    };
  }

  getBoletoRow(boletoId: string): BoletoRow {
    const row = this.db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId) as BoletoRow | undefined;
    if (!row) throw Errors.notFound('Boleto não encontrado.');
    return row;
  }

  findBoleto(merchantId: string, reference: string): BoletoRow {
    const ref = String(reference ?? '').trim();
    if (!ref) throw Errors.validation('Referência do boleto é obrigatória.');
    const attempts: Array<{ sql: string; value: string }> = [];
    if (ref.startsWith('bol_')) attempts.push({ sql: 'id = ?', value: ref });
    const digits = onlyDigits(ref);
    if (digits.length === 44 || digits.length === 47) {
      const barcode = isBarcode(digits) ? digits : toBarcode(digits);
      attempts.push({ sql: 'barcode = ?', value: barcode });
    }
    if (digits.length > 0 && digits.length <= 20) {
      attempts.push({ sql: 'our_number = ?', value: digits.padStart(11, '0') });
      attempts.push({ sql: 'our_number = ?', value: digits });
    }
    for (const attempt of attempts) {
      const row = this.db
        .prepare(`SELECT * FROM boletos WHERE merchant_id = ? AND ${attempt.sql}`)
        .get(merchantId, attempt.value) as BoletoRow | undefined;
      if (row) return row;
    }
    throw Errors.notFound('Boleto não encontrado.');
  }

  payBoleto(reference: string, options: { paidAt?: number } = {}) {
    const row = this.lookupAnyBoleto(reference);
    if (!row.transaction_id) throw new AppError('BOLETO_WITHOUT_TRANSACTION', 'Boleto sem transação vinculada.', 500);
    if (row.status === 'PAID') {
      return { boleto: publicBoleto(row), transaction: this.transactions.getTransaction(row.transaction_id) };
    }
    if (row.status === 'CANCELED') throw new AppError('BOLETO_CANCELED', 'Boleto cancelado.', 409);

    const now = options.paidAt ?? Date.now();
    const paidAt = nowIso(now);
    tx(this.db, () => {
      settleReceivable(this.db, row.transaction_id!, {
        paidAt,
        nsu: row.our_number,
        channel: 'BOLETO',
        settlementAt: addDays(paidAt, 1),
      });
      this.db
        .prepare("UPDATE boletos SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?")
        .run(paidAt, paidAt, row.id);
      this.db
        .prepare("UPDATE payment_links SET status = 'PAID', transaction_id = ?, updated_at = ? WHERE boleto_id = ? AND status = 'ACTIVE'")
        .run(row.transaction_id, paidAt, row.id);
      this.db
        .prepare(
          `UPDATE subscription_invoices SET status = 'PAID', paid_at = ?, transaction_id = ?
            WHERE boleto_id = ? AND status IN ('OPEN','OVERDUE')`,
        )
        .run(paidAt, row.transaction_id, row.id);
    });

    return {
      boleto: publicBoleto(this.getBoletoRow(row.id)),
      transaction: this.transactions.getTransaction(row.transaction_id),
    };
  }

  private lookupAnyBoleto(reference: string): BoletoRow {
    const ref = String(reference ?? '').trim();
    if (!ref) throw Errors.validation('Referência do boleto é obrigatória.');
    if (ref.startsWith('bol_')) {
      const row = this.db.prepare('SELECT * FROM boletos WHERE id = ?').get(ref) as BoletoRow | undefined;
      if (row) return row;
    }
    const digits = onlyDigits(ref);
    if (digits.length === 44 || digits.length === 47) {
      const barcode = isBarcode(digits) ? digits : toBarcode(digits);
      const row = this.db.prepare('SELECT * FROM boletos WHERE barcode = ?').get(barcode) as BoletoRow | undefined;
      if (row) return row;
    }
    if (digits.length > 0 && digits.length <= 20) {
      const row = this.db
        .prepare('SELECT * FROM boletos WHERE our_number = ?')
        .get(digits.padStart(11, '0')) as BoletoRow | undefined;
      if (row) return row;
    }
    throw Errors.notFound('Boleto não encontrado.');
  }

  refreshOverdue(now: number = Date.now()): number {
    const timestamp = nowIso(now);
    const today = todayIso(now);
    const boletos = this.db
      .prepare("UPDATE boletos SET status = 'OVERDUE', updated_at = ? WHERE status = 'OPEN' AND due_date < ?")
      .run(timestamp, today);
    this.db
      .prepare("UPDATE subscription_invoices SET status = 'OVERDUE' WHERE status = 'OPEN' AND due_date < ?")
      .run(today);
    return Number(boletos.changes);
  }

  listBoletos(merchantId: string, options: { status?: string; limit?: number } = {}) {
    this.refreshOverdue();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const status = options.status?.toUpperCase();
    if (status && !BOLETO_STATUSES.includes(status as BoletoStatus)) {
      throw new AppError('INVALID_STATUS', 'Status de boleto inválido.', 422);
    }
    const rows = (
      status
        ? this.db
            .prepare('SELECT * FROM boletos WHERE merchant_id = ? AND status = ? ORDER BY due_date DESC LIMIT ?')
            .all(merchantId, status, limit)
        : this.db
            .prepare('SELECT * FROM boletos WHERE merchant_id = ? ORDER BY due_date DESC LIMIT ?')
            .all(merchantId, limit)
    ) as unknown as BoletoRow[];
    return rows.map(publicBoleto);
  }

  getBoleto(merchantId: string, reference: string) {
    const row = this.findBoleto(merchantId, reference);
    return {
      boleto: publicBoleto(row),
      transaction: row.transaction_id ? this.transactions.getTransaction(row.transaction_id) : null,
    };
  }

  cancelBoleto(merchantId: string, reference: string) {
    const row = this.findBoleto(merchantId, reference);
    if (row.status === 'PAID') throw new AppError('BOLETO_PAID', 'Boleto já pago não pode ser cancelado.', 409);
    if (row.status === 'CANCELED') return publicBoleto(row);
    const timestamp = nowIso();
    tx(this.db, () => {
      this.db
        .prepare("UPDATE boletos SET status = 'CANCELED', updated_at = ? WHERE id = ?")
        .run(timestamp, row.id);
      if (row.transaction_id) {
        this.db
          .prepare("UPDATE transactions SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status = 'PENDING'")
          .run(timestamp, row.transaction_id);
      }
      this.db
        .prepare("UPDATE payment_links SET status = 'CANCELED', updated_at = ? WHERE boleto_id = ? AND status = 'ACTIVE'")
        .run(timestamp, row.id);
      audit(this.db, 'merchant', 'BOLETO_CANCELED', row.id, { ourNumber: row.our_number });
    });
    return publicBoleto(this.getBoletoRow(row.id));
  }

  // ── Links de pagamento ────────────────────────────────────────────────────
  createLink(input: CreateLinkInput) {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    this.merchant(input.merchantId);
    const terminalId = this.resolveTerminal(input.merchantId, input.terminalId);
    const amountCents = assertPositiveCents(input.amountCents);
    const description = (input.description?.trim() || 'Link de pagamento').slice(0, DESCRIPTION_MAX);

    let pixChargeId: string | null = null;
    let boletoId: string | null = null;
    let transactionId: string;
    let expiresAt: string;

    if (input.kind === 'PIX') {
      const { charge } = this.pix.createCharge({
        merchantId: input.merchantId,
        terminalId,
        amountCents,
        description,
        expiresInSeconds: input.expiresInSeconds ?? 86_400,
        now,
      });
      pixChargeId = charge.id;
      transactionId = charge.transactionId;
      expiresAt = charge.expiresAt;
    } else {
      const dueDate = validateDueDate(input.dueDate ?? addDays(createdAt, 7).slice(0, 10));
      const created = this.createBoleto({
        merchantId: input.merchantId,
        terminalId,
        customerId: input.customerId,
        amountCents,
        dueDate,
        description,
        payerName: input.payerName,
        payerDocument: input.payerDocument,
        now,
      });
      boletoId = created.boleto.id;
      transactionId = created.boleto.transactionId ?? '';
      if (!transactionId) throw new AppError('BOLETO_WITHOUT_TRANSACTION', 'Boleto sem transação vinculada.', 500);
      expiresAt = `${dueDate}T23:59:59.999Z`;
    }

    const code = this.generateCode();
    const id = newId('lnk', now);
    this.db
      .prepare(
        `INSERT INTO payment_links
           (id, merchant_id, code, kind, amount_cents, description, status, pix_charge_id, boleto_id,
            transaction_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.merchantId,
        code,
        input.kind,
        amountCents,
        description,
        pixChargeId,
        boletoId,
        transactionId,
        expiresAt,
        createdAt,
        createdAt,
      );
    this.db
      .prepare("UPDATE transactions SET source = 'LINK', updated_at = ? WHERE id = ? AND status = 'PENDING'")
      .run(createdAt, transactionId);
    audit(this.db, terminalId, 'PAYMENT_LINK_CREATED', id, { code, kind: input.kind, amountCents });

    return this.linkDetail(code);
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = alphanumeric(10);
      const existing = this.db.prepare('SELECT 1 AS found FROM payment_links WHERE code = ?').get(code);
      if (!existing) return code;
    }
    throw new AppError('LINK_CODE_EXHAUSTED', 'Não foi possível gerar o código do link.', 500);
  }

  getLinkRowByCode(code: string): LinkRow {
    const row = this.db.prepare('SELECT * FROM payment_links WHERE code = ?').get(code) as LinkRow | undefined;
    if (!row) throw Errors.notFound('Link de pagamento não encontrado.');
    return row;
  }

  private syncLink(linkId: string): void {
    const link = this.db.prepare('SELECT * FROM payment_links WHERE id = ?').get(linkId) as LinkRow | undefined;
    if (!link || link.status !== 'ACTIVE') return;

    let paidTransactionId: string | null = null;
    if (link.pix_charge_id) {
      const charge = this.db
        .prepare('SELECT transaction_id, status FROM pix_charges WHERE id = ?')
        .get(link.pix_charge_id) as { transaction_id: string; status: string } | undefined;
      if (charge?.status === 'PAID') paidTransactionId = charge.transaction_id;
      else if (charge?.status === 'EXPIRED' || charge?.status === 'CANCELED') {
        this.db
          .prepare("UPDATE payment_links SET status = 'CANCELED', updated_at = ? WHERE id = ?")
          .run(nowIso(), link.id);
        return;
      }
    }
    if (!paidTransactionId && link.boleto_id) {
      const boleto = this.db
        .prepare('SELECT transaction_id, status FROM boletos WHERE id = ?')
        .get(link.boleto_id) as { transaction_id: string | null; status: string } | undefined;
      if (boleto?.status === 'PAID' && boleto.transaction_id) paidTransactionId = boleto.transaction_id;
      else if (boleto?.status === 'CANCELED') {
        this.db
          .prepare("UPDATE payment_links SET status = 'CANCELED', updated_at = ? WHERE id = ?")
          .run(nowIso(), link.id);
        return;
      }
    }

    if (paidTransactionId) {
      this.db
        .prepare("UPDATE payment_links SET status = 'PAID', transaction_id = ?, updated_at = ? WHERE id = ?")
        .run(paidTransactionId, nowIso(), link.id);
      return;
    }

    if (link.expires_at && Date.parse(link.expires_at) < Date.now()) {
      this.db.prepare("UPDATE payment_links SET status = 'CANCELED', updated_at = ? WHERE id = ?").run(nowIso(), link.id);
    }
  }

  linkDetail(code: string) {
    const current = this.getLinkRowByCode(code);
    this.syncLink(current.id);
    const link = this.db.prepare('SELECT * FROM payment_links WHERE id = ?').get(current.id) as unknown as LinkRow;
    const merchant = this.merchant(link.merchant_id);
    const base = {
      link: publicLink(link),
      merchant: {
        id: merchant.id,
        tradeName: merchant.trade_name,
        city: merchant.city,
        uf: merchant.uf,
      },
    };
    if (link.kind === 'PIX' && link.pix_charge_id) {
      const charge = this.db
        .prepare('SELECT * FROM pix_charges WHERE id = ?')
        .get(link.pix_charge_id) as
        | {
            id: string;
            txid: string;
            amount_cents: number;
            status: string;
            emv_payload: string;
            expires_at: string;
            paid_at: string | null;
            transaction_id: string;
          }
        | undefined;
      if (charge) {
        return {
          ...base,
          pix: {
            txid: charge.txid,
            status: charge.status,
            emvPayload: charge.emv_payload,
            expiresAt: charge.expires_at,
            paidAt: charge.paid_at,
            transactionId: charge.transaction_id,
          },
        };
      }
    }
    if (link.kind === 'BOLETO' && link.boleto_id) {
      const boleto = this.getBoletoRow(link.boleto_id);
      return { ...base, boleto: publicBoleto(boleto) };
    }
    return base;
  }

  getLink(merchantId: string, code: string) {
    const row = this.getLinkRowByCode(code);
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Link não pertence ao estabelecimento.');
    return this.linkDetail(code);
  }

  listLinks(merchantId: string, options: { limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const rows = this.db
      .prepare('SELECT * FROM payment_links WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(merchantId, limit) as unknown as LinkRow[];
    for (const row of rows) this.syncLink(row.id);
    return rows.map((row) => {
      const fresh = this.db.prepare('SELECT * FROM payment_links WHERE id = ?').get(row.id) as unknown as LinkRow;
      return publicLink(fresh);
    });
  }

  payLink(code: string, options: { paidAt?: number } = {}) {
    const row = this.getLinkRowByCode(code);
    this.syncLink(row.id);
    const link = this.db.prepare('SELECT * FROM payment_links WHERE id = ?').get(row.id) as unknown as LinkRow;
    if (link.status === 'PAID') return this.linkDetail(code);
    if (link.status === 'CANCELED') throw new AppError('LINK_CLOSED', 'Link não está mais disponível.', 409);

    const now = options.paidAt ?? Date.now();
    if (link.kind === 'PIX') {
      const charge = this.db
        .prepare('SELECT txid FROM pix_charges WHERE id = ?')
        .get(link.pix_charge_id) as { txid: string } | undefined;
      if (!charge) throw Errors.notFound('Cobrança Pix do link não encontrada.');
      this.pix.payCharge(charge.txid, { paidAt: now });
    } else {
      if (!link.boleto_id) throw Errors.notFound('Boleto do link não encontrado.');
      this.payBoleto(link.boleto_id, { paidAt: now });
    }
    this.db
      .prepare("UPDATE payment_links SET status = 'PAID', updated_at = ? WHERE id = ?")
      .run(nowIso(now), link.id);
    return this.linkDetail(code);
  }

  cancelLink(merchantId: string, code: string) {
    const row = this.getLinkRowByCode(code);
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Link não pertence ao estabelecimento.');
    if (row.status === 'PAID') throw new AppError('LINK_PAID', 'Link já pago não pode ser cancelado.', 409);
    if (row.status === 'CANCELED') return publicLink(row);
    const timestamp = nowIso();
    tx(this.db, () => {
      if (row.pix_charge_id) {
        const charge = this.db
          .prepare('SELECT transaction_id, status FROM pix_charges WHERE id = ?')
          .get(row.pix_charge_id) as { transaction_id: string; status: string } | undefined;
        if (charge?.status === 'ACTIVE') {
          this.db.prepare("UPDATE pix_charges SET status = 'EXPIRED' WHERE id = ?").run(row.pix_charge_id);
          this.db
            .prepare("UPDATE transactions SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status = 'PENDING'")
            .run(timestamp, charge.transaction_id);
        }
      }
      if (row.boleto_id) {
        const boleto = this.db
          .prepare('SELECT transaction_id, status FROM boletos WHERE id = ?')
          .get(row.boleto_id) as { transaction_id: string | null; status: string } | undefined;
        if (boleto && boleto.status !== 'PAID') {
          this.db
            .prepare("UPDATE boletos SET status = 'CANCELED', updated_at = ? WHERE id = ?")
            .run(timestamp, row.boleto_id);
          if (boleto.transaction_id) {
            this.db
              .prepare("UPDATE transactions SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status = 'PENDING'")
              .run(timestamp, boleto.transaction_id);
          }
        }
      }
      this.db
        .prepare("UPDATE payment_links SET status = 'CANCELED', updated_at = ? WHERE id = ?")
        .run(timestamp, row.id);
      audit(this.db, 'merchant', 'PAYMENT_LINK_CANCELED', row.id, { code: row.code });
    });
    return publicLink(this.db.prepare('SELECT * FROM payment_links WHERE id = ?').get(row.id) as unknown as LinkRow);
  }

  // ── Extrato e liquidações ─────────────────────────────────────────────────
  statement(merchantId: string, options: { from?: string; to?: string; limit?: number } = {}) {
    this.merchant(merchantId);
    const { fromIso, toIso } = rangeBounds(options.from, options.to);
    const limit = Math.min(1000, Math.max(1, options.limit ?? 200));
    const rows = this.db
      .prepare(
        `SELECT e.id, e.entry_group AS entryGroup, e.group_kind AS groupKind, e.transaction_id AS transactionId,
                a.kind, e.direction, e.amount_cents AS amountCents, e.memo, e.created_at AS createdAt,
                t.description, t.method, t.source
           FROM ledger_entries e
           JOIN accounts a ON a.id = e.account_id
           LEFT JOIN transactions t ON t.id = e.transaction_id
          WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ?
            AND e.created_at >= ? AND e.created_at <= ?
          ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(merchantId, fromIso, toIso, limit) as Array<{
      id: string;
      entryGroup: string;
      groupKind: string;
      transactionId: string | null;
      kind: string;
      direction: 'DEBIT' | 'CREDIT';
      amountCents: number;
      memo: string | null;
      createdAt: string;
      description: string | null;
      method: string | null;
      source: string | null;
    }>;

    const summaryRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN a.kind = 'MERCHANT_PAYABLE' AND e.direction = 'CREDIT' THEN e.amount_cents ELSE 0 END), 0) AS inflowCents,
           COALESCE(SUM(CASE WHEN a.kind = 'MERCHANT_AVAILABLE' AND e.direction = 'CREDIT' THEN e.amount_cents ELSE 0 END), 0) AS settledCents,
           COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_cents ELSE 0 END), 0) AS outflowCents
         FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ? AND e.created_at >= ? AND e.created_at <= ?`,
      )
      .get(merchantId, fromIso, toIso) as { inflowCents: number; settledCents: number; outflowCents: number };

    const balances = this.db
      .prepare(
        `SELECT a.kind,
                COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents END), 0) -
                COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_cents END), 0) AS balanceCents
           FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ? GROUP BY a.kind`,
      )
      .all(merchantId) as Array<{ kind: string; balanceCents: number }>;
    const balanceOf = (kind: string) => balances.find((row) => row.kind === kind)?.balanceCents ?? 0;

    const entries = rows.map((row) => {
      const signed = row.direction === 'CREDIT' ? row.amountCents : -row.amountCents;
      return {
        id: row.id,
        transactionId: row.transactionId,
        description: row.description ?? row.memo ?? 'Lançamento',
        memo: row.memo,
        accountKind: row.kind,
        groupKind: row.groupKind,
        direction: row.direction,
        amountCents: row.amountCents,
        signedCents: signed,
        amountFormatted: `${signed < 0 ? '-' : '+'}${formatBRL(Math.abs(signed))}`,
        method: row.method,
        source: row.source,
        createdAt: row.createdAt,
      };
    });

    return {
      period: { from: fromIso, to: toIso },
      summary: {
        inflowCents: summaryRow.inflowCents,
        inflowFormatted: formatBRL(summaryRow.inflowCents),
        settledCents: summaryRow.settledCents,
        settledFormatted: formatBRL(summaryRow.settledCents),
        outflowCents: summaryRow.outflowCents,
        outflowFormatted: formatBRL(summaryRow.outflowCents),
        availableCents: balanceOf('MERCHANT_AVAILABLE'),
        availableFormatted: formatBRL(balanceOf('MERCHANT_AVAILABLE')),
        receivableCents: balanceOf('MERCHANT_PAYABLE'),
        receivableFormatted: formatBRL(balanceOf('MERCHANT_PAYABLE')),
      },
      entries,
    };
  }

  statementCsv(merchantId: string, options: { from?: string; to?: string } = {}): string {
    const statement = this.statement(merchantId, { ...options, limit: 1000 });
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      ['data', 'descricao', 'tipo', 'direcao', 'valor', 'transacao'].map(escape).join(';'),
      ...statement.entries.map((entry) =>
        [
          new Date(entry.createdAt).toLocaleString('pt-BR'),
          entry.description,
          entry.accountKind,
          entry.direction,
          (entry.signedCents / 100).toFixed(2).replace('.', ','),
          entry.transactionId ?? '',
        ]
          .map((value) => escape(String(value)))
          .join(';'),
      ),
    ];
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  listSettlements(merchantId: string, options: { status?: string; limit?: number } = {}) {
    this.merchant(merchantId);
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const status = options.status?.toUpperCase();
    if (status && !['PENDING', 'PAID', 'CANCELED'].includes(status)) {
      throw new AppError('INVALID_STATUS', 'Status de liquidação inválido.', 422);
    }
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT s.*, t.description, t.method, t.source
                 FROM settlements s JOIN transactions t ON t.id = s.transaction_id
                WHERE t.merchant_id = ? AND s.status = ?
                ORDER BY s.scheduled_at DESC LIMIT ?`,
            )
            .all(merchantId, status, limit)
        : this.db
            .prepare(
              `SELECT s.*, t.description, t.method, t.source
                 FROM settlements s JOIN transactions t ON t.id = s.transaction_id
                WHERE t.merchant_id = ?
                ORDER BY s.scheduled_at DESC LIMIT ?`,
            )
            .all(merchantId, limit)
    ) as Array<{
      id: string;
      transaction_id: string;
      gross_cents: number;
      acquirer_fee_cents: number;
      advance_fee_cents: number;
      net_cents: number;
      scheduled_at: string;
      status: string;
      mode: string;
      paid_at: string | null;
      created_at: string;
      description: string | null;
      method: string;
      source: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      description: row.description,
      method: row.method,
      source: row.source,
      grossCents: row.gross_cents,
      grossFormatted: formatBRL(row.gross_cents),
      feeCents: row.acquirer_fee_cents,
      feeFormatted: formatBRL(row.acquirer_fee_cents),
      advanceFeeCents: row.advance_fee_cents,
      netCents: row.net_cents,
      netFormatted: formatBRL(row.net_cents),
      scheduledAt: row.scheduled_at,
      status: row.status,
      mode: row.mode,
      paidAt: row.paid_at,
      createdAt: row.created_at,
    }));
  }

  // ── Visão de cobranças para o app ─────────────────────────────────────────
  overview(merchantId: string) {
    this.refreshOverdue();
    const boletos = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0) AS openCount,
           COALESCE(SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END), 0) AS overdueCount,
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) AS paidCount,
           COALESCE(SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN amount_cents ELSE 0 END), 0) AS openCents,
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_cents ELSE 0 END), 0) AS paidCents
         FROM boletos WHERE merchant_id = ?`,
      )
      .get(merchantId) as {
      total: number;
      openCount: number;
      overdueCount: number;
      paidCount: number;
      openCents: number;
      paidCents: number;
    };
    const links = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS activeCount,
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) AS paidCount,
           COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount_cents ELSE 0 END), 0) AS activeCents
         FROM payment_links WHERE merchant_id = ?`,
      )
      .get(merchantId) as { activeCount: number; paidCount: number; activeCents: number };
    const subscriptions = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS activeCount,
           COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN CASE period
             WHEN 'WEEKLY' THEN amount_cents * 52.0 / 12
             WHEN 'MONTHLY' THEN amount_cents
             WHEN 'QUARTERLY' THEN amount_cents / 3.0
             WHEN 'YEARLY' THEN amount_cents / 12.0
             ELSE 0 END ELSE 0 END), 0) AS mrrCents
         FROM subscriptions WHERE merchant_id = ?`,
      )
      .get(merchantId) as { activeCount: number; mrrCents: number };
    const invoices = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0) AS openCount,
           COALESCE(SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END), 0) AS overdueCount,
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) AS paidCount,
           COALESCE(SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN amount_cents ELSE 0 END), 0) AS openCents
         FROM subscription_invoices WHERE merchant_id = ?`,
      )
      .get(merchantId) as { openCount: number; overdueCount: number; paidCount: number; openCents: number };
    const customers = this.db
      .prepare("SELECT COUNT(*) AS total FROM customers WHERE merchant_id = ? AND status = 'ACTIVE'")
      .get(merchantId) as { total: number };

    return {
      customers: { total: customers.total },
      boletos: {
        total: boletos.total,
        open: boletos.openCount,
        overdue: boletos.overdueCount,
        paid: boletos.paidCount,
        openCents: boletos.openCents,
        openFormatted: formatBRL(boletos.openCents),
        paidCents: boletos.paidCents,
        paidFormatted: formatBRL(boletos.paidCents),
      },
      links: {
        active: links.activeCount,
        paid: links.paidCount,
        activeCents: links.activeCents,
        activeFormatted: formatBRL(links.activeCents),
      },
      subscriptions: {
        active: subscriptions.activeCount,
        mrrCents: Math.round(subscriptions.mrrCents),
        mrrFormatted: formatBRL(Math.round(subscriptions.mrrCents)),
      },
      invoices: {
        open: invoices.openCount,
        overdue: invoices.overdueCount,
        paid: invoices.paidCount,
        openCents: invoices.openCents,
        openFormatted: formatBRL(invoices.openCents),
      },
    };
  }
}

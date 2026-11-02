import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { alreadyProcessed, enqueueEvent, markProcessed } from '../kernel/bus.ts';
import type { Envelope, EventBus } from '../kernel/bus.ts';
import { log } from '../kernel/logger.ts';
import { metrics } from '../kernel/metrics.ts';
import { newId } from '../kernel/ids.ts';
import type { FiscalItem } from '../domain/fiscal.ts';
import { buildNfce, transmitToSefaz } from '../domain/fiscal.ts';
import type { PaymentMethod } from '../domain/risk.ts';

interface ApprovedPayload {
  transactionId: string;
  merchantId: string;
  terminalId: string;
  amountCents: number;
  method: PaymentMethod;
  installments: number;
  nsu: string;
  authorizationCode?: string;
  description: string;
  items?: FiscalItem[];
  createdAt: string;
}

interface TransactionRow {
  id: string;
  merchant_id: string;
  terminal_id: string;
  amount_cents: number;
  method: PaymentMethod;
  installments: number;
  status: string;
  nsu: string | null;
  authorization_code: string | null;
  description: string;
  items: string | null;
}

interface MerchantRow {
  id: string;
  name: string;
  trade_name: string;
  document: string;
  ie: string | null;
  city: string;
  uf: string;
  crt: string;
}

export interface FiscalDocumentRow {
  id: string;
  transaction_id: string;
  merchant_id: string;
  status: string;
  serie: number;
  number: number;
  access_key: string;
  protocol: string | null;
  qr_code_url: string | null;
  rejection_reason: string | null;
  contingency: number;
  xml: string;
  danfe_text: string;
  escpos: string;
  attempts: number;
  issued_at: string | null;
  created_at: string;
}

export interface FiscalIssued {
  fiscalId: string;
  status: string;
  serie: number;
  number: number;
  accessKey: string;
  qrCodeUrl: string | null;
  contingency: boolean;
  issuedAt: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref();
  });
}

/**
 * Worker fiscal orientado a eventos. Consome TransacaoAprovada, assina e transmite
 * a NFC-e; se a SEFAZ não autorizar, emite em contingência e segue a fila do lojista.
 */
export class FiscalWorker {
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  start(bus: EventBus): void {
    bus.subscribe('transactions.approved', 'fiscal', (envelope) => this.handle(envelope));
  }

  async handle(envelope: Envelope): Promise<void> {
    const group = 'fiscal';
    if (alreadyProcessed(this.db, group, envelope.id)) return;
    const payload = envelope.payload as unknown as ApprovedPayload;
    if (!payload?.transactionId) return;
    try {
      await this.emitForTransaction(payload.transactionId);
      markProcessed(this.db, group, envelope.id);
    } catch (error) {
      metrics.inc('fiscal_failures_total');
      log.error('fiscal.worker_failed', {
        transactionId: payload.transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emite a NFC-e de uma transação aprovada de forma síncrona e idempotente.
   * Usado pelo PDV (que precisa da nota na mesma resposta) e pelo worker de
   * eventos. Retorna null quando a transação não está apta à emissão.
   */
  async emitForTransaction(transactionId: string): Promise<FiscalIssued | null> {
    const existing = this.db
      .prepare('SELECT * FROM fiscal_documents WHERE transaction_id = ?')
      .get(transactionId) as FiscalDocumentRow | undefined;
    if (existing) {
      return {
        fiscalId: existing.id,
        status: existing.status,
        serie: existing.serie,
        number: existing.number,
        accessKey: existing.access_key,
        qrCodeUrl: existing.qr_code_url,
        contingency: Boolean(existing.contingency),
        issuedAt: existing.issued_at,
      };
    }

    const txn = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId) as
      | TransactionRow
      | undefined;
    if (!txn || txn.status !== 'APPROVED') return null;
    const merchant = this.db.prepare('SELECT * FROM merchants WHERE id = ?').get(txn.merchant_id) as
      | MerchantRow
      | undefined;
    if (!merchant) {
      throw new Error(`Estabelecimento ${txn.merchant_id} não encontrado para emissão fiscal.`);
    }

    await sleep(this.config.fiscal.latencyMs);
    const serie = this.config.fiscal.serie;
    const number = this.allocateNumber(merchant.id, serie);
    const emittedAt = new Date();
    const items: FiscalItem[] =
      txn.items && txn.items.length
        ? (JSON.parse(txn.items) as FiscalItem[])
        : [
            {
              code: txn.id,
              name: txn.description,
              ncm: '00000000',
              cfop: '5102',
              quantity: 1,
              unit: 'UN',
              unitPriceCents: txn.amount_cents,
              totalCents: txn.amount_cents,
            },
          ];

    const baseInput = {
      merchant: {
        cnpj: merchant.document,
        legalName: merchant.name,
        tradeName: merchant.trade_name,
        ie: merchant.ie ?? 'ISENTO',
        city: merchant.city,
        uf: merchant.uf,
        cMun: this.config.fiscal.cMun,
        crt: (merchant.crt as '1' | '2' | '3') ?? '1',
      },
      transactionId: txn.id,
      nsu: txn.nsu ?? '',
      authorizationCode: txn.authorization_code ?? undefined,
      method: txn.method,
      amountCents: txn.amount_cents,
      installments: txn.installments,
      items,
      serie,
      number,
      emittedAt,
      ambiente: this.config.fiscal.ambiente,
      keySeed: `${txn.id}:${merchant.id}`,
    } as const;

    const online = buildNfce({ ...baseInput, contingency: false }, this.config);
    let authorized = false;
    let protocol: string | undefined;
    let reason: string | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attempts = attempt;
      const response = transmitToSefaz(online.accessKey, attempt, this.config.fiscal.rejectionPct);
      if (response.authorized) {
        authorized = true;
        protocol = response.protocol;
        break;
      }
      reason = response.reason;
    }

    const document = authorized
      ? online
      : buildNfce({ ...baseInput, contingency: true }, this.config);
    const status = authorized ? 'AUTHORIZED' : 'CONTINGENCY';
    const issuedAt = nowIso();
    const documentId = newId('fis');

    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO fiscal_documents
             (id, transaction_id, merchant_id, status, serie, number, access_key, protocol, qr_code_url,
              rejection_reason, contingency, xml, danfe_text, escpos, attempts, issued_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          documentId,
          txn.id,
          merchant.id,
          status,
          serie,
          number,
          document.accessKey,
          protocol ?? null,
          document.qrCodeUrl,
          authorized ? null : (reason ?? 'SEFAZ indisponível'),
          authorized ? 0 : 1,
          document.xml,
          document.danfeText,
          document.escpos,
          attempts,
          issuedAt,
          issuedAt,
        );

      this.db
        .prepare("UPDATE transactions SET fiscal_status = ?, updated_at = ? WHERE id = ?")
        .run(status, issuedAt, txn.id);

      enqueueEvent(this.db, {
        topic: 'fiscal.issued',
        type: 'NotaFiscalEmitida',
        key: merchant.id,
        payload: {
          transactionId: txn.id,
          merchantId: merchant.id,
          terminalId: txn.terminal_id,
          status,
          contingency: !authorized,
          protocol: protocol ?? null,
          qrCodeUrl: document.qrCodeUrl,
          accessKey: document.accessKey,
          number,
          serie,
          issuedAt,
        },
      });

      audit(this.db, 'fiscal-worker', 'FISCAL_ISSUED', txn.id, {
        status,
        number,
        accessKey: document.accessKey,
      });
    });

    metrics.inc('fiscal_documents_total', { status });
    log.info('fiscal.issued', {
      transactionId: txn.id,
      status,
      number,
      attempts,
      contingency: !authorized,
    });

    return {
      fiscalId: documentId,
      status,
      serie,
      number,
      accessKey: document.accessKey,
      qrCodeUrl: document.qrCodeUrl,
      contingency: !authorized,
      issuedAt,
    };
  }

  allocateNumber(merchantId: string, serie: number): number {
    const row = this.db
      .prepare(
        `INSERT INTO fiscal_counters (merchant_id, serie, last_number) VALUES (?, ?, 1)
         ON CONFLICT(merchant_id, serie) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number`,
      )
      .get(merchantId, serie) as { last_number: number };
    return row.last_number;
  }

  getDocument(transactionId: string) {
    const row = this.db
      .prepare('SELECT * FROM fiscal_documents WHERE transaction_id = ?')
      .get(transactionId) as FiscalDocumentRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      transactionId: row.transaction_id,
      status: row.status,
      serie: row.serie,
      number: row.number,
      accessKey: row.access_key,
      protocol: row.protocol,
      qrCodeUrl: row.qr_code_url,
      rejectionReason: row.rejection_reason,
      contingency: Boolean(row.contingency),
      attempts: row.attempts,
      issuedAt: row.issued_at,
      xml: row.xml,
      danfeText: row.danfe_text,
      escpos: row.escpos,
    };
  }

  listRecent(merchantId: string, limit = 20) {
    const rows = this.db
      .prepare(
        `SELECT f.*, t.amount_cents, t.method, t.description
           FROM fiscal_documents f JOIN transactions t ON t.id = f.transaction_id
          WHERE f.merchant_id = ? ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(merchantId, Math.min(100, Math.max(1, limit))) as unknown as Array<
      FiscalDocumentRow & { amount_cents: number; method: PaymentMethod; description: string }
    >;
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      status: row.status,
      serie: row.serie,
      number: row.number,
      accessKey: row.access_key,
      qrCodeUrl: row.qr_code_url,
      contingency: Boolean(row.contingency),
      amountCents: row.amount_cents,
      method: row.method,
      description: row.description,
      issuedAt: row.issued_at,
    }));
  }
}

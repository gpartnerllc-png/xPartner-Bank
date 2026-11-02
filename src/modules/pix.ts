import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { alphanumeric, newId, numeric } from '../kernel/ids.ts';
import { assertPositiveCents, formatBRL } from '../kernel/money.ts';
import { buildPixPayload } from '../domain/pix.ts';
import { routeTransaction } from '../domain/routing.ts';
import { settleReceivable } from './receivable-settlement.ts';
import { publicTransaction } from './transactions.ts';
import type { TransactionService } from './transactions.ts';

interface ChargeRow {
  id: string;
  transaction_id: string;
  merchant_id: string;
  txid: string;
  amount_cents: number;
  status: string;
  emv_payload: string;
  end_to_end_id: string | null;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
}

interface MerchantRow {
  id: string;
  name: string;
  trade_name: string;
  document: string;
  city: string;
  uf: string;
  pix_key: string | null;
  status: string;
}

function publicCharge(row: ChargeRow) {
  return {
    id: row.id,
    txid: row.txid,
    transactionId: row.transaction_id,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    status: row.status,
    emvPayload: row.emv_payload,
    endToEndId: row.end_to_end_id,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export class PixService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly transactions: TransactionService;

  constructor(db: Db, config: AppConfig, transactions: TransactionService) {
    this.db = db;
    this.config = config;
    this.transactions = transactions;
  }

  createCharge(input: {
    merchantId: string;
    terminalId: string;
    amountCents: number;
    description?: string;
    expiresInSeconds?: number;
    now?: number;
  }): { charge: ReturnType<typeof publicCharge>; transaction: ReturnType<typeof publicTransaction> } {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    const amountCents = assertPositiveCents(input.amountCents);
    // A expiração é política interna (links e assinaturas), não uma limitação do BR Code.
    const expiresIn = Math.min(604_800, Math.max(60, Math.trunc(input.expiresInSeconds ?? 900)));

    const merchant = this.db.prepare('SELECT * FROM merchants WHERE id = ?').get(input.merchantId) as
      | MerchantRow
      | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);
    if (!merchant.pix_key) throw new AppError('PIX_KEY_MISSING', 'Estabelecimento sem chave Pix configurada.', 409);
    const terminal = this.db
      .prepare('SELECT id, merchant_id, status FROM terminals WHERE id = ?')
      .get(input.terminalId) as { id: string; merchant_id: string; status: string } | undefined;
    if (!terminal) throw Errors.notFound('Terminal não encontrado.');
    if (terminal.merchant_id !== merchant.id) throw Errors.forbidden('Terminal não pertence ao estabelecimento.');

    const description = (input.description?.trim() || 'Venda Pix').slice(0, 120);
    const transactionId = newId('txn', now);
    const txid = alphanumeric(20);
    const expiresAt = new Date(now + expiresIn * 1000).toISOString();

    const emvPayload = buildPixPayload({
      pixKey: merchant.pix_key,
      merchantName: merchant.trade_name,
      merchantCity: merchant.city,
      amountCents,
      txid,
      description,
    });

    const routing = routeTransaction(this.db, { method: 'PIX', installments: 1, amountCents });
    const feeCents = routing.selected.feeCents;
    const netCents = amountCents - feeCents;

    const charge = tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO transactions (
             id, merchant_id, terminal_id, amount_cents, currency, method, installments, status,
             acquirer_id, brand, risk_score, risk_decision, fee_cents, net_cents, description,
             fiscal_status, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'BRL', 'PIX', 1, 'PENDING', ?, 'Pix', 0, 'APPROVE', ?, ?, ?, NULL, 'PIX', ?, ?)`,
        )
        .run(
          transactionId,
          merchant.id,
          terminal.id,
          amountCents,
          routing.selected.acquirerId,
          feeCents,
          netCents,
          description,
          createdAt,
          createdAt,
        );

      const chargeId = newId('pix');
      this.db
        .prepare(
          `INSERT INTO pix_charges
             (id, transaction_id, merchant_id, txid, amount_cents, status, emv_payload, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .run(chargeId, transactionId, merchant.id, txid, amountCents, emvPayload, expiresAt, createdAt);

      audit(this.db, terminal.id, 'PIX_CHARGE_CREATED', transactionId, { txid, amountCents });
      return this.db.prepare('SELECT * FROM pix_charges WHERE id = ?').get(chargeId) as unknown as ChargeRow;
    });

    return {
      charge: publicCharge(charge),
      transaction: this.transactions.getTransaction(transactionId),
    };
  }

  payCharge(
    txid: string,
    options: { endToEndId?: string; paidAt?: number } = {},
  ): { charge: ReturnType<typeof publicCharge>; transaction: ReturnType<typeof publicTransaction> } {
    const charge = this.db.prepare('SELECT * FROM pix_charges WHERE txid = ?').get(txid) as ChargeRow | undefined;
    if (!charge) throw Errors.notFound('Cobrança Pix não encontrada.');
    if (charge.status === 'PAID') {
      return {
        charge: publicCharge(charge),
        transaction: this.transactions.getTransaction(charge.transaction_id),
      };
    }
    const now = options.paidAt ?? Date.now();
    if (charge.status !== 'ACTIVE') throw new AppError('PIX_CHARGE_CLOSED', `Cobrança ${charge.status}.`, 409);
    if (new Date(charge.expires_at).getTime() < now) {
      this.db.prepare("UPDATE pix_charges SET status = 'EXPIRED' WHERE id = ?").run(charge.id);
      this.db.prepare("UPDATE transactions SET status = 'CANCELED', updated_at = ? WHERE id = ?").run(
        nowIso(now),
        charge.transaction_id,
      );
      throw new AppError('PIX_EXPIRED', 'Cobrança Pix expirada.', 409);
    }

    const paidAt = nowIso(now);
    const endToEndId = options.endToEndId ?? `E${numeric(8)}${now}${numeric(6)}`;
    const transactionRow = this.db
      .prepare('SELECT id, method FROM transactions WHERE id = ?')
      .get(charge.transaction_id) as { id: string; method: string } | undefined;
    if (!transactionRow) throw Errors.notFound('Transação da cobrança não encontrada.');
    if (transactionRow.method !== 'PIX') throw new AppError('PIX_METHOD_MISMATCH', 'Transação não é Pix.', 500);

    tx(this.db, () => {
      this.db
        .prepare("UPDATE pix_charges SET status = 'PAID', end_to_end_id = ?, paid_at = ? WHERE id = ?")
        .run(endToEndId, paidAt, charge.id);
      settleReceivable(this.db, charge.transaction_id, { paidAt, nsu: endToEndId, channel: 'PIX' });
    });

    const updated = this.db.prepare('SELECT * FROM pix_charges WHERE id = ?').get(charge.id) as unknown as ChargeRow;
    return {
      charge: publicCharge(updated),
      transaction: this.transactions.getTransaction(charge.transaction_id),
    };
  }

  getCharge(txid: string) {
    const row = this.db.prepare('SELECT * FROM pix_charges WHERE txid = ?').get(txid) as ChargeRow | undefined;
    if (!row) throw Errors.notFound('Cobrança Pix não encontrada.');
    return {
      charge: publicCharge(row),
      transaction: this.transactions.getTransaction(row.transaction_id),
    };
  }

  listCharges(merchantId: string, limit = 10) {
    const rows = this.db
      .prepare('SELECT * FROM pix_charges WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(merchantId, Math.min(50, Math.max(1, limit))) as unknown as ChargeRow[];
    return rows.map(publicCharge);
  }
}

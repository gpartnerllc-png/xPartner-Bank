import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { formatBRL, type Cents } from '../kernel/money.ts';
import { devTokenFor } from '../domain/vault.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from './seed.ts';
import { accountView, TREASURY_ACCOUNT_ID, TREASURY_USER_ID, type BankAccountRow, type BankAccountView, type BankService, type TransferView } from './bank.ts';
import type { FiscalWorker } from './fiscal-worker.ts';
import type { SaleItemInput, TransactionService } from './transactions.ts';

export const PDV_MAX_CENTS = 10_000_000; // R$ 100.000,00 por venda no PDV
export const PDV_MIN_CENTS = 100; // R$ 1,00

export const PDV_DISCLAIMER =
  'PDV de demonstração: a venda é autorizada pelo adquirente simulado do xPartner e o valor líquido é ' +
  'creditado na conta do titular pela tesouraria. Em produção a liquidação segue o arranjo de pagamento (D+1), ' +
  'não a tesouraria.';

export interface PdvSaleRow {
  id: string;
  user_id: string;
  transaction_id: string;
  merchant_id: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  method: string;
  description: string;
  fiscal_status: string | null;
  access_key: string | null;
  fiscal_id: string | null;
  settlement_transfer_id: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface PdvFiscalView {
  status: string;
  accessKey: string;
  qrCodeUrl: string | null;
  serie: number;
  number: number;
  contingency: boolean;
  fiscalId: string;
  issuedAt: string | null;
}

export interface PdvSaleView {
  id: string;
  transactionId: string;
  nsu: string | null;
  authorizationCode: string | null;
  method: string;
  installments: number;
  amountCents: Cents;
  amountFormatted: string;
  feeCents: Cents;
  feeFormatted: string;
  netCents: Cents;
  netFormatted: string;
  description: string;
  merchantId: string;
  terminalId: string;
  fiscal: PdvFiscalView | null;
  settlement: {
    transferId: string | null;
    settledAt: string | null;
    netCents: Cents;
    netFormatted: string;
  };
  createdAt: string;
  demo: true;
  disclaimer: string;
}

const PDV_METHODS = new Set(['CREDIT', 'DEBIT', 'PIX', 'VOUCHER']);

export class BankPdvService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly bank: BankService;
  private readonly transactions: TransactionService;
  private readonly fiscal: FiscalWorker;

  constructor(
    db: Db,
    config: AppConfig,
    bank: BankService,
    transactions: TransactionService,
    fiscal: FiscalWorker,
  ) {
    this.db = db;
    this.config = config;
    this.bank = bank;
    this.transactions = transactions;
    this.fiscal = fiscal;
  }

  private accountFor(userId: string): BankAccountRow {
    const account = this.db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId) as
      | BankAccountRow
      | undefined;
    if (!account) throw Errors.notFound('Conta bancária não encontrada.');
    if (account.status !== 'ACTIVE') {
      throw new AppError('ACCOUNT_BLOCKED', 'Conta bloqueada ou encerrada para receber vendas.', 403);
    }
    return account;
  }

  /** Venda presencial com NFC-e síncrona e liquidação do líquido na conta do titular. */
  async sell(input: {
    userId: string;
    amountCents: number;
    method: string;
    installments?: number;
    description?: string;
    items?: SaleItemInput[];
    now?: number;
  }): Promise<{ sale: PdvSaleView; fiscal: PdvFiscalView | null; account: BankAccountView; transfer: TransferView | null }> {
    if (!this.config.demoMode) {
      throw new AppError('DEMO_ONLY', 'PDV de demonstração disponível apenas em ambiente demo.', 403);
    }
    const now = input.now ?? Date.now();
    const method = String(input.method ?? '').trim().toUpperCase();
    if (!PDV_METHODS.has(method)) {
      throw new AppError('INVALID_METHOD', 'Meio de pagamento inválido para o PDV.', 422);
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < PDV_MIN_CENTS) {
      throw Errors.validation(`Valor mínimo da venda é ${formatBRL(PDV_MIN_CENTS)}.`);
    }
    if (input.amountCents > PDV_MAX_CENTS) {
      throw Errors.validation(`Valor máximo da venda no PDV é ${formatBRL(PDV_MAX_CENTS)}.`);
    }
    if (input.items?.length) {
      const total = input.items.reduce(
        (sum, item) => sum + Math.round((item.unitPriceCents ?? 0) * Math.max(0.0001, item.quantity ?? 1)),
        0,
      );
      if (total !== input.amountCents) {
        throw Errors.validation(
          `Soma dos itens (${formatBRL(total)}) difere do total da venda (${formatBRL(input.amountCents)}).`,
        );
      }
    }

    const account = this.accountFor(input.userId);
    const description = (input.description?.trim() || `Venda PDV ${method}`).slice(0, 120);
    const paymentToken =
      method === 'PIX'
        ? undefined
        : devTokenFor('visa', '4242', `pdv:${input.userId}:${input.amountCents}:${now}`);

    const result = this.transactions.createSale({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      amountCents: input.amountCents,
      method,
      installments: input.installments,
      paymentToken,
      description,
      items: input.items,
      source: 'DEMO',
      now,
    });

    if (result.status !== 'APPROVED' || !result.payment) {
      throw new AppError(
        'SALE_DECLINED',
        `Venda não autorizada${result.transaction.failureReason ? `: ${result.transaction.failureReason}` : '.'}`,
        422,
      );
    }

    const fiscal = await this.fiscal.emitForTransaction(result.transaction.id);
    const payment = result.payment;
    const netCents = payment.netCents;
    const timestamp = nowIso(now);

    const settled = tx(this.db, () => {
      let transfer: TransferView | null = null;
      if (netCents > 0) {
        const posted = this.bank.postTransfer({
          userId: TREASURY_USER_ID,
          accountId: TREASURY_ACCOUNT_ID,
          amountCents: netCents,
          description: `Liquidação venda ${result.transaction.nsu ?? result.transaction.id.slice(-8)}`,
          recipient: { accountNumber: account.number },
          channel: 'PDV',
          now,
        });
        transfer = posted.transfer;
      }
      const saleId = newId('pdv', now);
      this.db
        .prepare(
          `INSERT INTO bank_pdv_sales
             (id, user_id, transaction_id, merchant_id, amount_cents, fee_cents, net_cents, method,
              description, fiscal_status, access_key, fiscal_id, settlement_transfer_id, settled_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          saleId,
          input.userId,
          result.transaction.id,
          DEMO_MERCHANT_ID,
          input.amountCents,
          payment.feeCents,
          netCents,
          method,
          description,
          fiscal?.status ?? null,
          fiscal?.accessKey ?? null,
          fiscal?.fiscalId ?? null,
          transfer?.id ?? null,
          timestamp,
          timestamp,
        );

      enqueueEvent(this.db, {
        topic: 'bank.pdv',
        type: 'bank.pdv.sale_settled',
        key: input.userId,
        payload: {
          saleId,
          transactionId: result.transaction.id,
          amountCents: input.amountCents,
          feeCents: payment.feeCents,
          netCents,
          method,
          accessKey: fiscal?.accessKey ?? null,
          fiscalStatus: fiscal?.status ?? null,
          transferId: transfer?.id ?? null,
          settledAt: transfer ? timestamp : null,
        },
      });
      audit(this.db, input.userId, 'bank.pdv.sale_settled', `pdv_sale:${saleId}`, {
        transactionId: result.transaction.id,
        amountCents: input.amountCents,
        netCents,
        method,
        fiscalStatus: fiscal?.status ?? null,
      });

      const row = this.db.prepare('SELECT * FROM bank_pdv_sales WHERE id = ?').get(saleId) as unknown as PdvSaleRow;
      return { sale: this.view(row), transfer };
    });

    return {
      sale: settled.sale,
      fiscal: settled.sale.fiscal,
      account: accountView(this.accountFor(input.userId)),
      transfer: settled.transfer,
    };
  }

  list(userId: string, limit = 30): { sales: PdvSaleView[]; summary: { count: number; grossCents: Cents; grossFormatted: string; netCents: Cents; netFormatted: string; fiscalized: number } } {
    const rows = this.db
      .prepare('SELECT * FROM bank_pdv_sales WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, Math.min(100, Math.max(1, limit))) as unknown as PdvSaleRow[];
    const sales = rows.map((row) => this.view(row));
    const gross = rows.reduce((sum, row) => sum + row.amount_cents, 0);
    const net = rows.reduce((sum, row) => sum + row.net_cents, 0);
    return {
      sales,
      summary: {
        count: rows.length,
        grossCents: gross,
        grossFormatted: formatBRL(gross),
        netCents: net,
        netFormatted: formatBRL(net),
        fiscalized: rows.filter((row) => Boolean(row.access_key)).length,
      },
    };
  }

  document(
    userId: string,
    saleId: string,
  ): { sale: PdvSaleView; xml: string; danfeText: string; escpos: string } {
    const row = this.db
      .prepare('SELECT * FROM bank_pdv_sales WHERE id = ? AND user_id = ?')
      .get(saleId, userId) as unknown as PdvSaleRow | undefined;
    if (!row) throw Errors.notFound('Venda do PDV não encontrada.');
    if (!row.fiscal_id) throw Errors.conflict('Venda ainda sem documento fiscal emitido.');
    const doc = this.fiscal.getDocument(row.transaction_id);
    if (!doc) throw Errors.notFound('Documento fiscal não encontrado.');
    return { sale: this.view(row), xml: doc.xml, danfeText: doc.danfeText, escpos: doc.escpos };
  }

  salesCsv(userId: string): string {
    const { sales } = this.list(userId, 100);
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const money = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');
    const lines = [
      ['data', 'nsu', 'meio', 'parcelas', 'bruto', 'taxa', 'liquido', 'fiscal', 'chave_acesso', 'descricao']
        .map(escape)
        .join(';'),
      ...sales.map((sale) =>
        [
          sale.createdAt,
          sale.nsu ?? '',
          sale.method,
          String(sale.installments),
          money(sale.amountCents),
          money(sale.feeCents),
          money(sale.netCents),
          sale.fiscal?.status ?? 'SEM_NOTA',
          sale.fiscal?.accessKey ?? '',
          sale.description,
        ]
          .map(escape)
          .join(';'),
      ),
    ];
    return `\ufeff${lines.join('\r\n')}`;
  }

  private view(row: PdvSaleRow): PdvSaleView {
    const txn = this.db
      .prepare('SELECT nsu, authorization_code, installments, terminal_id FROM transactions WHERE id = ?')
      .get(row.transaction_id) as
      | { nsu: string | null; authorization_code: string | null; installments: number; terminal_id: string }
      | undefined;
    const doc = this.fiscal.getDocument(row.transaction_id);
    const fiscal: PdvFiscalView | null = doc
      ? {
          status: doc.status,
          accessKey: doc.accessKey,
          qrCodeUrl: doc.qrCodeUrl,
          serie: doc.serie,
          number: doc.number,
          contingency: doc.contingency,
          fiscalId: doc.id,
          issuedAt: doc.issuedAt,
        }
      : null;
    return {
      id: row.id,
      transactionId: row.transaction_id,
      nsu: txn?.nsu ?? null,
      authorizationCode: txn?.authorization_code ?? null,
      method: row.method,
      installments: txn?.installments ?? 1,
      amountCents: row.amount_cents,
      amountFormatted: formatBRL(row.amount_cents),
      feeCents: row.fee_cents,
      feeFormatted: formatBRL(row.fee_cents),
      netCents: row.net_cents,
      netFormatted: formatBRL(row.net_cents),
      description: row.description,
      merchantId: row.merchant_id,
      terminalId: txn?.terminal_id ?? DEMO_TERMINAL_ID,
      fiscal,
      settlement: {
        transferId: row.settlement_transfer_id,
        settledAt: row.settled_at,
        netCents: row.net_cents,
        netFormatted: formatBRL(row.net_cents),
      },
      createdAt: row.created_at,
      demo: true,
      disclaimer: PDV_DISCLAIMER,
    };
  }
}

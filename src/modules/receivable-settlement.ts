import type { Db } from '../kernel/db.ts';
import { audit } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import type { FiscalItem } from '../domain/fiscal.ts';
import { postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';

type ReceivableChannel = 'PIX' | 'BOLETO' | 'LINK' | 'SUBSCRIPTION' | 'OPEN_FINANCE';

interface BillableRow {
  id: string;
  merchant_id: string;
  terminal_id: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  description: string | null;
  method: string;
  installments: number;
  items: string | null;
  status: string;
}

export interface SettlementInput {
  paidAt: string;
  nsu: string;
  channel: ReceivableChannel;
  /** Data em que o líquido entra na liquidação (D+0 para Pix, D+1 para boleto/assinatura). */
  settlementAt?: string;
}

/**
 * Baixa uma cobrança PENDING: aprova a transação, lança a dupla entrada,
 * agenda a liquidação e publica o evento que dispara a NFC-e.
 * Deve ser chamado dentro de uma transação SQL do chamador e é idempotente.
 */
export function settleReceivable(db: Db, transactionId: string, input: SettlementInput): BillableRow {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId) as BillableRow | undefined;
  if (!row) throw Errors.notFound('Transação da cobrança não encontrada.');
  if (row.status === 'APPROVED') return row;
  if (row.status !== 'PENDING') {
    throw new AppError('RECEIVABLE_CLOSED', `Cobrança ${row.status.toLowerCase()}.`, 409);
  }

  const settlementAt = input.settlementAt ?? input.paidAt;
  const result = db
    .prepare(
      `UPDATE transactions
          SET status = 'APPROVED', nsu = ?, settlement_at = ?, paid_at = ?,
              fiscal_status = 'PENDING', updated_at = ?
        WHERE id = ? AND status = 'PENDING'`,
    )
    .run(input.nsu, settlementAt, input.paidAt, input.paidAt, transactionId);
  if (result.changes === 0) {
    const current = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId) as unknown as BillableRow;
    if (current.status === 'APPROVED') return current;
    throw new AppError('RECEIVABLE_CLOSED', 'Cobrança não está mais pendente.', 409);
  }

  const entries: EntryInput[] = [
    {
      kind: 'ACQUIRER_RECEIVABLE',
      direction: 'DEBIT',
      amountCents: row.amount_cents,
      memo: `Recebimento ${input.channel} ${input.nsu}`,
    },
    {
      kind: 'MERCHANT_PAYABLE',
      ownerType: 'MERCHANT',
      ownerId: row.merchant_id,
      direction: 'CREDIT',
      amountCents: row.net_cents,
      memo: `A receber ${transactionId}`,
    },
  ];
  if (row.fee_cents > 0) {
    entries.push({
      kind: 'FEE_REVENUE',
      direction: 'CREDIT',
      amountCents: row.fee_cents,
      memo: `Tarifa ${input.channel.toLowerCase()}`,
    });
  }
  postGroup(db, {
    groupId: transactionId,
    groupKind: 'SALE',
    transactionId,
    createdAt: input.paidAt,
    entries,
  });

  db.prepare(
    `INSERT INTO settlements
       (id, transaction_id, merchant_id, gross_cents, acquirer_fee_cents, net_cents, scheduled_at, status, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'STANDARD', ?)`,
  ).run(
    newId('stl'),
    transactionId,
    row.merchant_id,
    row.amount_cents,
    row.fee_cents,
    row.net_cents,
    settlementAt,
    input.paidAt,
  );

  const description = row.description ?? 'Cobrança';
  const items: FiscalItem[] = row.items
    ? (JSON.parse(row.items) as FiscalItem[])
    : [
        {
          code: transactionId,
          name: description,
          ncm: '00000000',
          cfop: '5102',
          quantity: 1,
          unit: 'UN',
          unitPriceCents: row.amount_cents,
          totalCents: row.amount_cents,
        },
      ];

  enqueueEvent(db, {
    topic: 'transactions.approved',
    type: 'TransacaoAprovada',
    key: row.merchant_id,
    payload: {
      transactionId,
      merchantId: row.merchant_id,
      terminalId: row.terminal_id,
      amountCents: row.amount_cents,
      method: row.method,
      installments: row.installments,
      nsu: input.nsu,
      authorizationCode: input.nsu.slice(-6),
      description,
      channel: input.channel,
      items,
      createdAt: input.paidAt,
    },
  });

  audit(db, row.terminal_id, `RECEIVABLE_PAID_${input.channel}`, transactionId, {
    nsu: input.nsu,
    amountCents: row.amount_cents,
    netCents: row.net_cents,
    settlementAt,
  });

  return { ...row, status: 'APPROVED' };
}

import type { AppConfig } from '../config.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import type { Db } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId, numeric } from '../kernel/ids.ts';
import { formatBRL, MAX_TRANSACTION_CENTS } from '../kernel/money.ts';
import type { Cents } from '../kernel/money.ts';
import { assertPositiveCents } from '../kernel/money.ts';
import { authorize } from '../domain/authorization.ts';
import type { FiscalItem } from '../domain/fiscal.ts';
import { postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';
import type { PaymentMethod } from '../domain/risk.ts';
import { assessRisk, recordRiskLinks } from '../domain/risk.ts';
import type { RiskResult } from '../domain/risk.ts';
import type { RouteQuote } from '../domain/routing.ts';
import { routeTransaction } from '../domain/routing.ts';
import { settlementPlan } from '../domain/settlement.ts';
import { resolvePaymentToken } from '../domain/vault.ts';

const METHODS: PaymentMethod[] = ['CREDIT', 'DEBIT', 'PIX', 'VOUCHER'];

export interface SaleItemInput {
  name?: string;
  ncm?: string;
  quantity?: number;
  unitPriceCents?: number;
}

export interface SaleInput {
  merchantId: string;
  terminalId: string;
  amountCents: number;
  method: string;
  installments?: number;
  paymentToken?: string;
  description?: string;
  items?: SaleItemInput[];
  source?: 'CARD' | 'PIX' | 'DEMO';
  now?: number;
}

export interface SaleResult {
  status: string;
  transaction: ReturnType<typeof publicTransaction>;
  payment: {
    nsu: string;
    authorizationCode: string;
    acquirerId: string;
    acquirerName: string;
    grossCents: Cents;
    feeCents: Cents;
    netCents: Cents;
    feeFormatted: string;
    netFormatted: string;
    settlementAt: string | null;
    installments: number;
    responseCode?: string;
    message?: string;
  } | null;
  risk: RiskResult;
  routing: { selected: RouteQuote; alternatives: RouteQuote[] } | null;
  fiscal: { status: string | null; note: string };
}

interface TransactionRow {
  id: string;
  merchant_id: string;
  terminal_id: string;
  amount_cents: number;
  currency: string;
  method: PaymentMethod;
  installments: number;
  status: string;
  nsu: string | null;
  authorization_code: string | null;
  acquirer_id: string | null;
  brand: string | null;
  last4: string | null;
  card_fingerprint: string | null;
  risk_score: number;
  risk_decision: string | null;
  risk_reasons: string | null;
  fee_cents: number;
  net_cents: number;
  description: string | null;
  items: string | null;
  settlement_at: string | null;
  paid_at: string | null;
  fiscal_status: string | null;
  failure_reason: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export function publicTransaction(row: TransactionRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    terminalId: row.terminal_id,
    amountCents: row.amount_cents,
    amountFormatted: formatBRL(row.amount_cents),
    method: row.method,
    installments: row.installments,
    status: row.status,
    nsu: row.nsu,
    authorizationCode: row.authorization_code,
    acquirerId: row.acquirer_id,
    brand: row.brand,
    last4: row.last4,
    riskScore: row.risk_score,
    riskDecision: row.risk_decision,
    riskReasons: row.risk_reasons ? (JSON.parse(row.risk_reasons) as unknown[]) : [],
    feeCents: row.fee_cents,
    netCents: row.net_cents,
    description: row.description,
    settlementAt: row.settlement_at,
    paidAt: row.paid_at,
    fiscalStatus: row.fiscal_status,
    failureReason: row.failure_reason,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildFiscalItems(input: SaleInput, transactionId: string, description: string): FiscalItem[] {
  const amount = input.amountCents;
  if (!input.items?.length) {
    return [
      {
        code: transactionId,
        name: description,
        ncm: '00000000',
        cfop: '5102',
        quantity: 1,
        unit: 'UN',
        unitPriceCents: amount,
        totalCents: amount,
      },
    ];
  }
  const items: FiscalItem[] = input.items.map((item, index) => {
    const quantity = Math.max(0.0001, item.quantity ?? 1);
    const unitPrice = item.unitPriceCents ?? Math.round(amount / (input.items?.length ?? 1) / quantity);
    return {
      code: `${transactionId}-${index + 1}`,
      name: item.name?.trim() || description,
      ncm: (item.ncm ?? '00000000').replace(/\D/g, '').padStart(8, '0').slice(0, 8),
      cfop: '5102',
      quantity,
      unit: 'UN',
      unitPriceCents: unitPrice,
      totalCents: Math.round(unitPrice * quantity),
    };
  });
  const total = items.reduce((sum, item) => sum + item.totalCents, 0);
  if (total !== amount) {
    throw new AppError(
      'ITEMS_TOTAL_MISMATCH',
      `Soma dos itens (${formatBRL(total)}) difere do total da venda (${formatBRL(amount)}).`,
      422,
    );
  }
  return items;
}

export class TransactionService {
  private readonly db: Db;
  private readonly config: AppConfig;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  createSale(input: SaleInput): SaleResult {
    const now = input.now ?? Date.now();
    const createdAt = nowIso(now);
    const method = input.method.toUpperCase() as PaymentMethod;
    if (!METHODS.includes(method)) {
      throw new AppError('INVALID_METHOD', 'Meio de pagamento inválido.', 422);
    }
    const amountCents = assertPositiveCents(input.amountCents);
    if (amountCents > MAX_TRANSACTION_CENTS) throw new AppError('AMOUNT_LIMIT', 'Valor acima do limite.', 422);
    const installments = method === 'CREDIT' ? Math.min(12, Math.max(1, Math.trunc(input.installments ?? 1))) : 1;
    if (installments > 1 && amountCents < 1000) {
      throw new AppError('INSTALLMENTS_TOO_LOW', 'Parcelamento exige valor mínimo de R$ 10,00.', 422);
    }

    const merchant = this.db.prepare('SELECT * FROM merchants WHERE id = ?').get(input.merchantId) as
      | { id: string; name: string; trade_name: string; document: string; city: string; uf: string; status: string }
      | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);

    const terminal = this.db
      .prepare('SELECT id, merchant_id, status FROM terminals WHERE id = ?')
      .get(input.terminalId) as { id: string; merchant_id: string; status: string } | undefined;
    if (!terminal) throw Errors.notFound('Terminal não encontrado.');
    if (terminal.merchant_id !== input.merchantId) {
      throw Errors.forbidden('Terminal não pertence ao estabelecimento.');
    }
    if (terminal.status !== 'ACTIVE') throw new AppError('TERMINAL_BLOCKED', 'Terminal bloqueado.', 409);

    const description = (input.description?.trim() || 'Venda no estabelecimento').slice(0, 120);
    const card = method === 'PIX' ? null : resolvePaymentToken(input.paymentToken ?? '', this.config.masterKey);

    const risk = assessRisk(this.db, {
      merchantId: merchant.id,
      terminalId: terminal.id,
      cardFingerprint: card?.fingerprint,
      amountCents,
      method,
      brand: card?.brand,
      installments,
      now,
    });

    const transactionId = newId('txn', now);
    const routing =
      method === 'PIX'
        ? routeTransaction(this.db, { method, installments, amountCents })
        : routeTransaction(this.db, { method, brand: card?.brand, installments, amountCents });

    const auth =
      method === 'PIX'
        ? {
            approved: true,
            responseCode: '00',
            nsu: `${numeric(8)}${String(now).slice(-4)}`,
            authorizationCode: numeric(6),
            message: 'Pix confirmado.',
          }
        : authorize({
            amountCents,
            method,
            installments,
            brand: card?.brand,
            last4: card?.last4,
            acquirerId: routing.selected.acquirerId,
            terminalId: terminal.id,
            merchantId: merchant.id,
            seed: transactionId,
          });

    if (risk.decision === 'DECLINE' || !auth.approved) {
      const reason =
        risk.decision === 'DECLINE'
          ? `Bloqueada pelo motor de risco (score ${risk.score}).`
          : auth.message;
      this.db
        .prepare(
          `INSERT INTO transactions (
             id, merchant_id, terminal_id, amount_cents, currency, method, installments, status,
             nsu, authorization_code, acquirer_id, brand, last4, card_fingerprint,
             risk_score, risk_decision, risk_reasons, fee_cents, net_cents, description, source,
             failure_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'BRL', ?, ?, 'DECLINED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          transactionId,
          merchant.id,
          terminal.id,
          amountCents,
          method,
          installments,
          auth.nsu,
          auth.authorizationCode,
          routing.selected.acquirerId,
          card?.brand ?? null,
          card?.last4 ?? null,
          card?.fingerprint ?? null,
          risk.score,
          risk.decision,
          JSON.stringify(risk.reasons),
          description,
          input.source ?? 'CARD',
          reason,
          createdAt,
          createdAt,
        );
      recordRiskLinks(this.db, {
        cardFingerprint: card?.fingerprint,
        terminalId: terminal.id,
        merchantId: merchant.id,
        flagged: true,
      });
      audit(this.db, terminal.id, 'SALE_DECLINED', transactionId, { risk: risk.score });

      return {
        status: 'DECLINED',
        transaction: publicTransaction(this.getRow(transactionId)),
        payment: null,
        risk,
        routing,
        fiscal: { status: null, note: 'Sem emissão fiscal para transação não aprovada.' },
      };
    }

    const feeCents = routing.selected.feeCents;
    const netCents = amountCents - feeCents;
    const plan = settlementPlan(method, createdAt);
    const items = buildFiscalItems(input, transactionId, description);

    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO transactions (
             id, merchant_id, terminal_id, amount_cents, currency, method, installments, status,
             nsu, authorization_code, acquirer_id, brand, last4, card_fingerprint,
             risk_score, risk_decision, risk_reasons, fee_cents, net_cents, description, items,
             settlement_at, fiscal_status, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'BRL', ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        )
        .run(
          transactionId,
          merchant.id,
          terminal.id,
          amountCents,
          method,
          installments,
          auth.nsu,
          auth.authorizationCode,
          routing.selected.acquirerId,
          card?.brand ?? 'Pix',
          card?.last4 ?? null,
          card?.fingerprint ?? null,
          risk.score,
          risk.decision,
          JSON.stringify(risk.reasons),
          feeCents,
          netCents,
          description,
          JSON.stringify(items),
          plan.scheduledAt,
          input.source ?? 'CARD',
          createdAt,
          createdAt,
        );

      const entries: EntryInput[] = [
        { kind: 'ACQUIRER_RECEIVABLE', direction: 'DEBIT', amountCents, memo: `Venda ${transactionId}` },
        {
          kind: 'MERCHANT_PAYABLE',
          ownerType: 'MERCHANT',
          ownerId: merchant.id,
          direction: 'CREDIT',
          amountCents: netCents,
          memo: `Líquido a receber ${transactionId}`,
        },
      ];
      if (feeCents > 0) {
        entries.push({
          kind: 'FEE_REVENUE',
          direction: 'CREDIT',
          amountCents: feeCents,
          memo: `MDR ${routing.selected.name}`,
        });
      }
      postGroup(this.db, { groupId: transactionId, groupKind: 'SALE', transactionId, createdAt, entries });

      this.db
        .prepare(
          `INSERT INTO settlements
             (id, transaction_id, merchant_id, gross_cents, acquirer_fee_cents, net_cents, scheduled_at, status, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'STANDARD', ?)`,
        )
        .run(newId('stl'), transactionId, merchant.id, amountCents, feeCents, netCents, plan.scheduledAt, createdAt);

      recordRiskLinks(this.db, {
        cardFingerprint: card?.fingerprint,
        terminalId: terminal.id,
        merchantId: merchant.id,
      });

      enqueueEvent(this.db, {
        topic: 'transactions.approved',
        type: 'TransacaoAprovada',
        key: merchant.id,
        payload: {
          transactionId,
          merchantId: merchant.id,
          terminalId: terminal.id,
          amountCents,
          method,
          installments,
          nsu: auth.nsu,
          authorizationCode: auth.authorizationCode,
          description,
          items,
          createdAt,
        },
      });

      audit(this.db, terminal.id, 'SALE_APPROVED', transactionId, {
        amountCents,
        feeCents,
        netCents,
        acquirer: routing.selected.name,
        risk: risk.score,
      });
    });

    return {
      status: 'APPROVED',
      transaction: publicTransaction(this.getRow(transactionId)),
      payment: {
        nsu: auth.nsu,
        authorizationCode: auth.authorizationCode,
        acquirerId: routing.selected.acquirerId,
        acquirerName: routing.selected.name,
        grossCents: amountCents,
        feeCents,
        netCents,
        feeFormatted: formatBRL(feeCents),
        netFormatted: formatBRL(netCents),
        settlementAt: plan.scheduledAt,
        installments,
        responseCode: auth.responseCode,
        message: auth.message,
      },
      risk,
      routing,
      fiscal: {
        status: 'PENDING',
        note: 'NFC-e sendo emitida em segundo plano; acompanhe pelo WebSocket.',
      },
    };
  }

  getRow(transactionId: string): TransactionRow {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId) as
      | TransactionRow
      | undefined;
    if (!row) throw Errors.notFound('Transação não encontrada.');
    return row;
  }

  getTransaction(transactionId: string) {
    return publicTransaction(this.getRow(transactionId));
  }

  list(merchantId: string, limit = 25): ReturnType<typeof publicTransaction>[] {
    const rows = this.db
      .prepare('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(merchantId, Math.min(200, Math.max(1, limit))) as unknown as TransactionRow[];
    return rows.map(publicTransaction);
  }
}

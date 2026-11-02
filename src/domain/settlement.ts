import type { Db } from '../kernel/db.ts';
import { bps } from '../kernel/money.ts';
import type { PaymentMethod } from './risk.ts';

export interface SettlementPlan {
  scheduledAt: string;
  daysToSettle: number;
}

/** PIX liquida em D+0, débito em D+1 e crédito/voucher em D+30. */
export function settlementPlan(method: PaymentMethod, createdAt: string): SettlementPlan {
  const days = method === 'PIX' ? 0 : method === 'DEBIT' ? 1 : 30;
  return {
    scheduledAt: new Date(new Date(createdAt).getTime() + days * 86_400_000).toISOString(),
    daysToSettle: days,
  };
}

export interface AdvanceOffer {
  eligible: boolean;
  settlementId?: string;
  rateBps: number;
  feeCents: number;
  netCents: number;
  daysEarly: number;
  reasons: string[];
}

/**
 * Precificação preditiva da antecipação: prazo restante, volume histórico e risco
 * do lojista ajustam a taxa. Quanto mais previsível o lojista, mais barato o crédito.
 */
export function advanceOffer(db: Db, transactionId: string, now: number = Date.now()): AdvanceOffer {
  const row = db
    .prepare(
      `SELECT s.id AS settlementId, s.net_cents AS netCents, s.scheduled_at AS scheduledAt,
              s.status AS status, s.mode AS mode, t.merchant_id AS merchantId, t.risk_score AS riskScore,
              t.method AS method, t.status AS txStatus
         FROM settlements s JOIN transactions t ON t.id = s.transaction_id
        WHERE s.transaction_id = ?`,
    )
    .get(transactionId) as
    | {
        settlementId: string;
        netCents: number;
        scheduledAt: string;
        status: string;
        mode: string;
        merchantId: string;
        riskScore: number;
        method: string;
        txStatus: string;
      }
    | undefined;

  if (!row) {
    return { eligible: false, rateBps: 0, feeCents: 0, netCents: 0, daysEarly: 0, reasons: ['Liquidação não encontrada.'] };
  }
  const daysEarly = Math.ceil((new Date(row.scheduledAt).getTime() - now) / 86_400_000);
  const reasons: string[] = [];
  if (row.txStatus !== 'APPROVED') reasons.push('Transação não aprovada.');
  if (row.status !== 'PENDING') reasons.push(`Liquidação já está ${row.status.toLowerCase()}.`);
  if (row.mode !== 'STANDARD') reasons.push('Recebível já antecipado.');
  if (daysEarly < 1) reasons.push('Recebível já disponível (D+0).');
  if (row.netCents <= 0) reasons.push('Valor líquido inválido.');
  if (reasons.length) {
    return { eligible: false, settlementId: row.settlementId, rateBps: 0, feeCents: 0, netCents: 0, daysEarly, reasons };
  }

  const history = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volume
         FROM transactions
        WHERE merchant_id = ? AND status = 'APPROVED' AND created_at >= ?`,
    )
    .get(row.merchantId, new Date(now - 30 * 86_400_000).toISOString()) as { count: number; volume: number };

  let rateBps = 120 + daysEarly * 9;
  if (history.volume >= 5_000_000) {
    rateBps -= 80;
    reasons.push('Desconto de 80 bps por alto volume (30d).');
  } else if (history.volume >= 1_000_000) {
    rateBps -= 40;
    reasons.push('Desconto de 40 bps por bom volume (30d).');
  }
  if (row.riskScore >= 45) {
    rateBps += 60;
    reasons.push('Prêmio de 60 bps por risco elevado.');
  }
  if (history.count >= 20) {
    rateBps -= 20;
    reasons.push('Desconto de 20 bps por recorrência.');
  }
  rateBps = Math.min(600, Math.max(80, Math.round(rateBps)));
  const feeCents = Math.max(50, bps(row.netCents, rateBps));

  return {
    eligible: true,
    settlementId: row.settlementId,
    rateBps,
    feeCents,
    netCents: Math.max(0, row.netCents - feeCents),
    daysEarly,
    reasons,
  };
}

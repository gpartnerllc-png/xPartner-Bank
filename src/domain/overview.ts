import type { Db } from '../kernel/db.ts';
import { formatBRL } from '../kernel/money.ts';
import { merchantSummary } from '../domain/ledger.ts';
import { riskGraphStats } from '../domain/risk.ts';
import { publicTransaction } from '../modules/transactions.ts';

interface TransactionRow {
  id: string;
  merchant_id: string;
  terminal_id: string;
  amount_cents: number;
  currency: string;
  method: 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER';
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

export function buildOverview(db: Db, merchantId: string, now: number = Date.now()) {
  const merchant = db
    .prepare('SELECT id, name, trade_name, document, mcc, city, uf, pix_key, status FROM merchants WHERE id = ?')
    .get(merchantId) as
    | {
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
    | undefined;
  if (!merchant) return null;

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();

  const today = db
    .prepare(
      `SELECT
         COUNT(*) AS sales,
         COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END), 0) AS approved,
         COALESCE(SUM(CASE WHEN status = 'DECLINED' THEN 1 ELSE 0 END), 0) AS declined,
         COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN amount_cents ELSE 0 END), 0) AS volumeCents,
         COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN fee_cents ELSE 0 END), 0) AS feesCents,
         COALESCE(AVG(CASE WHEN status = 'APPROVED' THEN amount_cents END), 0) AS avgTicketCents,
         COALESCE(AVG(CASE WHEN status = 'APPROVED' THEN risk_score END), 0) AS avgRisk
       FROM transactions WHERE merchant_id = ? AND created_at >= ?`,
    )
    .get(merchantId, dayIso) as {
    sales: number;
    approved: number;
    declined: number;
    volumeCents: number;
    feesCents: number;
    avgTicketCents: number;
    avgRisk: number;
  };

  const settledToday = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(s.net_cents), 0) AS netCents
         FROM settlements s JOIN transactions t ON t.id = s.transaction_id
        WHERE t.merchant_id = ? AND s.status = 'PAID' AND s.paid_at >= ?`,
    )
    .get(merchantId, dayIso) as { count: number; netCents: number };

  const balances = merchantSummary(db, merchantId);

  const fiscal = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN f.status = 'AUTHORIZED' THEN 1 ELSE 0 END), 0) AS authorized,
         COALESCE(SUM(CASE WHEN f.status = 'CONTINGENCY' THEN 1 ELSE 0 END), 0) AS contingency
       FROM fiscal_documents f WHERE f.merchant_id = ?`,
    )
    .get(merchantId) as { authorized: number; contingency: number };

  const fiscalPending = db
    .prepare(
      `SELECT COUNT(*) AS count FROM transactions
        WHERE merchant_id = ? AND status = 'APPROVED' AND (fiscal_status IS NULL OR fiscal_status = 'PENDING')`,
    )
    .get(merchantId) as { count: number };

  const settlements = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN s.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingCount,
         COALESCE(SUM(CASE WHEN s.status = 'PENDING' THEN s.net_cents ELSE 0 END), 0) AS pendingCents
       FROM settlements s JOIN transactions t ON t.id = s.transaction_id WHERE t.merchant_id = ?`,
    )
    .get(merchantId) as { pendingCount: number; pendingCents: number };

  const methods = db
    .prepare(
      `SELECT method, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volumeCents
         FROM transactions WHERE merchant_id = ? AND status = 'APPROVED' AND created_at >= ?
        GROUP BY method ORDER BY volumeCents DESC`,
    )
    .all(merchantId, dayIso) as Array<{ method: string; count: number; volumeCents: number }>;

  const recentRows = db
    .prepare('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 12')
    .all(merchantId) as unknown as TransactionRow[];

  const seriesRows = db
    .prepare(
      `SELECT created_at FROM transactions
        WHERE merchant_id = ? AND status = 'APPROVED' AND created_at >= ?`,
    )
    .all(merchantId, new Date(now - 12 * 3_600_000).toISOString()) as Array<{ created_at: string }>;
  const series: Array<{ hour: string; label: string; count: number }> = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const point = new Date(now - offset * 3_600_000);
    const bucket = point.toISOString().slice(0, 13);
    series.push({
      hour: bucket,
      label: `${String(point.getHours()).padStart(2, '0')}h`,
      count: seriesRows.filter((row) => row.created_at.slice(0, 13) === bucket).length,
    });
  }

  const riskStats = riskGraphStats(db);
  const approvalRate = today.sales > 0 ? Math.round((today.approved / today.sales) * 1000) / 10 : 100;

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      tradeName: merchant.trade_name,
      document: merchant.document,
      mcc: merchant.mcc,
      city: merchant.city,
      uf: merchant.uf,
      pixKey: merchant.pix_key,
      status: merchant.status,
    },
    today: {
      sales: today.sales,
      approved: today.approved,
      declined: today.declined,
      volumeCents: today.volumeCents,
      volumeFormatted: formatBRL(today.volumeCents),
      feesCents: today.feesCents,
      feesFormatted: formatBRL(today.feesCents),
      avgTicketCents: Math.round(today.avgTicketCents),
      avgTicketFormatted: formatBRL(Math.round(today.avgTicketCents)),
      approvalRate,
      avgRisk: Math.round(today.avgRisk),
    },
    balances: {
      availableCents: balances.availableCents,
      availableFormatted: formatBRL(balances.availableCents),
      receivableCents: balances.receivableCents,
      receivableFormatted: formatBRL(balances.receivableCents),
      feesCents: balances.platformFeeCents,
      feesFormatted: formatBRL(balances.platformFeeCents),
    },
    settledToday: {
      count: settledToday.count,
      cents: settledToday.netCents,
      formatted: formatBRL(settledToday.netCents),
    },
    fiscal: {
      authorized: fiscal.authorized,
      contingency: fiscal.contingency,
      pending: fiscalPending.count,
    },
    settlements: {
      pendingCount: settlements.pendingCount,
      pendingCents: settlements.pendingCents,
      pendingFormatted: formatBRL(settlements.pendingCents),
    },
    risk: {
      ...riskStats,
      avgScore: Math.round(today.avgRisk),
    },
    methods: methods.map((method) => ({
      method: method.method,
      count: method.count,
      volumeCents: method.volumeCents,
      volumeFormatted: formatBRL(method.volumeCents),
    })),
    series,
    recent: recentRows.map(publicTransaction),
    generatedAt: new Date(now).toISOString(),
  };
}

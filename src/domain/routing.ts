import type { Db } from '../kernel/db.ts';
import { AppError } from '../kernel/errors.ts';
import { bps } from '../kernel/money.ts';
import type { PaymentMethod } from './risk.ts';

export interface AcquirerRow {
  id: string;
  name: string;
  debitBps: number;
  creditBps: number;
  pixBps: number;
  installmentsBps: number;
  fixedFeeCents: number;
  brands: string[];
  successRate: number;
  priority: number;
}

export interface RouteQuote {
  acquirerId: string;
  name: string;
  feeCents: number;
  rateBps: number;
  successRate: number;
  expectedCostCents: number;
}

export function listAcquirers(db: Db): AcquirerRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, debit_bps, credit_bps, pix_bps, installments_bps, fixed_fee_cents, brands, success_rate, priority
         FROM acquirers WHERE active = 1 ORDER BY priority ASC, name ASC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    debit_bps: number;
    credit_bps: number;
    pix_bps: number;
    installments_bps: number;
    fixed_fee_cents: number;
    brands: string;
    success_rate: number;
    priority: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    debitBps: row.debit_bps,
    creditBps: row.credit_bps,
    pixBps: row.pix_bps,
    installmentsBps: row.installments_bps,
    fixedFeeCents: row.fixed_fee_cents,
    brands: JSON.parse(row.brands) as string[],
    successRate: row.success_rate,
    priority: row.priority,
  }));
}

function rateFor(acquirer: AcquirerRow, method: PaymentMethod): number {
  if (method === 'DEBIT') return acquirer.debitBps;
  if (method === 'PIX') return acquirer.pixBps;
  return acquirer.creditBps;
}

function supportsBrand(acquirer: AcquirerRow, brand?: string): boolean {
  if (acquirer.brands.includes('*')) return true;
  if (!brand) return false;
  return acquirer.brands.includes(brand.toLowerCase());
}

export interface RouteInput {
  method: PaymentMethod;
  brand?: string;
  installments: number;
  amountCents: number;
}

/**
 * Smart Routing: precifica cada adquirente e ranqueia pelo custo esperado
 * (taxa / taxa de sucesso), não apenas pela tabela nominal. A taxa de sucesso
 * entra na conta porque recusa também custa dinheiro ao lojista.
 */
export function routeTransaction(db: Db, input: RouteInput): { selected: RouteQuote; alternatives: RouteQuote[] } {
  const quotes: RouteQuote[] = [];
  for (const acquirer of listAcquirers(db)) {
    if (!supportsBrand(acquirer, input.brand)) continue;
    const rateBps = rateFor(acquirer, input.method);
    if (rateBps <= 0) continue;
    let fee = bps(input.amountCents, rateBps) + acquirer.fixedFeeCents;
    if (input.method === 'CREDIT' && input.installments > 1) {
      fee += bps(input.amountCents, acquirer.installmentsBps * (input.installments - 1));
    }
    const successRate = Math.min(1, Math.max(0.5, acquirer.successRate));
    quotes.push({
      acquirerId: acquirer.id,
      name: acquirer.name,
      feeCents: fee,
      rateBps,
      successRate,
      expectedCostCents: Math.round(fee / successRate),
    });
  }

  quotes.sort((left, right) => left.expectedCostCents - right.expectedCostCents || left.rateBps - right.rateBps);
  const selected = quotes[0];
  if (!selected) throw new AppError('NO_ACQUIRER', 'Nenhuma adquirente disponível para esta transação.', 503);
  return { selected, alternatives: quotes.slice(1, 4) };
}

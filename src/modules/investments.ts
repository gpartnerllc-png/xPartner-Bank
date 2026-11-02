import type { Db } from '../kernel/db.ts';
import { addDays, audit, nowIso, tx } from '../kernel/db.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { assertPositiveCents, formatBRL } from '../kernel/money.ts';
import { postGroup } from '../domain/ledger.ts';
import type { EntryInput } from '../domain/ledger.ts';

export type ProductKind = 'CDB' | 'LCI' | 'LCA' | 'TESOURO' | 'FUNDO';
export type Indexer = 'CDI' | 'PREFIXADO' | 'IPCA';
export type Liquidity = 'D0' | 'D1' | 'D30' | 'MATURITY';
export type ProventoKind = 'DIVIDENDO' | 'JCP' | 'RENDIMENTO';

const PRODUCT_KINDS: readonly ProductKind[] = ['CDB', 'LCI', 'LCA', 'TESOURO', 'FUNDO'];
const INDEXERS: readonly Indexer[] = ['CDI', 'PREFIXADO', 'IPCA'];
const LIQUIDITIES: readonly Liquidity[] = ['D0', 'D1', 'D30', 'MATURITY'];
const PROVENTO_KINDS: readonly ProventoKind[] = ['DIVIDENDO', 'JCP', 'RENDIMENTO'];
const JCP_WITHHOLDING_BPS = 1_500;

interface MerchantRow {
  id: string;
  status: string;
}

export interface ProductRow {
  id: string;
  name: string;
  kind: ProductKind;
  issuer: string;
  indexer: Indexer;
  rate_bps: number;
  liquidity: Liquidity;
  min_cents: number;
  maturity_date: string | null;
  tax_exempt: number;
  status: 'ACTIVE' | 'CLOSED';
  created_at: string;
}

export interface PositionRow {
  id: string;
  merchant_id: string;
  product_id: string;
  principal_cents: number;
  status: 'ACTIVE' | 'REDEEMED';
  opened_at: string;
  updated_at: string;
}

export interface ProventoRow {
  id: string;
  merchant_id: string;
  position_id: string;
  product_id: string;
  kind: ProventoKind;
  gross_cents: number;
  tax_cents: number;
  net_cents: number;
  status: 'SCHEDULED' | 'PAID';
  ex_date: string;
  payment_date: string;
  paid_at: string | null;
  created_at: string;
}

export interface CreateProductInput {
  name: string;
  kind: ProductKind;
  issuer: string;
  indexer: Indexer;
  rateBps: number;
  liquidity: Liquidity;
  minCents: number;
  maturityDate?: string | null;
  taxExempt?: boolean;
  now?: number;
}

export interface InvestInput {
  merchantId: string;
  productId: string;
  amountCents: number;
  now?: number;
}

export interface RedeemInput {
  merchantId: string;
  positionId: string;
  amountCents: number;
  now?: number;
}

export interface CreateProventoInput {
  merchantId: string;
  positionId: string;
  kind: ProventoKind;
  grossCents: number;
  exDate: string;
  paymentDate: string;
  now?: number;
}

function isoDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function assertIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DATE', `${field} deve estar no formato YYYY-MM-DD.`, 422);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError('INVALID_DATE', `${field} inválida.`, 422);
  }
  return value;
}

function redeemableAt(product: ProductRow, openedAt: string): string | null {
  if (product.liquidity === 'D0') return openedAt;
  if (product.liquidity === 'D1') return addDays(openedAt, 1);
  if (product.liquidity === 'D30') return addDays(openedAt, 30);
  return product.maturity_date;
}

function withholdingFor(product: ProductRow, kind: ProventoKind): number {
  if (kind === 'DIVIDENDO') return 0;
  if (kind === 'JCP') return JCP_WITHHOLDING_BPS;
  return product.tax_exempt === 1 ? 0 : JCP_WITHHOLDING_BPS;
}

export function publicProduct(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    issuer: row.issuer,
    indexer: row.indexer,
    rateBps: row.rate_bps,
    ratePercent: row.rate_bps / 100,
    liquidity: row.liquidity,
    minCents: row.min_cents,
    minFormatted: formatBRL(row.min_cents),
    maturityDate: row.maturity_date,
    taxExempt: row.tax_exempt === 1,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function publicPosition(row: PositionRow, product?: ProductRow | null) {
  return {
    id: row.id,
    productId: row.product_id,
    productName: product?.name ?? null,
    kind: product?.kind ?? null,
    issuer: product?.issuer ?? null,
    indexer: product?.indexer ?? null,
    rateBps: product?.rate_bps ?? null,
    liquidity: product?.liquidity ?? null,
    principalCents: row.principal_cents,
    principalFormatted: formatBRL(row.principal_cents),
    status: row.status,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    redeemableAt: product ? redeemableAt(product, row.opened_at) : null,
  };
}

export function publicProvento(row: ProventoRow, product?: ProductRow | null) {
  return {
    id: row.id,
    positionId: row.position_id,
    productId: row.product_id,
    productName: product?.name ?? null,
    kind: row.kind,
    grossCents: row.gross_cents,
    grossFormatted: formatBRL(row.gross_cents),
    taxCents: row.tax_cents,
    taxFormatted: formatBRL(row.tax_cents),
    netCents: row.net_cents,
    netFormatted: formatBRL(row.net_cents),
    status: row.status,
    exDate: row.ex_date,
    paymentDate: row.payment_date,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export class InvestmentService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private merchant(merchantId: string): MerchantRow {
    const merchant = this.db.prepare('SELECT id, status FROM merchants WHERE id = ?').get(merchantId) as
      | MerchantRow
      | undefined;
    if (!merchant) throw Errors.notFound('Estabelecimento não encontrado.');
    if (merchant.status !== 'ACTIVE') throw new AppError('MERCHANT_INACTIVE', 'Estabelecimento inativo.', 409);
    return merchant;
  }

  private availableCents(merchantId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS balance
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ? AND a.kind = 'MERCHANT_AVAILABLE'`,
      )
      .get(merchantId) as { balance: number };
    return row.balance;
  }

  private product(productId: string): ProductRow {
    const row = this.db.prepare('SELECT * FROM investment_products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined;
    if (!row) throw Errors.notFound('Produto de investimento não encontrado.');
    return row;
  }

  private position(merchantId: string, positionId: string): PositionRow {
    const row = this.db.prepare('SELECT * FROM investment_positions WHERE id = ?').get(positionId) as
      | PositionRow
      | undefined;
    if (!row) throw Errors.notFound('Posição de investimento não encontrada.');
    if (row.merchant_id !== merchantId) throw Errors.forbidden('Posição não pertence ao estabelecimento.');
    return row;
  }

  createProduct(input: CreateProductInput) {
    const now = input.now ?? Date.now();
    if (!PRODUCT_KINDS.includes(input.kind)) throw new AppError('INVALID_PRODUCT_KIND', 'Tipo de produto inválido.', 422);
    if (!INDEXERS.includes(input.indexer)) throw new AppError('INVALID_INDEXER', 'Indexador inválido.', 422);
    if (!LIQUIDITIES.includes(input.liquidity)) throw new AppError('INVALID_LIQUIDITY', 'Liquidez inválida.', 422);
    const name = String(input.name ?? '').trim();
    if (name.length < 3 || name.length > 80) throw new AppError('INVALID_NAME', 'Nome do produto inválido.', 422);
    const issuer = String(input.issuer ?? '').trim();
    if (issuer.length < 2 || issuer.length > 60) throw new AppError('INVALID_ISSUER', 'Emissor inválido.', 422);
    if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 50_000) {
      throw new AppError('INVALID_RATE', 'Taxa do produto inválida.', 422);
    }
    const minCents = assertPositiveCents(input.minCents, 'aporte mínimo');
    const maturityDate = input.maturityDate ? assertIsoDate(input.maturityDate, 'Vencimento') : null;
    if (input.liquidity === 'MATURITY' && !maturityDate) {
      throw new AppError('INVALID_DUE_DATE', 'Produto com liquidez no vencimento exige data de vencimento.', 422);
    }
    const id = newId('ipr', now);
    const createdAt = nowIso(now);
    this.db
      .prepare(
        `INSERT INTO investment_products
           (id, name, kind, issuer, indexer, rate_bps, liquidity, min_cents, maturity_date,
            tax_exempt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      )
      .run(
        id,
        name,
        input.kind,
        issuer,
        input.indexer,
        input.rateBps,
        input.liquidity,
        minCents,
        maturityDate,
        input.taxExempt ? 1 : 0,
        createdAt,
      );
    audit(this.db, 'investments', 'PRODUCT_CREATED', id, { kind: input.kind, indexer: input.indexer });
    return publicProduct(this.product(id));
  }

  listProducts(filter: { kind?: string; limit?: number } = {}) {
    const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
    const rows = (filter.kind
      ? this.db
          .prepare('SELECT * FROM investment_products WHERE status = ? AND kind = ? ORDER BY created_at DESC LIMIT ?')
          .all('ACTIVE', filter.kind, limit)
      : this.db
          .prepare('SELECT * FROM investment_products WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all('ACTIVE', limit)) as unknown as ProductRow[];
    return rows.map(publicProduct);
  }

  invest(input: InvestInput) {
    const now = input.now ?? Date.now();
    this.merchant(input.merchantId);
    const product = this.product(input.productId);
    if (product.status !== 'ACTIVE') throw new AppError('PRODUCT_CLOSED', 'Produto indisponível para aportes.', 409);
    const amountCents = assertPositiveCents(input.amountCents, 'valor do aporte');
    if (amountCents < product.min_cents) {
      throw new AppError('BELOW_MINIMUM', 'Aporte abaixo do mínimo do produto.', 422, {
        minCents: product.min_cents,
        minFormatted: formatBRL(product.min_cents),
      });
    }
    const available = this.availableCents(input.merchantId);
    if (available < amountCents) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo disponível insuficiente para o aporte.', 422, {
        requiredCents: amountCents,
        availableCents: available,
      });
    }

    const timestamp = nowIso(now);
    const existing = this.db
      .prepare('SELECT * FROM investment_positions WHERE merchant_id = ? AND product_id = ?')
      .get(input.merchantId, product.id) as PositionRow | undefined;

    const positionId = tx(this.db, () => {
      let position: PositionRow;
      if (existing) {
        const reactivating = existing.status === 'REDEEMED';
        this.db
          .prepare(
            `UPDATE investment_positions
                SET principal_cents = principal_cents + ?, status = 'ACTIVE',
                    opened_at = CASE WHEN ? THEN ? ELSE opened_at END, updated_at = ?
              WHERE id = ?`,
          )
          .run(amountCents, reactivating ? 1 : 0, timestamp, timestamp, existing.id);
        position = this.db
          .prepare('SELECT * FROM investment_positions WHERE id = ?')
          .get(existing.id) as unknown as PositionRow;
      } else {
        position = {
          id: newId('ipo', now),
          merchant_id: input.merchantId,
          product_id: product.id,
          principal_cents: amountCents,
          status: 'ACTIVE',
          opened_at: timestamp,
          updated_at: timestamp,
        };
        this.db
          .prepare(
            `INSERT INTO investment_positions
               (id, merchant_id, product_id, principal_cents, status, opened_at, updated_at)
             VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          )
          .run(
            position.id,
            position.merchant_id,
            position.product_id,
            position.principal_cents,
            position.opened_at,
            position.updated_at,
          );
      }
      postGroup(this.db, {
        groupId: `invest_${position.id}_${numericSuffix(now)}`,
        groupKind: 'INVESTMENT_CONTRIBUTION',
        createdAt: timestamp,
        entries: [
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: input.merchantId,
            direction: 'DEBIT',
            amountCents,
            memo: `Aporte · ${product.name}`,
          },
          {
            kind: 'INVESTMENT_PRINCIPAL',
            ownerType: 'MERCHANT',
            ownerId: input.merchantId,
            direction: 'CREDIT',
            amountCents,
            memo: `Aporte · ${product.name}`,
          },
        ],
      });
      audit(this.db, 'investments', 'CONTRIBUTION', position.id, {
        productId: product.id,
        amountCents,
      });
      return position.id;
    });

    const updated = this.db.prepare('SELECT * FROM investment_positions WHERE id = ?').get(positionId) as unknown as PositionRow;
    return {
      position: publicPosition(updated, product),
      availableCents: this.availableCents(input.merchantId),
      availableFormatted: formatBRL(this.availableCents(input.merchantId)),
    };
  }

  redeem(input: RedeemInput) {
    const now = input.now ?? Date.now();
    this.merchant(input.merchantId);
    const position = this.position(input.merchantId, input.positionId);
    if (position.status !== 'ACTIVE') throw new AppError('POSITION_CLOSED', 'Posição já resgatada.', 409);
    const product = this.product(position.product_id);
    const amountCents = assertPositiveCents(input.amountCents, 'valor do resgate');
    if (amountCents > position.principal_cents) {
      throw new AppError('EXCEEDS_POSITION', 'Resgate maior que o saldo investido.', 422, {
        principalCents: position.principal_cents,
      });
    }
    const readyAt = redeemableAt(product, position.opened_at);
    if (readyAt && now < Date.parse(readyAt)) {
      throw new AppError('NOT_LIQUID', 'Produto indisponível para resgate nesta data.', 409, {
        redeemableAt: readyAt,
        liquidity: product.liquidity,
      });
    }
    const timestamp = nowIso(now);
    const remaining = position.principal_cents - amountCents;

    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE investment_positions
              SET principal_cents = ?, status = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(remaining, remaining === 0 ? 'REDEEMED' : 'ACTIVE', timestamp, position.id);
      postGroup(this.db, {
        groupId: `redeem_${position.id}_${numericSuffix(now)}`,
        groupKind: 'INVESTMENT_REDEMPTION',
        createdAt: timestamp,
        entries: [
          {
            kind: 'INVESTMENT_PRINCIPAL',
            ownerType: 'MERCHANT',
            ownerId: input.merchantId,
            direction: 'DEBIT',
            amountCents,
            memo: `Resgate · ${product.name}`,
          },
          {
            kind: 'MERCHANT_AVAILABLE',
            ownerType: 'MERCHANT',
            ownerId: input.merchantId,
            direction: 'CREDIT',
            amountCents,
            memo: `Resgate · ${product.name}`,
          },
        ],
      });
      audit(this.db, 'investments', 'REDEMPTION', position.id, {
        productId: product.id,
        amountCents,
        remainingCents: remaining,
      });
    });

    const updated = this.db.prepare('SELECT * FROM investment_positions WHERE id = ?').get(position.id) as unknown as PositionRow;
    return {
      position: publicPosition(updated, product),
      availableCents: this.availableCents(input.merchantId),
      availableFormatted: formatBRL(this.availableCents(input.merchantId)),
    };
  }

  createProvento(input: CreateProventoInput) {
    const now = input.now ?? Date.now();
    this.merchant(input.merchantId);
    if (!PROVENTO_KINDS.includes(input.kind)) throw new AppError('INVALID_PROVENTO_KIND', 'Tipo de provento inválido.', 422);
    const position = this.position(input.merchantId, input.positionId);
    if (position.status !== 'ACTIVE') throw new AppError('POSITION_CLOSED', 'Posição não está ativa.', 409);
    const product = this.product(position.product_id);
    const grossCents = assertPositiveCents(input.grossCents, 'valor do provento');
    const exDate = assertIsoDate(input.exDate, 'Data ex');
    const paymentDate = assertIsoDate(input.paymentDate, 'Data de pagamento');
    if (paymentDate < exDate) throw new AppError('INVALID_DATE', 'Pagamento não pode anteceder a data ex.', 422);
    const taxCents = Math.round((grossCents * withholdingFor(product, input.kind)) / 10_000);
    const netCents = grossCents - taxCents;
    if (netCents <= 0) throw new AppError('INVALID_AMOUNT', 'Valor líquido do provento deve ser positivo.', 422);

    const id = newId('pro', now);
    const createdAt = nowIso(now);
    this.db
      .prepare(
        `INSERT INTO investment_proventos
           (id, merchant_id, position_id, product_id, kind, gross_cents, tax_cents, net_cents,
            status, ex_date, payment_date, paid_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.merchantId,
        position.id,
        product.id,
        input.kind,
        grossCents,
        taxCents,
        netCents,
        exDate,
        paymentDate,
        createdAt,
      );
    audit(this.db, 'investments', 'PROVENTO_SCHEDULED', id, {
      kind: input.kind,
      grossCents,
      taxCents,
      netCents,
    });
    return publicProvento(this.db.prepare('SELECT * FROM investment_proventos WHERE id = ?').get(id) as unknown as ProventoRow, product);
  }

  /** Liquida proventos vencidos. Idempotente: só considera status SCHEDULED. */
  settleDue(now: number = Date.now()): number {
    const today = isoDay(now);
    const due = this.db
      .prepare("SELECT * FROM investment_proventos WHERE status = 'SCHEDULED' AND payment_date <= ?")
      .all(today) as unknown as ProventoRow[];
    let settled = 0;
    for (const row of due) {
      const paidAt = nowIso(now);
      const entries: EntryInput[] = [
        {
          kind: 'INVESTMENT_INCOME',
          direction: 'DEBIT',
          amountCents: row.gross_cents,
          memo: `Provento ${row.kind} ${row.id}`,
        },
        {
          kind: 'MERCHANT_AVAILABLE',
          ownerType: 'MERCHANT',
          ownerId: row.merchant_id,
          direction: 'CREDIT',
          amountCents: row.net_cents,
          memo: `Provento ${row.kind} líquido`,
        },
      ];
      if (row.tax_cents > 0) {
        entries.push({
          kind: 'TAX_PAYABLE',
          direction: 'CREDIT',
          amountCents: row.tax_cents,
          memo: `IR retido · provento ${row.id}`,
        });
      }
      tx(this.db, () => {
        postGroup(this.db, {
          groupId: `prov_${row.id}`,
          groupKind: 'INVESTMENT_PROVENTO',
          createdAt: paidAt,
          entries,
        });
        this.db
          .prepare("UPDATE investment_proventos SET status = 'PAID', paid_at = ? WHERE id = ? AND status = 'SCHEDULED'")
          .run(paidAt, row.id);
        audit(this.db, 'investments', 'PROVENTO_PAID', row.id, {
          grossCents: row.gross_cents,
          netCents: row.net_cents,
          taxCents: row.tax_cents,
        });
      });
      settled += 1;
    }
    return settled;
  }

  positions(merchantId: string, filter: { limit?: number } = {}) {
    this.merchant(merchantId);
    const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
    const rows = this.db
      .prepare('SELECT * FROM investment_positions WHERE merchant_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(merchantId, limit) as unknown as PositionRow[];
    const products = new Map(
      (this.db.prepare('SELECT * FROM investment_products').all() as unknown as ProductRow[]).map((row) => [row.id, row]),
    );
    return rows.map((row) => publicPosition(row, products.get(row.product_id) ?? null));
  }

  proventos(merchantId: string, filter: { limit?: number; status?: string } = {}) {
    this.merchant(merchantId);
    const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
    const rows = (filter.status
      ? this.db
          .prepare(
            'SELECT * FROM investment_proventos WHERE merchant_id = ? AND status = ? ORDER BY payment_date DESC LIMIT ?',
          )
          .all(merchantId, filter.status, limit)
      : this.db
          .prepare('SELECT * FROM investment_proventos WHERE merchant_id = ? ORDER BY payment_date DESC LIMIT ?')
          .all(merchantId, limit)) as unknown as ProventoRow[];
    const products = new Map(
      (this.db.prepare('SELECT * FROM investment_products').all() as unknown as ProductRow[]).map((row) => [row.id, row]),
    );
    return rows.map((row) => publicProvento(row, products.get(row.product_id) ?? null));
  }

  overview(merchantId: string, now: number = Date.now()) {
    this.merchant(merchantId);
    this.settleDue(now);
    const products = this.listProducts({ limit: 20 });
    const positions = this.positions(merchantId, { limit: 20 });
    const proventos = this.proventos(merchantId, { limit: 20 });

    const investedCents = positions
      .filter((row) => row.status === 'ACTIVE')
      .reduce((total, row) => total + row.principalCents, 0);
    const monthStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const paidThisMonth = proventos.filter(
      (row) => row.status === 'PAID' && row.paymentDate >= monthStart,
    );
    const proventosCents = paidThisMonth.reduce((total, row) => total + row.netCents, 0);
    const taxCents = paidThisMonth.reduce((total, row) => total + row.taxCents, 0);
    const scheduledCents = proventos
      .filter((row) => row.status === 'SCHEDULED')
      .reduce((total, row) => total + row.netCents, 0);

    return {
      kpis: {
        investedCents,
        investedFormatted: formatBRL(investedCents),
        activePositions: positions.filter((row) => row.status === 'ACTIVE').length,
        proventosCents,
        proventosFormatted: formatBRL(proventosCents),
        taxCents,
        taxFormatted: formatBRL(taxCents),
        scheduledCents,
        scheduledFormatted: formatBRL(scheduledCents),
        availableCents: this.availableCents(merchantId),
        availableFormatted: formatBRL(this.availableCents(merchantId)),
      },
      products,
      positions,
      proventos,
    };
  }
}

function numericSuffix(now: number): string {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

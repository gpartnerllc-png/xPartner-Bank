import assert from 'node:assert/strict';
import test from 'node:test';
import { testConfig, testDb } from './helpers.ts';
import { InvestmentService } from '../src/modules/investments.ts';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';
import { postGroup } from '../src/domain/ledger.ts';
import type { Db } from '../src/kernel/db.ts';
import type { AppError } from '../src/kernel/errors.ts';

const merchantId = DEMO_MERCHANT_ID;
const now = Date.UTC(2026, 9, 31, 12, 0, 0);

function setup() {
  const db = testDb();
  const investments = new InvestmentService(db);
  return { db, investments };
}

function fund(db: Db, amountCents: number, timestamp: number): void {
  postGroup(db, {
    groupId: `fund_inv_${timestamp}`,
    groupKind: 'TEST_FUNDING',
    createdAt: new Date(timestamp).toISOString(),
    entries: [
      { kind: 'CASH', direction: 'DEBIT', amountCents },
      {
        kind: 'MERCHANT_AVAILABLE',
        ownerType: 'MERCHANT',
        ownerId: merchantId,
        direction: 'CREDIT',
        amountCents,
      },
    ],
  });
}

function available(db: Db): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS balance
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE a.owner_type = 'MERCHANT' AND a.owner_id = ? AND a.kind = 'MERCHANT_AVAILABLE'`,
      )
      .get(merchantId) as { balance: number }
  ).balance;
}

function expectCode(code: string) {
  return (error: unknown) => (error as AppError).code === code;
}

function dailyCdb(investments: InvestmentService) {
  return investments.createProduct({
    name: 'CDB xPartner Liquidez Diária',
    kind: 'CDB',
    issuer: 'xPartner Bank',
    indexer: 'CDI',
    rateBps: 10_200,
    liquidity: 'D0',
    minCents: 5_000,
    now,
  });
}

test('investimentos: cadastro de produto valida parâmetros', () => {
  const { investments } = setup();
  const lci = investments.createProduct({
    name: 'LCI Habitação 90 dias',
    kind: 'LCI',
    issuer: 'xPartner Crédito Imobiliário',
    indexer: 'IPCA',
    rateBps: 650,
    liquidity: 'D30',
    minCents: 5_000,
    taxExempt: true,
    now,
  });
  assert.equal(lci.taxExempt, true);
  assert.equal(lci.ratePercent, 6.5);
  assert.equal(lci.minFormatted.replace(/\u00a0/g, ' '), 'R$ 50,00');

  assert.throws(
    () =>
      investments.createProduct({
        name: 'Tesouro sem vencimento',
        kind: 'TESOURO',
        issuer: 'Tesouro Nacional',
        indexer: 'CDI',
        rateBps: 10_000,
        liquidity: 'MATURITY',
        minCents: 1_000,
        now,
      }),
    expectCode('INVALID_DUE_DATE'),
  );
  assert.throws(
    () =>
      investments.createProduct({
        name: 'Produto inválido',
        kind: 'CDB',
        issuer: 'xPartner',
        indexer: 'SELIC' as unknown as 'CDI',
        rateBps: 1_000,
        liquidity: 'D0',
        minCents: 1_000,
        now,
      }),
    expectCode('INVALID_INDEXER'),
  );
  assert.equal(investments.listProducts().length, 1);
});

test('investimentos: aporte debita disponível e acumula posição', () => {
  const { db, investments } = setup();
  fund(db, 100_000, now);
  const product = dailyCdb(investments);

  assert.throws(
    () => investments.invest({ merchantId, productId: product.id, amountCents: 1_000, now }),
    expectCode('BELOW_MINIMUM'),
  );
  assert.throws(
    () => investments.invest({ merchantId, productId: product.id, amountCents: 200_000, now }),
    expectCode('INSUFFICIENT_FUNDS'),
  );

  const first = investments.invest({ merchantId, productId: product.id, amountCents: 10_000, now });
  assert.equal(first.position.principalCents, 10_000);
  assert.equal(first.position.status, 'ACTIVE');
  assert.equal(available(db), 90_000);

  const second = investments.invest({ merchantId, productId: product.id, amountCents: 20_000, now: now + 1_000 });
  assert.equal(second.position.id, first.position.id);
  assert.equal(second.position.principalCents, 30_000);
  assert.equal(available(db), 70_000);

  const position = db
    .prepare('SELECT principal_cents FROM investment_positions WHERE id = ?')
    .get(first.position.id) as { principal_cents: number };
  assert.equal(position.principal_cents, 30_000);

  const trial = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents END), 0) AS debit,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents END), 0) AS credit
         FROM ledger_entries`,
    )
    .get() as { debit: number; credit: number };
  assert.equal(trial.debit, trial.credit);
});

test('investimentos: resgate respeita liquidez e devolve saldo disponível', () => {
  const { db, investments } = setup();
  fund(db, 100_000, now);
  const cdb = dailyCdb(investments);
  const lci = investments.createProduct({
    name: 'LCI Habitação 90 dias',
    kind: 'LCI',
    issuer: 'xPartner Crédito Imobiliário',
    indexer: 'IPCA',
    rateBps: 650,
    liquidity: 'D30',
    minCents: 5_000,
    taxExempt: true,
    now,
  });

  const cdbPosition = investments.invest({ merchantId, productId: cdb.id, amountCents: 10_000, now }).position;
  assert.throws(
    () => investments.redeem({ merchantId, positionId: cdbPosition.id, amountCents: 20_000, now }),
    expectCode('EXCEEDS_POSITION'),
  );
  const partial = investments.redeem({ merchantId, positionId: cdbPosition.id, amountCents: 4_000, now });
  assert.equal(partial.position.principalCents, 6_000);
  assert.equal(available(db), 94_000);

  const full = investments.redeem({ merchantId, positionId: cdbPosition.id, amountCents: 6_000, now: now + 60_000 });
  assert.equal(full.position.status, 'REDEEMED');
  assert.equal(available(db), 100_000);
  assert.throws(
    () => investments.redeem({ merchantId, positionId: cdbPosition.id, amountCents: 100, now }),
    expectCode('POSITION_CLOSED'),
  );

  const lciPosition = investments.invest({ merchantId, productId: lci.id, amountCents: 5_000, now }).position;
  assert.throws(
    () => investments.redeem({ merchantId, positionId: lciPosition.id, amountCents: 1_000, now }),
    expectCode('NOT_LIQUID'),
  );
  const liquid = investments.redeem({
    merchantId,
    positionId: lciPosition.id,
    amountCents: 1_000,
    now: now + 31 * 86_400_000,
  });
  assert.equal(liquid.position.principalCents, 4_000);
});

test('investimentos: proventos aplicam IR e liquidam com lançamento contábil', () => {
  const { db, investments } = setup();
  fund(db, 100_000, now);
  const cdb = dailyCdb(investments);
  const lci = investments.createProduct({
    name: 'LCI Habitação 90 dias',
    kind: 'LCI',
    issuer: 'xPartner Crédito Imobiliário',
    indexer: 'IPCA',
    rateBps: 650,
    liquidity: 'D30',
    minCents: 5_000,
    taxExempt: true,
    now,
  });
  const cdbPosition = investments.invest({ merchantId, productId: cdb.id, amountCents: 10_000, now }).position;
  const lciPosition = investments.invest({ merchantId, productId: lci.id, amountCents: 5_000, now }).position;

  const jcp = investments.createProvento({
    merchantId,
    positionId: cdbPosition.id,
    kind: 'JCP',
    grossCents: 1_000,
    exDate: '2026-10-20',
    paymentDate: '2026-10-31',
    now,
  });
  assert.equal(jcp.taxCents, 150);
  assert.equal(jcp.netCents, 850);
  assert.equal(jcp.status, 'SCHEDULED');

  const exemptRendimento = investments.createProvento({
    merchantId,
    positionId: lciPosition.id,
    kind: 'RENDIMENTO',
    grossCents: 500,
    exDate: '2026-10-20',
    paymentDate: '2026-10-31',
    now,
  });
  assert.equal(exemptRendimento.taxCents, 0);
  assert.equal(exemptRendimento.netCents, 500);

  const dividendo = investments.createProvento({
    merchantId,
    positionId: cdbPosition.id,
    kind: 'DIVIDENDO',
    grossCents: 700,
    exDate: '2026-10-25',
    paymentDate: '2026-11-05',
    now,
  });
  assert.equal(dividendo.taxCents, 0);

  assert.throws(
    () =>
      investments.createProvento({
        merchantId,
        positionId: cdbPosition.id,
        kind: 'JCP',
        grossCents: 100,
        exDate: '2026-10-25',
        paymentDate: '2026-10-20',
        now,
      }),
    expectCode('INVALID_DATE'),
  );

  const before = available(db);
  const settled = investments.settleDue(now + 60_000);
  assert.equal(settled, 2, 'JCP e rendimento isento vencem hoje');
  assert.equal(available(db), before + 850 + 500);

  const tax = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS balance
         FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.kind = 'TAX_PAYABLE'`,
    )
    .get() as { balance: number };
  assert.equal(tax.balance, 150);

  const paid = db
    .prepare("SELECT COUNT(*) AS count FROM investment_proventos WHERE status = 'PAID'")
    .get() as { count: number };
  assert.equal(paid.count, 2);
  assert.equal(investments.settleDue(now + 120_000), 0, 'liquidação deve ser idempotente');

  const trial = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents END), 0) AS debit,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents END), 0) AS credit
         FROM ledger_entries`,
    )
    .get() as { debit: number; credit: number };
  assert.equal(trial.debit, trial.credit);
});

test('investimentos: overview consolida carteira, proventos e impostos', () => {
  const { db, investments } = setup();
  fund(db, 100_000, now);
  const cdb = dailyCdb(investments);
  const position = investments.invest({ merchantId, productId: cdb.id, amountCents: 20_000, now }).position;

  investments.createProvento({
    merchantId,
    positionId: position.id,
    kind: 'RENDIMENTO',
    grossCents: 2_000,
    exDate: '2026-10-20',
    paymentDate: '2026-10-30',
    now,
  });

  const overview = investments.overview(merchantId, now + 60_000);
  assert.equal(overview.kpis.investedCents, 20_000);
  assert.equal(overview.kpis.activePositions, 1);
  assert.equal(overview.kpis.proventosCents, 1_700);
  assert.equal(overview.kpis.taxCents, 300);
  assert.equal(overview.kpis.availableCents, 81_700);
  assert.equal(overview.products.length, 1);
  assert.equal(overview.positions.length, 1);
  assert.equal(overview.proventos[0].status, 'PAID');
});

test('investimentos: aposição inválida de outro lojista é bloqueada', () => {
  const { db, investments } = setup();
  fund(db, 50_000, now);
  const product = dailyCdb(investments);
  const position = investments.invest({ merchantId, productId: product.id, amountCents: 5_000, now }).position;

  db.prepare(
    `INSERT INTO merchants (id, name, trade_name, document, mcc, ie, crt, city, uf, pix_key, status, created_at)
     VALUES ('mch_other', 'Outro', 'Outro', '11222333000181', '5812', '1', '1', 'SAO PAULO', 'SP', 'x@y.com', 'ACTIVE', ?)`,
  ).run(new Date(now).toISOString());

  assert.throws(
    () => investments.redeem({ merchantId: 'mch_other', positionId: position.id, amountCents: 1_000, now }),
    expectCode('FORBIDDEN'),
  );
});

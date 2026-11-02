import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import type { InvestmentService } from './investments.ts';
import { DEMO_MERCHANT_ID } from './seed.ts';

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function seedInvestments(db: Db, config: AppConfig, investments: InvestmentService): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM investment_products').get() as { count: number };
  if (existing.count > 0) return;

  try {
    const cdb = investments.createProduct({
      name: 'CDB xPartner Liquidez Diária',
      kind: 'CDB',
      issuer: 'xPartner Bank',
      indexer: 'CDI',
      rateBps: 10_200,
      liquidity: 'D0',
      minCents: 5_000,
    });
    const lci = investments.createProduct({
      name: 'LCI Habitação 90 dias',
      kind: 'LCI',
      issuer: 'xPartner Crédito Imobiliário',
      indexer: 'IPCA',
      rateBps: 650,
      liquidity: 'D30',
      minCents: 5_000,
      taxExempt: true,
    });
    investments.createProduct({
      name: 'Tesouro Selic 2029',
      kind: 'TESOURO',
      issuer: 'Tesouro Nacional',
      indexer: 'CDI',
      rateBps: 10_050,
      liquidity: 'D1',
      minCents: 10_000,
      maturityDate: '2029-03-01',
    });
    investments.createProduct({
      name: 'Fundo xPartner Crédito Privado',
      kind: 'FUNDO',
      issuer: 'xPartner Asset Management',
      indexer: 'CDI',
      rateBps: 10_800,
      liquidity: 'D30',
      minCents: 10_000,
    });

    const cdbPosition = investments.invest({
      merchantId: DEMO_MERCHANT_ID,
      productId: cdb.id,
      amountCents: 10_000,
    }).position;
    const lciPosition = investments.invest({
      merchantId: DEMO_MERCHANT_ID,
      productId: lci.id,
      amountCents: 5_000,
    }).position;

    investments.createProvento({
      merchantId: DEMO_MERCHANT_ID,
      positionId: cdbPosition.id,
      kind: 'RENDIMENTO',
      grossCents: 450,
      exDate: dateFromNow(-8),
      paymentDate: dateFromNow(-5),
    });
    investments.createProvento({
      merchantId: DEMO_MERCHANT_ID,
      positionId: cdbPosition.id,
      kind: 'JCP',
      grossCents: 300,
      exDate: dateFromNow(10),
      paymentDate: dateFromNow(20),
    });
    investments.createProvento({
      merchantId: DEMO_MERCHANT_ID,
      positionId: lciPosition.id,
      kind: 'RENDIMENTO',
      grossCents: 320,
      exDate: dateFromNow(20),
      paymentDate: dateFromNow(30),
    });

    log.info('seed.investments', { products: 4, positions: 2, proventos: 3 });
  } catch (error) {
    log.warn('seed.investments_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

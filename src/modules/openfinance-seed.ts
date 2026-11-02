import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import type { OpenFinanceService } from './openfinance.ts';
import { DEMO_MERCHANT_ID } from './seed.ts';

function daysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function seedOpenFinance(db: Db, config: AppConfig, openfinance: OpenFinanceService): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM of_consents').get() as { count: number };
  if (existing.count > 0) return;

  const customer = (name: string): string | undefined =>
    (
      db
        .prepare('SELECT id FROM customers WHERE merchant_id = ? AND name = ?')
        .get(DEMO_MERCHANT_ID, name) as { id: string } | undefined
    )?.id;

  const mariana = customer('Mariana Costa');
  const rafael = customer('Rafael Almeida');
  const cafe = customer('Café & Cia Comércio Ltda');
  const padaria = customer('Padaria Central ME');

  try {
    if (mariana) {
      const consent = openfinance.createConsent({
        merchantId: DEMO_MERCHANT_ID,
        customerId: mariana,
        provider: 'Banco do Brasil S.A.',
        providerCode: 'BB',
        kind: 'EXTERNAL_DEBIT',
        account: {
          type: 'CHECKING',
          branch: '1234',
          number: '56789012',
          balanceCents: 1_849_000,
        },
        expiresInDays: 120,
        now: daysAgo(25),
      });
      openfinance.authorize(DEMO_MERCHANT_ID, consent.id, { now: daysAgo(24) });

      const settled = openfinance.createDebit({
        merchantId: DEMO_MERCHANT_ID,
        consentId: consent.id,
        amountCents: 8_990,
        description: 'Mensalidade do buffet',
        dueDate: dateFromNow(-12),
        now: daysAgo(12),
      });
      openfinance.settleDebit(DEMO_MERCHANT_ID, settled.id, daysAgo(11));

      openfinance.createDebit({
        merchantId: DEMO_MERCHANT_ID,
        consentId: consent.id,
        amountCents: 12_500,
        description: 'Encomenda de doces',
        dueDate: dateFromNow(6),
        now: daysAgo(1),
      });
    }

    if (cafe) {
      const consent = openfinance.createConsent({
        merchantId: DEMO_MERCHANT_ID,
        customerId: cafe,
        provider: 'Itaú Unibanco S.A.',
        providerCode: 'ITAU',
        kind: 'PAYMENT_INITIATION',
        account: {
          type: 'PAYMENT',
          branch: '0001',
          number: '34891207',
          balanceCents: 965_000,
        },
        expiresInDays: 90,
        now: daysAgo(18),
      });
      openfinance.authorize(DEMO_MERCHANT_ID, consent.id, { now: daysAgo(18) });

      const payment = openfinance.createPayment({
        merchantId: DEMO_MERCHANT_ID,
        consentId: consent.id,
        amountCents: 12_000,
        pixKey: 'compras@cafeecia.com.br',
        description: 'Compra de insumos',
        now: daysAgo(6),
      });
      openfinance.settlePayment(DEMO_MERCHANT_ID, payment.id, daysAgo(6));
    }

    if (rafael) {
      openfinance.createConsent({
        merchantId: DEMO_MERCHANT_ID,
        customerId: rafael,
        provider: 'Nu Pagamentos S.A.',
        providerCode: 'NU',
        kind: 'DATA_SHARING',
        account: {
          type: 'PAYMENT',
          branch: '0001',
          number: '77120455',
        },
        expiresInDays: 60,
        now: daysAgo(2),
      });
    }

    if (padaria) {
      const rejected = openfinance.createConsent({
        merchantId: DEMO_MERCHANT_ID,
        customerId: padaria,
        provider: 'Banco Santander (Brasil) S.A.',
        providerCode: 'SANTANDER',
        kind: 'EXTERNAL_DEBIT',
        account: {
          type: 'CHECKING',
          branch: '3344',
          number: '10293847',
        },
        expiresInDays: 90,
        now: daysAgo(9),
      });
      openfinance.reject(DEMO_MERCHANT_ID, rejected.id, 'Titular optou por não compartilhar', daysAgo(9));
    }

    log.info('seed.open_finance', { consents: 4 });
  } catch (error) {
    log.warn('seed.open_finance_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

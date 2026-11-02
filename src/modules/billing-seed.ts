import type { AppConfig } from '../config.ts';
import type { Db } from '../kernel/db.ts';
import { log } from '../kernel/logger.ts';
import type { BillingService } from './billing.ts';
import type { CustomerService } from './customers.ts';
import type { SubscriptionService } from './subscriptions.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from './seed.ts';

function daysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function seedBilling(
  db: Db,
  config: AppConfig,
  customers: CustomerService,
  billing: BillingService,
  subscriptions: SubscriptionService,
): void {
  if (!config.demoMode || !config.seedDemo) return;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM customers').get() as { count: number };
  if (existing.count > 0) return;

  const mariana = customers.create({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Mariana Costa',
    document: '52998224725',
    email: 'mariana.costa@exemplo.com.br',
    phone: '11987654321',
    city: 'São Paulo',
    uf: 'SP',
    now: daysAgo(45),
  });
  const rafael = customers.create({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Rafael Almeida',
    document: '11144477735',
    email: 'rafael.almeida@exemplo.com.br',
    phone: '21987654321',
    city: 'Rio de Janeiro',
    uf: 'RJ',
    now: daysAgo(38),
  });
  const cafe = customers.create({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Café & Cia Comércio Ltda',
    document: '11222333000181',
    email: 'compras@cafeecia.com.br',
    phone: '11933334444',
    city: 'São Paulo',
    uf: 'SP',
    now: daysAgo(30),
  });
  const padaria = customers.create({
    merchantId: DEMO_MERCHANT_ID,
    name: 'Padaria Central ME',
    document: '34028316000103',
    email: 'financeiro@padariacentral.com.br',
    phone: '1932221100',
    city: 'Campinas',
    uf: 'SP',
    now: daysAgo(21),
  });

  try {
    const paid = billing.createBoleto({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      customerId: mariana.id,
      amountCents: 18_990,
      dueDate: dateFromNow(-25),
      description: 'Encomenda de festa — salão e buffet',
      now: daysAgo(30),
    });
    billing.payBoleto(paid.boleto.id, { paidAt: daysAgo(26) });
  } catch (error) {
    log.warn('seed.billing_boleto_paid_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    billing.createBoleto({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      customerId: rafael.id,
      amountCents: 8_900,
      dueDate: dateFromNow(5),
      description: 'Kit presente corporativo',
      now: daysAgo(3),
    });
  } catch (error) {
    log.warn('seed.billing_boleto_open_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    billing.createBoleto({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      customerId: cafe.id,
      amountCents: 24_500,
      dueDate: dateFromNow(-4),
      description: 'Fornecimento de pães — semana 42',
      now: daysAgo(12),
    });
  } catch (error) {
    log.warn('seed.billing_boleto_overdue_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    billing.createLink({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      kind: 'PIX',
      amountCents: 12_990,
      description: 'Cesta de café da manhã',
      customerId: mariana.id,
      expiresInSeconds: 604_800,
    });
    billing.createLink({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      kind: 'BOLETO',
      amountCents: 15_990,
      dueDate: dateFromNow(10),
      description: 'Kit corporativo de fim de ano',
      customerId: rafael.id,
    });
    const paidLink = billing.createLink({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      kind: 'PIX',
      amountCents: 4_990,
      description: 'Café especial 1kg',
      customerId: padaria.id,
      expiresInSeconds: 604_800,
    });
    billing.payLink(paidLink.link.code);
  } catch (error) {
    log.warn('seed.billing_links_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    const subscription = subscriptions.create({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      customerId: mariana.id,
      description: 'Clube do café — 1kg por mês',
      amountCents: 6_900,
      period: 'MONTHLY',
      method: 'PIX',
      startDate: dateFromNow(0),
    });
    const invoice = subscription.invoices?.find((item) => item.status === 'OPEN');
    if (invoice) subscriptions.payInvoice(DEMO_MERCHANT_ID, invoice.id);
  } catch (error) {
    log.warn('seed.billing_subscription_pix_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    subscriptions.create({
      merchantId: DEMO_MERCHANT_ID,
      terminalId: DEMO_TERMINAL_ID,
      customerId: cafe.id,
      description: 'Assinatura corporativa de pães',
      amountCents: 34_900,
      period: 'MONTHLY',
      method: 'BOLETO',
      startDate: dateFromNow(0),
    });
  } catch (error) {
    log.warn('seed.billing_subscription_boleto_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  billing.refreshOverdue();
  log.info('seed.billing', { customers: 4, boletos: 3, links: 3, subscriptions: 2 });
}

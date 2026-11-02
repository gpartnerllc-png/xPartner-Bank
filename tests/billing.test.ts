import assert from 'node:assert/strict';
import test from 'node:test';
import { testConfig, testDb } from './helpers.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { PixService } from '../src/modules/pix.ts';
import { CustomerService } from '../src/modules/customers.ts';
import { BillingService } from '../src/modules/billing.ts';
import { SubscriptionService, advancePeriod } from '../src/modules/subscriptions.ts';
import { SettlementWorker } from '../src/modules/settlement-worker.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from '../src/modules/seed.ts';
import {
  assertDocument,
  documentKind,
  formatDocument,
  isValidCNPJ,
  isValidCPF,
  maskDocument,
} from '../src/domain/documents.ts';
import {
  buildBarcode,
  buildFreeField,
  dueDateFactor,
  factorToDate,
  formatDigitableLine,
  isBarcode,
  isDigitableLine,
  parseBoleto,
  toBarcode,
} from '../src/domain/boleto.ts';
import type { AppError } from '../src/kernel/errors.ts';

const merchantId = DEMO_MERCHANT_ID;
const now = Date.UTC(2026, 9, 31, 12, 0, 0);

function services() {
  const db = testDb();
  const config = testConfig();
  const transactions = new TransactionService(db, config);
  const pix = new PixService(db, config, transactions);
  const customers = new CustomerService(db);
  const billing = new BillingService(db, transactions, pix, customers);
  const subscriptions = new SubscriptionService(db, billing, pix, customers);
  const settlements = new SettlementWorker(db, config);
  return { db, config, transactions, pix, customers, billing, subscriptions, settlements };
}

function expectCode(code: string) {
  return (error: unknown) => (error as AppError).code === code;
}

test('documentos: CPF/CNPJ válidos, máscaras e normalização', () => {
  assert.equal(isValidCPF('529.982.247-25'), true);
  assert.equal(isValidCPF('52998224724'), false);
  assert.equal(isValidCPF('111.111.111-11'), false);
  assert.equal(isValidCNPJ('11.222.333/0001-81'), true);
  assert.equal(isValidCNPJ('11.222.333/0001-82'), false);
  assert.equal(isValidCNPJ('11.222.333/0001-81'.replace(/\D/g, '')), true);
  assert.equal(documentKind('52998224725'), 'PF');
  assert.equal(documentKind('11222333000181'), 'PJ');
  assert.equal(documentKind('123'), null);
  assert.equal(formatDocument('52998224725'), '529.982.247-25');
  assert.equal(formatDocument('11222333000181'), '11.222.333/0001-81');
  assert.equal(maskDocument('52998224725'), '529.***.***-25');
  assert.equal(maskDocument('11222333000181'), '11.***.***/****-81');
  assert.deepEqual(assertDocument('529.982.247-25'), { document: '52998224725', kind: 'PF' });
  assert.throws(() => assertDocument('52998224724'), expectCode('INVALID_DOCUMENT'));
});

test('boleto: código de barras, linha digitável e fator de vencimento são consistentes', () => {
  assert.equal(factorToDate(dueDateFactor('2026-11-15')), '2026-11-15');
  assert.equal(factorToDate(1000), '2025-02-22');
  assert.throws(() => dueDateFactor('2024-01-10'), expectCode('INVALID_DUE_DATE'));

  const freeField = buildFreeField(987, 123);
  assert.equal(freeField.length, 25);
  assert.ok(freeField.startsWith('077'));

  const parts = buildBarcode({ freeField, dueDate: '2026-11-15', amountCents: 129_900 });
  assert.equal(parts.barcode.length, 44);
  assert.equal(parts.digitableLine.length, 47);
  assert.equal(isBarcode(parts.barcode), true);
  assert.equal(isDigitableLine(parts.digitableLine), true);
  assert.equal(toBarcode(parts.digitableLine), parts.barcode);

  const parsed = parseBoleto(formatDigitableLine(parts.digitableLine));
  assert.equal(parsed.barcode, parts.barcode);
  assert.equal(parsed.bankCode, '077');
  assert.equal(parsed.currencyCode, '9');
  assert.equal(parsed.amountCents, 129_900);
  assert.equal(parsed.dueDate, '2026-11-15');
  assert.equal(parsed.freeField, freeField);

  const tampered = parts.barcode.slice(0, 20) + ((Number(parts.barcode[20]) + 1) % 10) + parts.barcode.slice(21);
  assert.equal(isBarcode(tampered), false);
});

test('cobranças: cliente, boleto, link Pix, link boleto e assinaturas fecham o ciclo contábil', () => {
  const { db, customers, billing, subscriptions, pix, settlements: settlementWorker } = services();

  const customer = customers.create({
    merchantId,
    name: 'Mariana Alves',
    document: '529.982.247-25',
    email: 'mariana@example.com',
    phone: '11987654321',
    city: 'São Paulo',
    uf: 'SP',
    now,
  });
  assert.equal(customer.kind, 'PF');
  assert.equal(customer.documentMasked, '529.***.***-25');
  assert.throws(
    () => customers.create({ merchantId, name: 'Duplicada', document: '52998224725', now }),
    expectCode('CUSTOMER_EXISTS'),
  );

  const updated = customers.update(merchantId, customer.id, { city: 'Campinas', status: 'ACTIVE' });
  assert.equal(updated.city, 'Campinas');

  const boleto = billing.createBoleto({
    merchantId,
    amountCents: 129_900,
    dueDate: '2026-11-15',
    description: 'Cesta de café da manhã',
    customerId: customer.id,
    now,
  });
  assert.equal(boleto.boleto.status, 'OPEN');
  assert.equal(boleto.boleto.customerId, customer.id);
  assert.equal(boleto.boleto.digitableLine.length, 47);
  assert.equal(boleto.boleto.payerDocumentMasked, '529.***.***-25');
  assert.equal(boleto.transaction.source, 'BOLETO');

  const byLine = billing.findBoleto(merchantId, boleto.boleto.digitableLineFormatted);
  assert.equal(byLine.id, boleto.boleto.id);

  const paid = billing.payBoleto(boleto.boleto.digitableLine, { paidAt: now });
  assert.equal(paid.boleto.status, 'PAID');
  assert.equal(paid.transaction.status, 'APPROVED');

  const settlement = db
    .prepare('SELECT status, scheduled_at FROM settlements WHERE transaction_id = ?')
    .get(boleto.boleto.transactionId) as { status: string; scheduled_at: string };
  assert.equal(settlement.status, 'PENDING');
  assert.equal(settlement.scheduled_at, '2026-11-01T12:00:00.000Z');

  const repaid = billing.payBoleto(boleto.boleto.id, { paidAt: now + 60_000 });
  assert.equal(repaid.boleto.status, 'PAID');
  const settlementCount = db
    .prepare('SELECT COUNT(*) AS count FROM settlements WHERE transaction_id = ?')
    .get(boleto.boleto.transactionId) as { count: number };
  assert.equal(settlementCount.count, 1);

  const pixLink = billing.createLink({
    merchantId,
    kind: 'PIX',
    amountCents: 4_990,
    description: 'Café especial 1kg',
    customerId: customer.id,
    expiresInSeconds: 30 * 86_400,
    now,
  });
  assert.equal(pixLink.link.status, 'ACTIVE');
  assert.equal(pixLink.link.path, `/pay/${pixLink.link.code}`);
  const pixInfo = (pixLink as { pix?: { txid: string; emvPayload: string } }).pix;
  assert.ok(pixInfo);
  assert.match(pixInfo.emvPayload, /^000201/);

  const pixPaid = billing.payLink(pixLink.link.code, { paidAt: now });
  assert.equal(pixPaid.link.status, 'PAID');
  const charge = pix.getCharge(pixInfo.txid);
  assert.equal(charge.charge.status, 'PAID');

  const canceled = billing.createLink({
    merchantId,
    kind: 'PIX',
    amountCents: 1_500,
    description: 'Cancelado',
    now,
  });
  billing.cancelLink(merchantId, canceled.link.code);
  assert.throws(() => billing.payLink(canceled.link.code), expectCode('LINK_CLOSED'));

  const boletoLink = billing.createLink({
    merchantId,
    kind: 'BOLETO',
    amountCents: 15_990,
    dueDate: '2026-11-20',
    description: 'Kit corporativo',
    customerId: customer.id,
    now,
  });
  assert.equal(boletoLink.link.kind, 'BOLETO');
  assert.ok((boletoLink as { boleto?: unknown }).boleto);
  const boletoLinkPaid = billing.payLink(boletoLink.link.code, { paidAt: now }) as {
    link: { status: string };
    boleto?: { status: string };
  };
  assert.equal(boletoLinkPaid.link.status, 'PAID');
  assert.equal(boletoLinkPaid.boleto?.status, 'PAID');

  const subscription = subscriptions.create({
    merchantId,
    terminalId: DEMO_TERMINAL_ID,
    customerId: customer.id,
    description: 'Clube do café — 1kg por mês',
    amountCents: 6_900,
    period: 'MONTHLY',
    method: 'PIX',
    startDate: '2026-11-01',
    now,
  });
  assert.equal(subscription.status, 'ACTIVE');
  assert.equal(subscription.nextDueDate, '2026-12-01');
  assert.equal(subscription.invoices?.length, 1);
  const firstInvoice = subscription.invoices![0];
  assert.equal(firstInvoice.status, 'OPEN');

  const paidInvoice = subscriptions.payInvoice(merchantId, firstInvoice.id, { paidAt: now });
  assert.equal(paidInvoice.status, 'PAID');
  assert.ok(paidInvoice.transactionId);
  assert.throws(
    () => subscriptions.renewInvoice(merchantId, firstInvoice.id, now),
    expectCode('INVOICE_PAID'),
  );

  const pixSubscription = subscriptions.create({
    merchantId,
    terminalId: DEMO_TERMINAL_ID,
    customerId: customer.id,
    description: 'Clube do café — plano anual',
    amountCents: 79_900,
    period: 'YEARLY',
    method: 'PIX',
    startDate: '2026-12-01',
    now,
  });
  const openInvoice = pixSubscription.invoices![0] as { id: string; pix?: { txid: string } };
  const renewed = subscriptions.renewInvoice(merchantId, openInvoice.id, now + 1_000) as {
    status: string;
    pix?: { txid: string };
  };
  assert.equal(renewed.status, 'OPEN');
  assert.notEqual(renewed.pix?.txid, openInvoice.pix?.txid);

  const boletoSubscription = subscriptions.create({
    merchantId,
    terminalId: DEMO_TERMINAL_ID,
    customerId: customer.id,
    description: 'Assinatura corporativa de pães',
    amountCents: 34_900,
    period: 'MONTHLY',
    method: 'BOLETO',
    startDate: '2026-09-01',
    now,
  });
  const secondInvoice = boletoSubscription.invoices![0];
  assert.equal(boletoSubscription.nextDueDate, '2026-10-01');
  const generated = subscriptions.runDue(now);
  assert.equal(generated, 1);
  const afterDue = subscriptions.get(merchantId, boletoSubscription.id);
  assert.equal(afterDue.invoices?.length, 2);
  assert.equal(afterDue.nextDueDate, '2026-11-01');

  const boletoInvoicePaid = subscriptions.payInvoice(merchantId, secondInvoice.id, { paidAt: now });
  assert.equal(boletoInvoicePaid.status, 'PAID');
  assert.equal(boletoInvoicePaid.transactionId !== null, true);

  subscriptions.setStatus(merchantId, boletoSubscription.id, 'PAUSED');
  assert.equal(subscriptions.get(merchantId, boletoSubscription.id).status, 'PAUSED');

  const settled = settlementWorker.settleDue(now + 12 * 3_600_000);
  assert.ok(settled >= 1, 'liquidações do dia devem ser baixadas');

  const overview = billing.overview(merchantId);
  assert.ok(overview.boletos.total >= 3);
  assert.ok(overview.boletos.paid >= 2);
  assert.ok(overview.links.active >= 0);
  assert.equal(overview.customers.total, 1);
  assert.ok(overview.subscriptions.mrrCents > 0);

  const statement = billing.statement(merchantId, { from: '2026-10-01', to: '2026-11-30' });
  assert.ok(statement.entries.length > 0);
  assert.ok(statement.summary.availableCents > 0);
  assert.ok(statement.summary.receivableCents > 0);
  assert.ok(statement.entries.every((entry) => Number.isInteger(entry.signedCents)));

  const csv = billing.statementCsv(merchantId, { from: '2026-10-01', to: '2026-11-30' });
  assert.ok(csv.startsWith('\uFEFF"data";"descricao";"tipo";"direcao";"valor";"transacao"'));
  assert.ok(csv.includes('\r\n'));

  const balance = db
    .prepare("SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE -amount_cents END), 0) AS net FROM ledger_entries")
    .get() as { net: number };
  assert.equal(balance.net, 0, 'lançamentos devem fechar em partidas dobradas');

  const settlements = billing.listSettlements(merchantId, { limit: 20 });
  assert.ok(settlements.length >= 4);
  assert.ok(settlements.some((row) => row.source === 'SUBSCRIPTION'));
  assert.ok(settlements.some((row) => row.source === 'LINK'));
});

test('assinaturas: avanço de período respeita fim de mês e ano bissexto', () => {
  assert.equal(advancePeriod('2026-01-31', 'MONTHLY'), '2026-02-28');
  assert.equal(advancePeriod('2024-01-31', 'MONTHLY'), '2024-02-29');
  assert.equal(advancePeriod('2026-11-30', 'QUARTERLY'), '2027-02-28');
  assert.equal(advancePeriod('2026-01-05', 'WEEKLY'), '2026-01-12');
  assert.equal(advancePeriod('2026-02-28', 'YEARLY'), '2027-02-28');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { testConfig, testDb } from './helpers.ts';
import { TransactionService } from '../src/modules/transactions.ts';
import { PixService } from '../src/modules/pix.ts';
import { CustomerService } from '../src/modules/customers.ts';
import { BillingService } from '../src/modules/billing.ts';
import { OpenFinanceService } from '../src/modules/openfinance.ts';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';
import { postGroup } from '../src/domain/ledger.ts';
import type { Db } from '../src/kernel/db.ts';
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
  const openfinance = new OpenFinanceService(db, billing, customers);
  return { db, config, transactions, pix, customers, billing, openfinance };
}

function fund(db: Db, amountCents: number, timestamp: number): void {
  postGroup(db, {
    groupId: `fund_test_${timestamp}`,
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

function expectCode(code: string) {
  return (error: unknown) => (error as AppError).code === code;
}

function consentInput(kind: 'DATA_SHARING' | 'EXTERNAL_DEBIT' | 'PAYMENT_INITIATION') {
  return {
    merchantId,
    provider: 'Banco do Brasil S.A.',
    providerCode: 'BB',
    kind,
    account: {
      type: 'CHECKING' as const,
      branch: '1234',
      number: '56789012',
      holderName: 'Mariana Costa',
      holderDocument: '52998224725',
      balanceCents: 250_000,
    },
    expiresInDays: 90,
  };
}

test('open finance: ciclo de consentimento com conta vinculada mascarada', () => {
  const { db, openfinance } = services();

  const created = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now });
  assert.equal(created.status, 'AWAITING_AUTHORISATION');
  assert.equal(created.account?.status, 'PENDING');
  assert.equal(created.account?.numberMasked, '1234/****9012');
  assert.equal(created.account?.holderDocumentMasked, '529.***.***-25');
  assert.deepEqual(created.scopes, ['accounts:read', 'payments:debit']);

  const authorised = openfinance.authorize(merchantId, created.id, { now, balanceCents: 310_000 });
  assert.equal(authorised.status, 'AUTHORISED');
  assert.equal(authorised.account?.status, 'ACTIVE');
  assert.equal(authorised.account?.balanceCents, 310_000);
  assert.ok(authorised.authorisedAt);

  const again = openfinance.authorize(merchantId, created.id, { now: now + 1_000 });
  assert.equal(again.status, 'AUTHORISED');

  const rejectedConsent = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now });
  const rejected = openfinance.reject(merchantId, rejectedConsent.id, 'Titular não autorizou', now + 1_000);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.account?.status, 'REVOKED');
  assert.equal(rejected.rejectionReason, 'Titular não autorizou');

  const revoked = openfinance.revoke(merchantId, created.id, 'Pedido do titular', now + 2_000);
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(revoked.account?.status, 'REVOKED');

  const auditRows = db.prepare('SELECT action FROM audit_log WHERE resource IN (?, ?)').all(created.id, rejectedConsent.id) as Array<{
    action: string;
  }>;
  assert.ok(auditRows.some((row) => row.action === 'CONSENT_AUTHORISED'));
  assert.ok(auditRows.some((row) => row.action === 'CONSENT_REVOKED'));
});

test('open finance: consentimento expirado bloqueia operações', () => {
  const { db, openfinance } = services();
  const created = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now, expiresInDays: 1 });

  assert.throws(() => openfinance.authorize(merchantId, created.id, { now: now + 3 * 86_400_000 }), expectCode('CONSENT_EXPIRED'));
  const row = db.prepare('SELECT status FROM of_consents WHERE id = ?').get(created.id) as { status: string };
  assert.equal(row.status, 'EXPIRED');

  const overview = openfinance.overview(merchantId, now + 4 * 86_400_000);
  assert.equal(overview.kpis.activeConsents, 0);

  const soon = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now, expiresInDays: 1 });
  openfinance.authorize(merchantId, soon.id, { now });
  const afterExpiry = openfinance.overview(merchantId, now + 2 * 86_400_000);
  assert.equal(afterExpiry.consents.find((row) => row.id === soon.id)?.status, 'EXPIRED');
  assert.equal(afterExpiry.kpis.activeConsents, 0);
});

test('open finance: escopo do consentimento é exigido por operação', () => {
  const { openfinance } = services();
  const debitConsent = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now });
  openfinance.authorize(merchantId, debitConsent.id, { now });
  const paymentConsent = openfinance.createConsent({ ...consentInput('PAYMENT_INITIATION'), now });
  openfinance.authorize(merchantId, paymentConsent.id, { now });
  const sharingConsent = openfinance.createConsent({ ...consentInput('DATA_SHARING'), now });
  openfinance.authorize(merchantId, sharingConsent.id, { now });

  assert.throws(
    () =>
      openfinance.createDebit({
        merchantId,
        consentId: paymentConsent.id,
        amountCents: 10_000,
        now,
      }),
    expectCode('CONSENT_SCOPE_MISMATCH'),
  );

  assert.throws(
    () =>
      openfinance.createPayment({
        merchantId,
        consentId: debitConsent.id,
        amountCents: 10_000,
        pixKey: 'fornecedor@exemplo.com.br',
        now,
      }),
    expectCode('CONSENT_SCOPE_MISMATCH'),
  );

  assert.throws(
    () =>
      openfinance.createPayment({
        merchantId,
        consentId: sharingConsent.id,
        amountCents: 10_000,
        pixKey: 'fornecedor@exemplo.com.br',
        now,
      }),
    expectCode('CONSENT_SCOPE_MISMATCH'),
  );
});

test('open finance: débito externo liquida recebível pelo pipeline fiscal', () => {
  const { db, billing, openfinance } = services();
  const consent = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now });
  openfinance.authorize(merchantId, consent.id, { now });

  const debit = openfinance.createDebit({
    merchantId,
    consentId: consent.id,
    amountCents: 18_990,
    description: 'Mensalidade do buffet',
    dueDate: '2026-11-05',
    now,
  });
  assert.equal(debit.status, 'SCHEDULED');
  assert.equal(debit.amountFormatted.replace(/\u00a0/g, ' '), 'R$ 189,90');

  const settled = openfinance.settleDebit(merchantId, debit.id, now + 60_000);
  assert.equal(settled.status, 'SETTLED');
  assert.ok(settled.transactionId);

  const txn = db
    .prepare('SELECT status, source, method FROM transactions WHERE id = ?')
    .get(settled.transactionId) as { status: string; source: string; method: string };
  assert.equal(txn.status, 'APPROVED');
  assert.equal(txn.source, 'OPEN_FINANCE');
  assert.equal(txn.method, 'PIX');

  const settlement = db
    .prepare('SELECT status, scheduled_at FROM settlements WHERE transaction_id = ?')
    .get(settled.transactionId) as { status: string; scheduled_at: string };
  assert.equal(settlement.status, 'PENDING');
  const listed = billing.listSettlements(merchantId, { limit: 10 }).find(
    (row) => row.transactionId === settled.transactionId,
  );
  assert.equal(listed?.source, 'OPEN_FINANCE');

  const repeated = openfinance.settleDebit(merchantId, debit.id, now + 120_000);
  assert.equal(repeated.status, 'SETTLED');
  const count = db
    .prepare('SELECT COUNT(*) AS count FROM settlements WHERE transaction_id = ?')
    .get(settled.transactionId) as { count: number };
  assert.equal(count.count, 1, 'liquidação deve ser idempotente');

  const scheduled = openfinance.createDebit({
    merchantId,
    consentId: consent.id,
    amountCents: 5_000,
    dueDate: '2026-11-10',
    now,
  });
  const canceled = openfinance.cancelDebit(merchantId, scheduled.id, now + 120_000);
  assert.equal(canceled.status, 'CANCELED');
  assert.throws(() => openfinance.settleDebit(merchantId, scheduled.id, now + 180_000), expectCode('DEBIT_CLOSED'));
});

test('open finance: iniciação de pagamento debita disponível com tarifa e partidas dobradas', () => {
  const { db, openfinance } = services();
  fund(db, 100_000, now);
  const consent = openfinance.createConsent({ ...consentInput('PAYMENT_INITIATION'), now });
  openfinance.authorize(merchantId, consent.id, { now });

  const payment = openfinance.createPayment({
    merchantId,
    consentId: consent.id,
    amountCents: 20_000,
    pixKey: 'fornecedor@exemplo.com.br',
    description: 'Compra de insumos',
    now,
  });
  assert.equal(payment.status, 'PENDING');
  assert.equal(payment.feeCents, 100);
  assert.equal(payment.totalCents, 20_100);

  const settled = openfinance.settlePayment(merchantId, payment.id, now + 60_000);
  assert.equal(settled.status, 'SETTLED');
  assert.match(settled.endToEndId ?? '', /^E\d+/);

  const balances = db
    .prepare(
      `SELECT a.kind, COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS net
         FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.owner_id IN (?, 'platform') GROUP BY a.kind`,
    )
    .all(merchantId) as Array<{ kind: string; net: number }>;
  const byKind = new Map(balances.map((row) => [row.kind, row.net]));
  assert.equal(byKind.get('MERCHANT_AVAILABLE'), 79_900);
  assert.equal(byKind.get('OPEN_FINANCE_CLEARING'), 20_000);
  assert.equal(byKind.get('FEE_REVENUE'), 100);
  assert.equal(byKind.get('CASH'), -100_000);

  const trial = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents END), 0) AS debit,
              COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents END), 0) AS credit
         FROM ledger_entries`,
    )
    .get() as { debit: number; credit: number };
  assert.equal(trial.debit, trial.credit);

  const pending = openfinance.createPayment({
    merchantId,
    consentId: consent.id,
    amountCents: 90_000,
    pixKey: 'outro@exemplo.com.br',
    now,
  });
  assert.throws(() => openfinance.settlePayment(merchantId, pending.id, now + 90_000), expectCode('INSUFFICIENT_FUNDS'));
  const canceled = openfinance.cancelPayment(merchantId, pending.id);
  assert.equal(canceled.status, 'CANCELED');
});

test('open finance: overview consolida KPIs e listas', () => {
  const { db, openfinance } = services();
  const consent = openfinance.createConsent({ ...consentInput('EXTERNAL_DEBIT'), now });
  openfinance.authorize(merchantId, consent.id, { now });
  const debit = openfinance.createDebit({ merchantId, consentId: consent.id, amountCents: 7_500, now });
  openfinance.settleDebit(merchantId, debit.id, now);
  openfinance.createDebit({ merchantId, consentId: consent.id, amountCents: 2_500, now });

  const overview = openfinance.overview(merchantId, now + 1_000);
  assert.equal(overview.kpis.activeConsents, 1);
  assert.equal(overview.kpis.activeAccounts, 1);
  assert.equal(overview.kpis.monthDebitsCents, 7_500);
  assert.equal(overview.kpis.scheduledDebitsCents, 2_500);
  assert.equal(overview.consents.length, 1);
  assert.equal(overview.accounts.length, 1);
  assert.equal(overview.debits.length, 2);
  assert.equal(overview.payments.length, 0);

  const rows = db.prepare('SELECT id FROM of_accounts WHERE merchant_id = ?').all(merchantId) as Array<{ id: string }>;
  assert.equal(rows.length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestServer } from './test-server.ts';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test('api de open finance e investimentos: consentimento, débito, pagamento, aporte e resgate', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const consentResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/open-finance/consents',
      headers: auth,
      payload: {
        provider: 'Banco do Brasil S.A.',
        providerCode: 'BB',
        kind: 'EXTERNAL_DEBIT',
        account: {
          type: 'CHECKING',
          branch: '1234',
          number: '56789012',
          holderName: 'Mariana Costa',
          holderDocument: '529.982.247-25',
          balanceCents: 250_000,
        },
        expiresInDays: 60,
      },
    });
    assert.equal(consentResponse.statusCode, 201);
    const consent = (consentResponse.json() as { consent: { id: string; status: string } }).consent;
    assert.equal(consent.status, 'AWAITING_AUTHORISATION');

    const authorizeResponse = await ctx.app.inject({
      method: 'POST',
      url: `/v1/open-finance/consents/${consent.id}/authorize`,
      headers: auth,
    });
    assert.equal(authorizeResponse.statusCode, 200);
    const authorised = (
      authorizeResponse.json() as { consent: { status: string; account: { status: string; numberMasked: string } } }
    ).consent;
    assert.equal(authorised.status, 'AUTHORISED');
    assert.equal(authorised.account.status, 'ACTIVE');
    assert.equal(authorised.account.numberMasked, '1234/****9012');

    const debitResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/open-finance/debits',
      headers: auth,
      payload: { consentId: consent.id, amountCents: 9_900, description: 'Mensalidade', dueDate: isoDaysFromNow(3) },
    });
    assert.equal(debitResponse.statusCode, 201);
    const debit = (debitResponse.json() as { debit: { id: string; status: string } }).debit;
    assert.equal(debit.status, 'SCHEDULED');

    const settleDebit = await ctx.app.inject({
      method: 'POST',
      url: `/v1/open-finance/debits/${debit.id}/settle`,
      headers: auth,
    });
    assert.equal(settleDebit.statusCode, 200);
    const settledDebit = (settleDebit.json() as { status: string; transactionId: string }).status;
    assert.equal(settledDebit, 'SETTLED');

    const linkResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: auth,
      payload: { amountCents: 100_000, kind: 'PIX', description: 'Aporte de caixa' },
    });
    assert.equal(linkResponse.statusCode, 201);
    const linkCode = (linkResponse.json() as { link: { code: string } }).link.code;
    const paidLink = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payment-links/${linkCode}/pay`,
      headers: auth,
    });
    assert.equal(paidLink.statusCode, 200);
    ctx.settlements.settleDue(Date.now() + 12 * 3_600_000);

    const paymentConsent = await ctx.app.inject({
      method: 'POST',
      url: '/v1/open-finance/consents',
      headers: auth,
      payload: {
        provider: 'Itaú Unibanco S.A.',
        providerCode: 'ITAU',
        kind: 'PAYMENT_INITIATION',
        account: {
          type: 'PAYMENT',
          branch: '0001',
          number: '34891207',
          holderName: 'Café & Cia Comércio Ltda',
          holderDocument: '11.222.333/0001-81',
        },
      },
    });
    assert.equal(paymentConsent.statusCode, 201);
    const paymentConsentId = (paymentConsent.json() as { consent: { id: string } }).consent.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/open-finance/consents/${paymentConsentId}/authorize`,
      headers: auth,
    });

    const paymentResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/open-finance/payments',
      headers: auth,
      payload: {
        consentId: paymentConsentId,
        amountCents: 25_000,
        pixKey: 'fornecedor@exemplo.com.br',
        description: 'Compra de insumos',
      },
    });
    assert.equal(paymentResponse.statusCode, 201);
    const payment = (paymentResponse.json() as { payment: { id: string; feeCents: number; status: string } }).payment;
    assert.equal(payment.feeCents, 125);
    assert.equal(payment.status, 'PENDING');

    const settledPayment = await ctx.app.inject({
      method: 'POST',
      url: `/v1/open-finance/payments/${payment.id}/settle`,
      headers: auth,
    });
    assert.equal(settledPayment.statusCode, 200);
    const paymentBody = (settledPayment.json() as { payment: { status: string; endToEndId: string } }).payment;
    assert.equal(paymentBody.status, 'SETTLED');
    assert.match(paymentBody.endToEndId, /^E\d+/);

    const usageError = await ctx.app.inject({
      method: 'POST',
      url: '/v1/open-finance/debits',
      headers: auth,
      payload: { consentId: paymentConsentId, amountCents: 1_000 },
    });
    assert.equal(usageError.statusCode, 409);
    assert.equal((usageError.json() as { error: { code: string } }).error.code, 'CONSENT_SCOPE_MISMATCH');

    const product = ctx.investments.createProduct({
      name: 'CDB xPartner Liquidez Diária',
      kind: 'CDB',
      issuer: 'xPartner Bank',
      indexer: 'CDI',
      rateBps: 10_200,
      liquidity: 'D0',
      minCents: 5_000,
    });
    const products = await ctx.app.inject({ method: 'GET', url: '/v1/investments/products', headers: auth });
    assert.equal(products.statusCode, 200);
    assert.equal((products.json() as { data: unknown[] }).data.length, 1);

    const contribution = await ctx.app.inject({
      method: 'POST',
      url: '/v1/investments/contributions',
      headers: auth,
      payload: { productId: product.id, amountCents: 30_000 },
    });
    assert.equal(contribution.statusCode, 201);
    const position = (
      contribution.json() as { position: { id: string; principalCents: number }; availableCents: number }
    ).position;
    assert.equal(position.principalCents, 30_000);

    const provento = await ctx.app.inject({
      method: 'POST',
      url: '/v1/investments/proventos',
      headers: auth,
      payload: {
        positionId: position.id,
        kind: 'JCP',
        grossCents: 1_000,
        exDate: isoDaysFromNow(-1),
        paymentDate: isoDaysFromNow(0),
      },
    });
    assert.equal(provento.statusCode, 201);
    assert.equal((provento.json() as { provento: { taxCents: number } }).provento.taxCents, 150);

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/investments/overview', headers: auth });
    assert.equal(overview.statusCode, 200);
    const overviewBody = overview.json() as {
      kpis: { investedCents: number; proventosCents: number; taxCents: number };
      positions: unknown[];
      proventos: Array<{ status: string }>;
    };
    assert.equal(overviewBody.kpis.investedCents, 30_000);
    assert.equal(overviewBody.kpis.proventosCents, 850);
    assert.equal(overviewBody.kpis.taxCents, 150);
    assert.equal(overviewBody.proventos[0].status, 'PAID');

    const redemption = await ctx.app.inject({
      method: 'POST',
      url: '/v1/investments/redemptions',
      headers: auth,
      payload: { positionId: position.id, amountCents: 30_000 },
    });
    assert.equal(redemption.statusCode, 200);
    assert.equal((redemption.json() as { position: { status: string } }).position.status, 'REDEEMED');

    const openFinanceOverview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/open-finance/overview',
      headers: auth,
    });
    assert.equal(openFinanceOverview.statusCode, 200);
    const ofBody = openFinanceOverview.json() as {
      kpis: { activeConsents: number; monthPaymentsCents: number; scheduledDebitsCents: number };
      consents: unknown[];
      payments: Array<{ status: string }>;
    };
    assert.equal(ofBody.kpis.activeConsents, 2);
    assert.equal(ofBody.kpis.monthPaymentsCents, 25_000);
    assert.equal(ofBody.kpis.scheduledDebitsCents, 0);
    assert.equal(ofBody.payments[0].status, 'SETTLED');

    const appOverview = await ctx.app.inject({ method: 'GET', url: '/v1/app/overview', headers: auth });
    assert.equal(appOverview.statusCode, 200);
    const appBody = appOverview.json() as { openFinance: { accounts: unknown[] }; investments: { products: unknown[] } };
    assert.equal(appBody.openFinance.accounts.length, 2);
    assert.equal(appBody.investments.products.length, 1);

    const unauthenticated = await ctx.app.inject({ method: 'GET', url: '/v1/open-finance/overview' });
    assert.equal(unauthenticated.statusCode, 401);

    assert.equal(ctx.db.prepare('SELECT merchant_id FROM of_consents LIMIT 1').get()?.merchant_id, DEMO_MERCHANT_ID);
  } finally {
    await ctx.app.close();
    ctx.db.close();
  }
});

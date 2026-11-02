import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { formatBRL } from '../src/kernel/money.ts';
import { buildTestServer } from './test-server.ts';

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test('api de cobranças: aplicativo, boleto, checkout público, assinatura, extrato e NFC-e', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const appPage = await ctx.app.inject({ method: 'GET', url: '/app' });
    assert.equal(appPage.statusCode, 200);
    assert.match(appPage.body, /Visão geral da conta/);
    assert.match(appPage.body, /Cobranças/);

    const checkoutPage = await ctx.app.inject({ method: 'GET', url: '/pay/ABC1234567' });
    assert.equal(checkoutPage.statusCode, 200);
    assert.match(checkoutPage.body, /Checkout/);

    const createdCustomer = await ctx.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: auth,
      payload: {
        name: 'Mariana Alves',
        document: '529.982.247-25',
        email: 'mariana@example.com',
        phone: '11987654321',
        city: 'São Paulo',
        uf: 'SP',
      },
    });
    assert.equal(createdCustomer.statusCode, 201);
    const customer = (createdCustomer.json() as { customer: { id: string; documentMasked: string; kind: string } }).customer;
    assert.equal(customer.kind, 'PF');
    assert.equal(customer.documentMasked, '529.***.***-25');

    const invalidCustomer = await ctx.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: auth,
      payload: { name: 'Inválido', document: '11111111111' },
    });
    assert.equal(invalidCustomer.statusCode, 422);

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: auth,
      payload: { name: 'Duplicada', document: '52998224725' },
    });
    assert.equal(duplicate.statusCode, 409);

    const createdBoleto = await ctx.app.inject({
      method: 'POST',
      url: '/v1/boletos',
      headers: auth,
      payload: {
        amountCents: 129_900,
        dueDate: isoDaysFromNow(7),
        description: 'Cesta de café da manhã',
        customerId: customer.id,
      },
    });
    assert.equal(createdBoleto.statusCode, 201);
    const boleto = (
      createdBoleto.json() as {
        boleto: {
          id: string;
          transactionId: string;
          status: string;
          digitableLine: string;
          digitableLineFormatted: string;
          barcode: string;
          amountCents: number;
          payerDocumentMasked: string;
        };
      }
    ).boleto;
    assert.equal(boleto.status, 'OPEN');
    assert.equal(boleto.amountCents, 129_900);
    assert.equal(boleto.digitableLine.length, 47);
    assert.equal(boleto.barcode.length, 44);
    assert.equal(boleto.payerDocumentMasked, '529.***.***-25');

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: `/v1/boletos/${encodeURIComponent(boleto.digitableLineFormatted)}`,
      headers: auth,
    });
    assert.equal(lookup.statusCode, 200);
    assert.equal((lookup.json() as { boleto: { id: string } }).boleto.id, boleto.id);

    const paidBoleto = await ctx.app.inject({
      method: 'POST',
      url: `/v1/boletos/${boleto.id}/pay`,
      headers: auth,
    });
    assert.equal(paidBoleto.statusCode, 200);
    const paidBody = paidBoleto.json() as { boleto: { status: string }; transaction: { status: string; source: string } };
    assert.equal(paidBody.boleto.status, 'PAID');
    assert.equal(paidBody.transaction.status, 'APPROVED');
    assert.equal(paidBody.transaction.source, 'BOLETO');

    await ctx.relay.drain();
    const fiscalRow = ctx.db
      .prepare('SELECT status, access_key FROM fiscal_documents WHERE transaction_id = ?')
      .get(boleto.transactionId) as { status: string; access_key: string } | undefined;
    assert.ok(fiscalRow, 'NFC-e do boleto deveria ter sido emitida');
    assert.equal(fiscalRow.status, 'AUTHORIZED');
    assert.equal(fiscalRow.access_key.length, 44);

    const openList = await ctx.app.inject({ method: 'GET', url: '/v1/boletos?status=OPEN', headers: auth });
    assert.equal(openList.statusCode, 200);
    assert.equal((openList.json() as { data: unknown[] }).data.length, 0);

    const appOverview = await ctx.app.inject({ method: 'GET', url: '/v1/app/overview', headers: auth });
    assert.equal(appOverview.statusCode, 200);
    const overview = appOverview.json() as {
      overview: { balances: { availableCents: number; receivableCents: number }; today: { sales: number } };
      billing: { boletos: { paid: number }; customers: { total: number } };
      statement: { entries: unknown[] };
      boletos: Array<{ id: string; status: string }>;
    };
    assert.equal(overview.billing.boletos.paid, 1);
    assert.equal(overview.billing.customers.total, 1);
    assert.ok(overview.overview.balances.receivableCents > 0);
    assert.ok(overview.statement.entries.length > 0);
    assert.equal(overview.boletos[0].status, 'PAID');

    const statement = await ctx.app.inject({ method: 'GET', url: '/v1/statement', headers: auth });
    assert.equal(statement.statusCode, 200);
    const statementBody = statement.json() as {
      summary: { receivableCents: number; receivableFormatted: string };
      entries: Array<{ signedCents: number; description: string }>;
    };
    assert.ok(statementBody.entries.some((entry) => entry.signedCents > 0));
    assert.ok(statementBody.entries.every((entry) => Number.isInteger(entry.signedCents)));

    const csv = await ctx.app.inject({ method: 'GET', url: '/v1/statement.csv', headers: auth });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.equal(String(csv.headers['content-disposition']).includes('extrato-xpartner.csv'), true);
    assert.ok(csv.body.startsWith('\uFEFF"data";"descricao"'));

    const createdLink = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: auth,
      payload: { amountCents: 4_990, kind: 'PIX', description: 'Café especial 1kg', customerId: customer.id },
    });
    assert.equal(createdLink.statusCode, 201);
    const link = (
      createdLink.json() as {
        link: { code: string; status: string; path: string };
        pix: { txid: string; emvPayload: string };
      }
    );
    assert.equal(link.link.status, 'ACTIVE');
    assert.equal(link.link.path, `/pay/${link.link.code}`);
    assert.match(link.pix.emvPayload, /^000201/);

    const publicView = await ctx.app.inject({ method: 'GET', url: `/v1/public/links/${link.link.code}` });
    assert.equal(publicView.statusCode, 200);
    const publicViewBody = publicView.json() as {
      link: { status: string; amountFormatted: string };
      pix: { emvPayload: string };
      demoMode: boolean;
    };
    assert.equal(publicViewBody.link.status, 'ACTIVE');
    assert.equal(publicViewBody.link.amountFormatted, formatBRL(4_990));
    assert.equal(publicViewBody.demoMode, true);

    const publicPay = await ctx.app.inject({ method: 'POST', url: `/v1/public/links/${link.link.code}/pay` });
    assert.equal(publicPay.statusCode, 200);
    assert.equal((publicPay.json() as { link: { status: string } }).link.status, 'PAID');

    const publicAfterPay = await ctx.app.inject({ method: 'GET', url: `/v1/public/links/${link.link.code}` });
    assert.equal((publicAfterPay.json() as { link: { status: string } }).link.status, 'PAID');

    const canceledLink = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: auth,
      payload: { amountCents: 1_500, kind: 'PIX', description: 'Será cancelado' },
    });
    const canceledCode = (canceledLink.json() as { link: { code: string } }).link.code;
    const canceled = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payment-links/${canceledCode}/cancel`,
      headers: auth,
    });
    assert.equal(canceled.statusCode, 200);
    const canceledPay = await ctx.app.inject({ method: 'POST', url: `/v1/public/links/${canceledCode}/pay` });
    assert.equal(canceledPay.statusCode, 409);

    const createdSubscription = await ctx.app.inject({
      method: 'POST',
      url: '/v1/subscriptions',
      headers: auth,
      payload: {
        customerId: customer.id,
        description: 'Clube do café — 1kg por mês',
        amountCents: 6_900,
        period: 'MONTHLY',
        method: 'BOLETO',
      },
    });
    assert.equal(createdSubscription.statusCode, 201);
    const subscription = createdSubscription.json() as {
      id: string;
      status: string;
      invoices: Array<{ id: string; status: string; method: string }>;
    };
    assert.equal(subscription.status, 'ACTIVE');
    assert.equal(subscription.invoices.length, 1);
    const invoice = subscription.invoices[0];
    assert.equal(invoice.status, 'OPEN');
    assert.equal(invoice.method, 'BOLETO');

    const invoiceList = await ctx.app.inject({ method: 'GET', url: '/v1/subscription-invoices?status=OPEN', headers: auth });
    assert.equal(invoiceList.statusCode, 200);
    assert.ok((invoiceList.json() as { data: Array<{ id: string }> }).data.some((row) => row.id === invoice.id));

    const invoiceDetail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/subscription-invoices/${invoice.id}`,
      headers: auth,
    });
    assert.equal(invoiceDetail.statusCode, 200);
    assert.ok((invoiceDetail.json() as { boleto?: unknown }).boleto);

    const paidInvoice = await ctx.app.inject({
      method: 'POST',
      url: `/v1/subscription-invoices/${invoice.id}/pay`,
      headers: auth,
    });
    assert.equal(paidInvoice.statusCode, 200);
    assert.equal((paidInvoice.json() as { status: string }).status, 'PAID');

    const paused = await ctx.app.inject({
      method: 'POST',
      url: `/v1/subscriptions/${subscription.id}/pause`,
      headers: auth,
    });
    assert.equal(paused.statusCode, 200);
    assert.equal((paused.json() as { status: string }).status, 'PAUSED');

    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/subscriptions/${subscription.id}/resume`,
      headers: auth,
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal((resumed.json() as { status: string }).status, 'ACTIVE');

    const recent = await ctx.app.inject({ method: 'GET', url: '/v1/fiscal/recent', headers: auth });
    assert.equal(recent.statusCode, 200);
    const documents = (recent.json() as { data: Array<{ transactionId: string; status: string; amountCents: number }> }).data;
    assert.ok(documents.some((document) => document.amountCents === 129_900 && document.status === 'AUTHORIZED'));

    const settlements = await ctx.app.inject({ method: 'GET', url: '/v1/settlements', headers: auth });
    assert.equal(settlements.statusCode, 200);
    assert.ok((settlements.json() as { data: Array<{ source: string }> }).data.length >= 3);

    const risk = await ctx.app.inject({ method: 'GET', url: '/v1/risk/overview', headers: auth });
    assert.equal(risk.statusCode, 200);
    assert.equal(typeof (risk.json() as { graph: { nodes: number } }).graph.nodes, 'number');

    const unauthorized = await ctx.app.inject({ method: 'GET', url: '/v1/app/overview' });
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    closeDb(ctx.db);
  }
});

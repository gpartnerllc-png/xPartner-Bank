import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';
import { issueMerchantToken } from '../src/api/security.ts';
import { buildTestServer } from './test-server.ts';

interface ErrorBody {
  error?: { code?: string; message?: string };
}

test('token de leitura e cadastro não fabrica lançamento na maquininha', async () => {
  const ctx = await buildTestServer();
  try {
    const publicToken = issueMerchantToken(ctx.config, DEMO_MERCHANT_ID, 'demo:read demo:write');
    const auth = { authorization: `Bearer ${publicToken}` };

    const sale = await ctx.app.inject({
      method: 'POST',
      url: '/v1/demo/sales',
      headers: auth,
      payload: { amountCents: 5_000, method: 'DEBIT' },
    });
    assert.equal(sale.statusCode, 403);
    assert.match((sale.json() as ErrorBody).error?.message ?? '', /demo:simulate/);

    const pix = await ctx.app.inject({
      method: 'POST',
      url: '/v1/demo/pix',
      headers: auth,
      payload: { amountCents: 5_000 },
    });
    assert.equal(pix.statusCode, 403);

    const boleto = await ctx.app.inject({
      method: 'POST',
      url: '/v1/boletos',
      headers: auth,
      payload: {
        amountCents: 7_000,
        payerName: 'Cliente sem token de operador',
        payerDocument: '52998224725',
      },
    });
    assert.equal(boleto.statusCode, 201, 'cadastro continua liberado para o token público');
    const created = boleto.json() as { boleto?: { id?: string; status?: string } };
    const reference = created.boleto?.id as string;
    assert.ok(reference);

    const pay = await ctx.app.inject({ method: 'POST', url: `/v1/boletos/${reference}/pay`, headers: auth });
    assert.equal(pay.statusCode, 403);

    const after = await ctx.app.inject({ method: 'GET', url: `/v1/boletos/${reference}`, headers: auth });
    const detail = after.json() as { boleto?: { status?: string } };
    assert.equal(detail.boleto?.status, 'OPEN', 'a tentativa anônima não baixa nada');
  } finally {
    await ctx.app.close();
  }
});

test('token do operador local autoriza a maquininha', async () => {
  const ctx = await buildTestServer();
  try {
    const bootstrap = await ctx.app.inject({ method: 'GET', url: '/v1/demo/bootstrap' });
    const body = bootstrap.json() as { token: string; scopes: string; canSimulate: boolean };
    assert.equal(body.canSimulate, true);
    assert.match(body.scopes, /demo:simulate/);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/demo/sales',
      headers: { authorization: `Bearer ${body.token}` },
      payload: { amountCents: 12_900, method: 'DEBIT', brand: 'visa', last4: '4242' },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await ctx.app.close();
  }
});

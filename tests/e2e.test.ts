import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { trialBalance } from '../src/domain/ledger.ts';
import { devTokenFor } from '../src/domain/vault.ts';
import { DEMO_MERCHANT_ID, DEMO_TERMINAL_ID } from '../src/modules/seed.ts';
import { hmacDeviceSignature } from '../src/api/security.ts';
import { buildTestServer } from './test-server.ts';

test('e2e: venda, risco, roteamento, ledger, NFC-e e antecipação', async () => {
  const ctx = await buildTestServer();
  try {
    const bootstrap = await ctx.app.inject({ method: 'GET', url: '/v1/demo/bootstrap' });
    assert.equal(bootstrap.statusCode, 200);
    const bootstrapBody = bootstrap.json() as { token: string; merchant: { id: string } };
    assert.equal(bootstrapBody.merchant.id, DEMO_MERCHANT_ID);
    assert.ok(bootstrapBody.token.startsWith('v1.'));

    interface SaleResponse {
      status: string;
      transaction: { id: string; status: string; acquirerId: string; amountCents: number };
      payment: { acquirerId: string; feeCents: number; netCents: number; settlementAt: string } | null;
      fiscal: { status: string | null };
    }

    const auth = { authorization: `Bearer ${ctx.token}` };
    let approved: SaleResponse | null = null;
    for (let attempt = 0; attempt < 6 && !approved; attempt += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/demo/sales',
        headers: auth,
        payload: {
          amountCents: 12_900 + attempt,
          method: 'CREDIT',
          installments: 2,
          brand: 'visa',
          last4: '4242',
          description: `Venda de teste ${attempt}`,
        },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as SaleResponse;
      if (body.status === 'APPROVED') approved = body;
    }
    assert.ok(approved, 'nenhuma venda foi aprovada nas tentativas determinísticas');
    assert.equal(approved.payment?.acquirerId, 'acq_stone');
    assert.ok((approved.payment?.feeCents ?? 0) > 0);
    assert.equal(approved.payment?.netCents, approved.transaction.amountCents - (approved.payment?.feeCents ?? 0));

    const saleId = approved.transaction.id;
    await ctx.relay.drain();

    const fiscalRow = ctx.db
      .prepare('SELECT status, access_key, xml FROM fiscal_documents WHERE transaction_id = ?')
      .get(saleId) as { status: string; access_key: string; xml: string } | undefined;
    assert.ok(fiscalRow, 'NFC-e deveria ter sido emitida pelo worker');
    assert.equal(fiscalRow.status, 'AUTHORIZED');
    assert.equal(fiscalRow.access_key.length, 44);
    assert.match(fiscalRow.xml, /<SignatureValue>/);

    const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 200);

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/overview', headers: auth });
    assert.equal(overview.statusCode, 200);
    const overviewBody = overview.json() as { today: { approved: number } };
    assert.ok(overviewBody.today.approved >= 1);

    const fiscalList = await ctx.app.inject({ method: 'GET', url: '/v1/fiscal/recent', headers: auth });
    assert.equal(fiscalList.statusCode, 200);
    const fiscalListBody = fiscalList.json() as { data: Array<{ transactionId: string }> };
    assert.ok(fiscalListBody.data.some((document) => document.transactionId === saleId));

    const fiscalDetail = await ctx.app.inject({ method: 'GET', url: `/v1/fiscal/${saleId}`, headers: auth });
    assert.equal(fiscalDetail.statusCode, 200);
    const fiscalDetailBody = fiscalDetail.json() as { xml: string; qrCodeUrl: string; danfeText: string };
    assert.match(fiscalDetailBody.xml, /<infNFe/);
    assert.ok(fiscalDetailBody.qrCodeUrl.includes(fiscalRow.access_key));
    assert.ok(fiscalDetailBody.danfeText.includes('Chave de acesso'));

    const offer = await ctx.app.inject({ method: 'GET', url: `/v1/settlements/${saleId}/offer`, headers: auth });
    assert.equal(offer.statusCode, 200);
    assert.equal((offer.json() as { eligible: boolean }).eligible, true);

    const advance = await ctx.app.inject({ method: 'POST', url: `/v1/settlements/${saleId}/advance`, headers: auth });
    assert.equal(advance.statusCode, 200);
    const advanceBody = advance.json() as { offer: { feeCents: number }; settlement: { status: string; mode: string } };
    assert.ok(advanceBody.offer.feeCents > 0);
    assert.equal(advanceBody.settlement.status, 'PAID');
    assert.equal(advanceBody.settlement.mode, 'ANTICIPATION');

    const trial = trialBalance(ctx.db);
    assert.equal(trial.balanced, true);
    assert.equal(trial.debitCents, trial.creditCents);

    const trialResponse = await ctx.app.inject({ method: 'GET', url: '/v1/ledger/trial', headers: auth });
    assert.equal(trialResponse.statusCode, 200);
    assert.equal((trialResponse.json() as { trial: { balanced: boolean } }).trial.balanced, true);
  } finally {
    await ctx.app.close();
    closeDb(ctx.db);
  }
});

test('e2e: Pix cria BR Code, paga, liquida D+0 e fecha o ledger', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/demo/pix',
      headers: auth,
      payload: { amountCents: 3_490, description: 'Cobrança de teste' },
    });
    assert.equal(created.statusCode, 200);
    const createdBody = created.json() as {
      charge: { txid: string; status: string; emvPayload: string };
      transaction: { id: string };
    };
    assert.equal(createdBody.charge.status, 'ACTIVE');
    assert.ok(createdBody.charge.emvPayload.startsWith('000201'));
    assert.ok(createdBody.charge.emvPayload.includes('540534.90'));

    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/v1/pix/charges/${createdBody.charge.txid}/simulate-payment`,
      headers: auth,
    });
    assert.equal(paid.statusCode, 200);
    assert.equal((paid.json() as { charge: { status: string } }).charge.status, 'PAID');

    const secondPayment = await ctx.app.inject({
      method: 'POST',
      url: `/v1/pix/charges/${createdBody.charge.txid}/simulate-payment`,
      headers: auth,
    });
    assert.equal(secondPayment.statusCode, 200, 'pagamento repetido deve ser idempotente');

    const settled = ctx.settlements.settleDue(Date.now() + 60_000);
    assert.ok(settled >= 1);

    await ctx.relay.drain();
    const fiscalRow = ctx.db
      .prepare('SELECT status FROM fiscal_documents WHERE transaction_id = ?')
      .get(createdBody.transaction.id) as { status: string } | undefined;
    assert.ok(fiscalRow, 'NFC-e do Pix deveria ter sido emitida');

    const trial = trialBalance(ctx.db);
    assert.equal(trial.balanced, true);

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/overview', headers: auth });
    assert.equal(overview.statusCode, 200);
  } finally {
    await ctx.app.close();
    closeDb(ctx.db);
  }
});

test('e2e: assinatura de dispositivo, idempotência e bloqueio de replay', async () => {
  const ctx = await buildTestServer();
  try {
    const payload = JSON.stringify({
      amountCents: 5_000,
      method: 'DEBIT',
      paymentToken: devTokenFor('master', '0000', 'cartao-bloqueado'),
      description: 'Teste de idempotência',
    });
    const timestamp = String(Date.now());
    const nonce = 'nonce-idempotencia-1';
    const signature = hmacDeviceSignature(ctx.config, DEMO_TERMINAL_ID, timestamp, nonce, payload);
    const headers = {
      'content-type': 'application/json',
      'x-device-id': DEMO_TERMINAL_ID,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
      'idempotency-key': 'idem-teste-0001',
    };

    const first = await ctx.app.inject({ method: 'POST', url: '/v1/transactions', headers, payload });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json() as { status: string; transaction: { id: string } };
    assert.equal(firstBody.status, 'DECLINED');

    const nonce2 = 'nonce-idempotencia-2';
    const signature2 = hmacDeviceSignature(ctx.config, DEMO_TERMINAL_ID, timestamp, nonce2, payload);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { ...headers, 'x-nonce': nonce2, 'x-signature': signature2 },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers['x-idempotent-replayed'], 'true');
    assert.equal((replay.json() as { transaction: { id: string } }).transaction.id, firstBody.transaction.id);

    const otherPayload = JSON.stringify({ amountCents: 5_100, method: 'DEBIT', paymentToken: devTokenFor('master', '0000', 'outro') });
    const nonce3 = 'nonce-idempotencia-3';
    const conflict = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: {
        ...headers,
        'x-nonce': nonce3,
        'x-signature': hmacDeviceSignature(ctx.config, DEMO_TERMINAL_ID, timestamp, nonce3, otherPayload),
      },
      payload: otherPayload,
    });
    assert.equal(conflict.statusCode, 409);

    const replayNonce = await ctx.app.inject({ method: 'POST', url: '/v1/transactions', headers, payload });
    assert.equal(replayNonce.statusCode, 401);

    const unsigned = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-sem-assinatura' },
      payload: JSON.stringify({ amountCents: 1_000, method: 'PIX' }),
    });
    assert.equal(unsigned.statusCode, 401);

    const pan = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: {
        ...headers,
        'x-nonce': 'nonce-pan-0001',
        'idempotency-key': 'idem-pan-0001',
        'x-signature': hmacDeviceSignature(
          ctx.config,
          DEMO_TERMINAL_ID,
          timestamp,
          'nonce-pan-0001',
          JSON.stringify({ amountCents: 5_000, method: 'CREDIT', paymentToken: '4111111111111111' }),
        ),
      },
      payload: JSON.stringify({ amountCents: 5_000, method: 'CREDIT', paymentToken: '4111111111111111' }),
    });
    assert.equal(pan.statusCode, 422);
    assert.equal((pan.json() as { error: { code: string } }).error.code, 'PAN_NOT_ACCEPTED');
  } finally {
    await ctx.app.close();
    closeDb(ctx.db);
  }
});

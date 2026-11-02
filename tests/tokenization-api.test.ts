import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { buildTestServer } from './test-server.ts';

test('api de tokenização: ativos, guardrails, pontes, provas e âncoras', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const page = await ctx.app.inject({ method: 'GET', url: '/tokenization.html' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Tokenização/);

    const initial = await ctx.app.inject({ method: 'GET', url: '/v1/tokenization/overview', headers: auth });
    assert.equal(initial.statusCode, 200);
    assert.equal((initial.json() as { assets: { count: number } }).assets.count, 0);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/assets',
      headers: auth,
      payload: {
        kind: 'RWA',
        name: 'Recebíveis de teste',
        symbol: 'TST1',
        backingPerUnitCents: 1_000,
        maxUnits: 1_000,
      },
    });
    assert.equal(created.statusCode, 201);
    const asset = (created.json() as { asset: { id: string; symbol: string } }).asset;
    assert.equal(asset.symbol, 'TST1');

    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/assets/${asset.id}/mint`,
      headers: auth,
      payload: { units: 100 },
    });
    assert.equal(minted.statusCode, 201);
    const mintedBody = minted.json() as { asset: { supplyUnits: number; reserveCents: number }; anchorHeight: number };
    assert.equal(mintedBody.asset.supplyUnits, 100);
    assert.equal(mintedBody.asset.reserveCents, 100_000);
    assert.equal(mintedBody.anchorHeight, 2);

    const transfer = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/assets/${asset.id}/transfer`,
      headers: auth,
      payload: { toHolder: 'usr_parceiro', units: 40 },
    });
    assert.equal(transfer.statusCode, 201);

    const detail = await ctx.app.inject({ method: 'GET', url: `/v1/tokenization/assets/${asset.id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    const detailBody = detail.json() as { holdings: Array<{ holderId: string; units: number }> };
    assert.equal(detailBody.holdings.length, 2);

    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/assets/${asset.id}/redeem`,
      headers: auth,
      payload: { holderId: 'usr_parceiro', units: 40 },
    });
    assert.equal(redeemed.statusCode, 201);
    assert.equal((redeemed.json() as { asset: { supplyUnits: number } }).asset.supplyUnits, 60);

    const bio = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/bio',
      headers: auth,
      payload: {
        name: 'Dataset de teste',
        subjectPseudonym: 'subj_api',
        consent: 'Consentimento explícito e revogável para pesquisa de crédito.',
        consentScope: 'Pesquisa',
        datasetId: 'ds_api_v1',
        royaltyBps: 1_500,
      },
    });
    assert.equal(bio.statusCode, 201);
    const bioId = (bio.json() as { bioAsset: { id: string; status: string } }).bioAsset;
    assert.equal(bioId.status, 'PENDING');

    const earlyRoyalty = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/bio/${bioId.id}/royalties`,
      headers: auth,
      payload: { grossCents: 10_000 },
    });
    assert.equal(earlyRoyalty.statusCode, 422);
    assert.equal((earlyRoyalty.json() as { error: { code: string } }).error.code, 'BIO_NOT_ADMITTED');

    const policy = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/agents/policies',
      headers: auth,
      payload: {
        name: 'Agente de teste',
        allowedSymbols: ['TST1', 'ADLA'],
        maxNotionalCents: 50_000,
        dailyLimitCents: 100_000,
        humanApprovalAboveCents: 20_000,
      },
    });
    assert.equal(policy.statusCode, 201);
    const policyId = (policy.json() as { policy: { id: string } }).policy.id;

    const evaluate = (symbol: string, notionalCents: number) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/tokenization/agents/evaluate',
        headers: auth,
        payload: { policyId, agent: 'agent.api', action: 'BUY', symbol, notionalCents },
      });
    assert.equal(
      ((await evaluate('TST1', 5_000)).json() as { decision: { decision: string } }).decision.decision,
      'APPROVE',
    );
    assert.equal(
      ((await evaluate('TST1', 30_000)).json() as { decision: { decision: string } }).decision.decision,
      'REVIEW',
    );
    assert.equal(
      ((await evaluate('BTCX', 5_000)).json() as { decision: { decision: string } }).decision.decision,
      'BLOCK',
    );

    const quote = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/bridges/quote',
      headers: auth,
      payload: { rail: 'PIX', direction: 'OUT', amountCents: 100_000 },
    });
    assert.equal(quote.statusCode, 201);
    const intent = (quote.json() as { intent: { id: string; feeCents: number; netCents: number } }).intent;
    assert.equal(intent.feeCents, 300);
    assert.equal(intent.netCents, 99_700);
    const settle = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/bridges/${intent.id}/settle`,
      headers: auth,
    });
    assert.equal(settle.statusCode, 201);
    assert.equal((settle.json() as { intent: { status: string } }).intent.status, 'SETTLED');

    const credential = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/zk/credentials',
      headers: auth,
      payload: { claimType: 'KYC_STATUS', value: 'nivel:2' },
    });
    assert.equal(credential.statusCode, 201);
    const issued = credential.json() as { salt: string; subjectId: string; claimType: string; commitment: string };
    assert.equal(issued.subjectId, 'mch_xpartner_demo');

    const proof = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/zk/prove',
      headers: auth,
      payload: { subjectId: issued.subjectId, claimType: 'KYC_STATUS', salt: issued.salt, value: 'nivel:2' },
    });
    assert.equal(proof.statusCode, 200);
    const proofBody = proof.json() as { valid: boolean; proof: unknown };
    assert.equal(proofBody.valid, true);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/zk/verify',
      headers: auth,
      payload: { proof: proofBody.proof },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal((verify.json() as { valid: boolean }).valid, true);

    const anchors = await ctx.app.inject({ method: 'GET', url: '/v1/tokenization/anchors', headers: auth });
    assert.equal(anchors.statusCode, 200);
    const anchorsBody = anchors.json() as { status: { chain: { valid: boolean }; height: number } };
    assert.equal(anchorsBody.status.chain.valid, true);
    assert.ok(anchorsBody.status.height >= 6);

    const trial = await ctx.app.inject({ method: 'GET', url: '/v1/ledger/trial', headers: auth });
    assert.equal((trial.json() as { trial: { balanced: boolean } }).trial.balanced, true);

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/tokenization/overview', headers: auth });
    const summary = overview.json() as {
      assets: { count: number; reserveCents: number };
      agents: { decisions: number };
      bridges: { volumeCents: number };
    };
    assert.equal(summary.assets.count, 1);
    assert.equal(summary.assets.reserveCents, 60_000);
    assert.equal(summary.agents.decisions, 3);
    assert.equal(summary.bridges.volumeCents, 99_700);
  } finally {
    closeDb(ctx.db);
  }
});

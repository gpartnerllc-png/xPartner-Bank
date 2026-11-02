import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { buildTestServer } from './test-server.ts';

test('api web3: redes, oráculo, ofertas DVP, atestação e overview', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/v1/web3/overview' });
    assert.equal(anonymous.statusCode, 401);

    const networkResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/networks',
      headers: auth,
      payload: {
        name: 'AppChain de testes',
        chainId: 777_101,
        kind: 'APPCHAIN',
        rpcUrl: 'https://rpc.xpartner.example',
        dvpContract: '0x1111111111111111111111111111111111111111',
        paymasterContract: '0x2222222222222222222222222222222222222222',
      },
    });
    assert.equal(networkResponse.statusCode, 201);
    const network = (networkResponse.json() as { network: { id: string; chainId: number } }).network;
    assert.equal(network.chainId, 777_101);

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/networks',
      headers: auth,
      payload: { name: 'Duplicada', chainId: 777_101, kind: 'L2', rpcUrl: 'https://rpc.xpartner.example' },
    });
    assert.equal(duplicate.statusCode, 409);

    const feed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/oracle/feeds',
      headers: auth,
      payload: { symbol: 'SOJA', source: 'CHAINLINK', decimals: 2, maxAgeSeconds: 600 },
    });
    assert.equal(feed.statusCode, 201);

    const price = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/oracle/prices',
      headers: auth,
      payload: { symbol: 'SOJA', priceUnits: 50_000 },
    });
    assert.equal(price.statusCode, 201);
    assert.equal((price.json() as { price: { centsPerUnit: number } }).price.centsPerUnit, 50_000);

    const read = await ctx.app.inject({ method: 'GET', url: '/v1/web3/oracle/prices/SOJA', headers: auth });
    assert.equal(read.statusCode, 200);
    assert.equal((read.json() as { price: { maxAgeSeconds: number } }).price.maxAgeSeconds, 600);

    const assetResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/assets',
      headers: auth,
      payload: { kind: 'RWA', name: 'Recebível Web3', symbol: 'W3AS', backingPerUnitCents: 1_000, maxUnits: 1_000 },
    });
    assert.equal(assetResponse.statusCode, 201);
    const asset = (assetResponse.json() as { asset: { id: string } }).asset;
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/assets/${asset.id}/mint`,
      headers: auth,
      payload: { units: 100 },
    });
    assert.equal(minted.statusCode, 201);

    const offerResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/dvp/offers',
      headers: auth,
      payload: {
        networkId: network.id,
        kind: 'CASH_FOR_TOKEN',
        sellSymbol: 'W3AS',
        sellUnits: 10,
        cashCents: 5_000,
        feeBps: 50,
      },
    });
    assert.equal(offerResponse.statusCode, 201);
    const offer = (offerResponse.json() as { offer: { id: string; digest: string } }).offer;
    assert.equal(offer.digest.length, 64);

    const listing = await ctx.app.inject({ method: 'GET', url: '/v1/web3/dvp/offers?mine=true', headers: auth });
    assert.equal(listing.statusCode, 200);
    assert.equal((listing.json() as { data: unknown[] }).data.length, 1);

    const attestationResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/zk/attestations',
      headers: auth,
      payload: {
        commitment: 'c'.repeat(64),
        claimType: 'FATURAMENTO',
        predicate: 'GTE',
        threshold: 100_000,
        issuer: 'bank@xpartner.example',
      },
    });
    assert.equal(attestationResponse.statusCode, 201);
    const attestation = (attestationResponse.json() as { attestation: { id: string } }).attestation;

    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/zk/verify',
      headers: auth,
      payload: { attestationId: attestation.id, purpose: 'limite-credito' },
    });
    assert.equal(verified.statusCode, 201);
    assert.equal((verified.json() as { verified: boolean }).verified, true);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/zk/verify',
      headers: auth,
      payload: { attestationId: attestation.id, purpose: 'limite-credito' },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal((replay.json() as { error: { code: string } }).error.code, 'ZK_NULLIFIER_REUSED');

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/web3/overview', headers: auth });
    assert.equal(overview.statusCode, 200);
    const body = overview.json() as {
      networks: number;
      dvp: { offers: number; openOffers: number };
      zk: { verifications: number };
    };
    assert.equal(body.networks, 1);
    assert.equal(body.dvp.offers, 1);
    assert.equal(body.dvp.openOffers, 1);
    assert.equal(body.zk.verifications, 1);
  } finally {
    closeDb(ctx.db);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb } from '../src/kernel/db.ts';
import { buildTestServer } from './test-server.ts';

test('api aladdin: risco, prova Groth16, crédito, CCIP e intents ponta a ponta', async () => {
  const ctx = await buildTestServer();
  try {
    const auth = { authorization: `Bearer ${ctx.token}` };

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/v1/web3/aladdin/overview' });
    assert.equal(anonymous.statusCode, 401);

    const simulated = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/risk/simulate',
      headers: auth,
      payload: { volatilityBps: 140, samples: 800, hasCollateral: true, onTimeRatioBps: 9_500, ttlSeconds: 3_600 },
    });
    assert.equal(simulated.statusCode, 201);
    const risk = (
      simulated.json() as {
        risk: { id: string; source: string; varBps: number; sampleSize: number; valid: boolean; digest: string };
      }
    ).risk;
    assert.equal(risk.source, 'MONTE_CARLO');
    assert.equal(risk.sampleSize, 800);
    assert.ok(risk.varBps > 0);
    assert.equal(risk.valid, true);
    assert.equal(risk.digest.length, 64);

    const recorded = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/risk/metrics',
      headers: auth,
      payload: { varBps: 700, volatilityBps: 800, creditScore: 8_600, source: 'ORACLE_FUSION', model: 'oracle-fusion-v1' },
    });
    assert.equal(recorded.statusCode, 201);
    assert.equal(
      (recorded.json() as { risk: { creditScore: number } }).risk.creditScore,
      8_600,
    );

    const invalidSource = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/risk/metrics',
      headers: auth,
      payload: { varBps: 700, volatilityBps: 800, creditScore: 8_600, source: 'MONTE_CARLO' },
    });
    assert.equal(invalidSource.statusCode, 422);
    assert.equal((invalidSource.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');

    const proven = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/zk/prove',
      headers: auth,
      payload: { netWorthCents: 50_000_000, salt: '424242', thresholdCents: 10_000_000 },
    });
    assert.equal(proven.statusCode, 201);
    const proof = proven.json() as {
      proof: unknown;
      publicSignals: string[];
      commitment: string;
      satisfied: boolean;
    };
    assert.equal(proof.publicSignals.length, 3);
    assert.equal(proof.publicSignals[1], '1');
    assert.equal(proof.publicSignals[2], '10000000');
    assert.equal(proof.satisfied, true);

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/zk/proofs',
      headers: auth,
      payload: {
        thresholdCents: 10_000_000,
        proof: proof.proof,
        publicSignals: proof.publicSignals,
        commitment: proof.commitment,
      },
    });
    assert.equal(submitted.statusCode, 201);
    const storedProof = (
      submitted.json() as { proof: { id: string; verified: boolean; commitment: string; thresholdCents: number } }
    ).proof;
    assert.equal(storedProof.verified, true);
    assert.equal(storedProof.commitment, proof.commitment);
    assert.equal(storedProof.thresholdCents, 10_000_000);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/zk/proofs',
      headers: auth,
      payload: { thresholdCents: 10_000_000, proof: proof.proof, publicSignals: proof.publicSignals },
    });
    assert.equal(replay.statusCode, 409);

    const loanResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/aladdin/loans',
      headers: auth,
      payload: { principalCents: 2_000_000, zkProofId: storedProof.id, interestBps: 0, durationDays: 60 },
    });
    assert.equal(loanResponse.statusCode, 201);
    const loan = (
      loanResponse.json() as { loan: { id: string; status: string; outstandingCents: number; score: number } }
    ).loan;
    assert.equal(loan.status, 'OPEN');
    assert.equal(loan.outstandingCents, 2_000_000);
    assert.equal(loan.score, 8_600);

    const detail = await ctx.app.inject({ method: 'GET', url: `/v1/web3/aladdin/loans/${loan.id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { loan: { id: string } }).loan.id, loan.id);

    const partial = await ctx.app.inject({
      method: 'POST',
      url: `/v1/web3/aladdin/loans/${loan.id}/repay`,
      headers: auth,
      payload: { amountCents: 1_000_000 },
    });
    assert.equal(partial.statusCode, 200);
    assert.equal((partial.json() as { loan: { outstandingCents: number } }).loan.outstandingCents, 1_000_000);

    const settled = await ctx.app.inject({
      method: 'POST',
      url: `/v1/web3/aladdin/loans/${loan.id}/repay`,
      headers: auth,
      payload: {},
    });
    assert.equal(settled.statusCode, 200);
    assert.equal((settled.json() as { loan: { status: string } }).loan.status, 'REPAID');

    const assetResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokenization/assets',
      headers: auth,
      payload: { kind: 'RWA', name: 'Recebível Cross-chain', symbol: 'NFAI', backingPerUnitCents: 1_000, maxUnits: 10_000 },
    });
    assert.equal(assetResponse.statusCode, 201);
    const asset = (assetResponse.json() as { asset: { id: string } }).asset;
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tokenization/assets/${asset.id}/mint`,
      headers: auth,
      payload: { units: 1_000 },
    });
    assert.equal(minted.statusCode, 201);

    const laneResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/ccip/lanes',
      headers: auth,
      payload: {
        name: 'Consórcio → Agro IA',
        sourceChainId: 777_201,
        destChainId: 777_202,
        sourceSelector: '7772010000000000001',
        destSelector: '7772020000000000002',
        router: '0x1111111111111111111111111111111111111111',
        receiver: '0x2222222222222222222222222222222222222222',
        feeBps: 20,
        maxUnits: 5_000,
      },
    });
    assert.equal(laneResponse.statusCode, 201);
    const lane = (laneResponse.json() as { lane: { id: string; sourceChainId: number } }).lane;
    assert.equal(lane.sourceChainId, 777_201);

    const liquidity = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/ccip/liquidity',
      headers: auth,
      payload: { laneId: lane.id, symbol: 'NFAI', availableUnits: 1_000, rateBps: 25, riskTier: 'A' },
    });
    assert.equal(liquidity.statusCode, 201);

    const intentResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/web3/intents',
      headers: auth,
      payload: {
        laneId: lane.id,
        symbol: 'NFAI',
        amountUnits: 400,
        minDestUnits: 380,
        feeBudgetCents: 1_000,
        deadlineSeconds: 600,
      },
    });
    assert.equal(intentResponse.statusCode, 201);
    const intent = (intentResponse.json() as { intent: { id: string; status: string; digest: string } }).intent;
    assert.equal(intent.status, 'OPEN');
    assert.equal(intent.digest.length, 64);

    const quoteResponse = await ctx.app.inject({
      method: 'POST',
      url: `/v1/web3/intents/${intent.id}/quotes`,
      headers: auth,
      payload: { destUnits: 390, feeCents: 0, etaSeconds: 60, riskBps: 500 },
    });
    assert.equal(quoteResponse.statusCode, 201);
    const quote = (quoteResponse.json() as { quote: { id: string; score: number; status: string } }).quote;
    assert.ok(quote.score > 0 && quote.score <= 10_000);
    assert.equal(quote.status, 'OFFERED');

    const selected = await ctx.app.inject({
      method: 'POST',
      url: `/v1/web3/intents/${intent.id}/select`,
      headers: auth,
      payload: { quoteId: quote.id },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal((selected.json() as { quote: { status: string } }).quote.status, 'SELECTED');

    const executed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/web3/intents/${intent.id}/execute`,
      headers: auth,
    });
    assert.equal(executed.statusCode, 200);
    const execution = executed.json() as {
      intent: { status: string; aiModel: string | null };
      message: { sequence: number; status: string; destUnits: number; messageId: string; receiver: string };
    };
    assert.equal(execution.intent.status, 'SETTLED');
    assert.equal(execution.intent.aiModel, 'aladdin-intent-solver-v1');
    assert.equal(execution.message.status, 'SETTLED');
    assert.equal(execution.message.sequence, 1);
    assert.equal(execution.message.destUnits, 390);
    assert.equal(execution.message.messageId.length, 64);
    assert.equal(execution.message.receiver, '0x2222222222222222222222222222222222222222');

    const intentDetail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/web3/intents/${intent.id}`,
      headers: auth,
    });
    assert.equal(intentDetail.statusCode, 200);
    const detailBody = intentDetail.json() as { quotes: unknown[]; message: { sequence: number } | null };
    assert.equal(detailBody.quotes.length, 1);
    assert.equal(detailBody.message?.sequence, 1);

    const messages = await ctx.app.inject({ method: 'GET', url: '/v1/web3/ccip/messages', headers: auth });
    assert.equal(messages.statusCode, 200);
    assert.equal((messages.json() as { data: unknown[] }).data.length, 1);

    const intentOverview = await ctx.app.inject({
      method: 'GET',
      url: '/v1/web3/intents/overview',
      headers: auth,
    });
    assert.equal(intentOverview.statusCode, 200);
    const crosschain = intentOverview.json() as {
      lanes: number;
      intents: { total: number; settled: number; deliveredUnits: number };
      messages: { total: number };
      model: string;
    };
    assert.equal(crosschain.lanes, 1);
    assert.equal(crosschain.intents.total, 1);
    assert.equal(crosschain.intents.settled, 1);
    assert.equal(crosschain.intents.deliveredUnits, 390);
    assert.equal(crosschain.messages.total, 1);
    assert.equal(crosschain.model, 'aladdin-intent-solver-v1');

    const overview = await ctx.app.inject({ method: 'GET', url: '/v1/web3/aladdin/overview', headers: auth });
    assert.equal(overview.statusCode, 200);
    const aladdin = overview.json() as {
      risk: { creditScore: number } | null;
      loans: { total: number; open: number; outstandingCents: number };
      proofs: { total: number };
      policy: { minScore: number; verifier: string; circuit: string };
    };
    assert.equal(aladdin.risk?.creditScore, 8_600);
    assert.equal(aladdin.loans.total, 1);
    assert.equal(aladdin.loans.open, 0);
    assert.equal(aladdin.loans.outstandingCents, 0);
    assert.equal(aladdin.proofs.total, 1);
    assert.equal(aladdin.policy.minScore, 7_000);
    assert.equal(aladdin.policy.verifier, 'groth16-bn254');
    assert.equal(aladdin.policy.circuit, 'NetWorthProof');
  } finally {
    closeDb(ctx.db);
  }
});

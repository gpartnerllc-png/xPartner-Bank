import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb, nowIso } from '../src/kernel/db.ts';
import type { Db } from '../src/kernel/db.ts';
import { listBalances, postGroup, trialBalance } from '../src/domain/ledger.ts';
import { verifyAnchorChain } from '../src/kernel/anchor.ts';
import { AppError } from '../src/kernel/errors.ts';
import { AladdinEngine } from '../src/modules/aladdin.ts';
import { seedAladdin } from '../src/modules/aladdin-seed.ts';
import { CrossChainHub } from '../src/modules/crosschain.ts';
import { TokenizationHub } from '../src/modules/tokenization.ts';
import { simulateMonteCarlo } from '../src/domain/aladdin.ts';
import { proveNetWorth } from '../src/modules/zk-snark.ts';
import type { NetWorthProofResult } from '../src/modules/zk-snark.ts';
import { DEMO_MERCHANT_ID } from '../src/modules/seed.ts';
import { testConfig, testDb } from './helpers.ts';

const PARTNER = 'mch_parceiro_aladdin';
const SOLVER = 'mch_solver_aladdin';

function addMerchant(db: Db, id: string, document: string): void {
  db.prepare(
    `INSERT INTO merchants (id, name, trade_name, document, mcc, ie, crt, city, uf, pix_key, status, created_at)
     VALUES (?, ?, ?, ?, '5911', '110042490114', '1', 'SAO PAULO', 'SP', NULL, 'ACTIVE', ?)`,
  ).run(id, `PARCEIRO ${id}`, `Parceiro ${id}`, document, nowIso());
}

function fundMerchant(db: Db, merchantId: string, cents: number): void {
  postGroup(db, {
    groupId: `fund_${merchantId}_${cents}_${Math.random()}`,
    groupKind: 'TEST_FUNDING',
    entries: [
      { kind: 'CASH', direction: 'DEBIT', amountCents: cents, memo: 'Aporte de teste' },
      { kind: 'MERCHANT_AVAILABLE', ownerType: 'MERCHANT', ownerId: merchantId, direction: 'CREDIT', amountCents: cents },
    ],
  });
}

function availableOf(db: Db, merchantId: string): number {
  const balances = listBalances(db, { ownerType: 'MERCHANT', ownerId: merchantId });
  const row = balances.find((item) => item.kind === 'MERCHANT_AVAILABLE');
  return row ? row.creditCents - row.debitCents : 0;
}

function setup(db: Db) {
  const aladdin = new AladdinEngine(db);
  const crosschain = new CrossChainHub(db);
  addMerchant(db, PARTNER, '98765432000110');
  addMerchant(db, SOLVER, '11222333000181');
  return { aladdin, crosschain };
}

let fixture: Promise<NetWorthProofResult> | undefined;
function proofFixture(): Promise<NetWorthProofResult> {
  fixture ??= proveNetWorth({ netWorthCents: 50_000_000, salt: '424242', thresholdCents: 10_000_000 });
  return fixture;
}

test('aladdin: Monte Carlo é determinístico e métrica expira bloqueando o crédito', () => {
  const db = testDb();
  try {
    const { aladdin } = setup(db);
    const a = simulateMonteCarlo({ seedParts: ['x', '2026-11-02', 200, 9900], samples: 1_000 });
    const b = simulateMonteCarlo({ seedParts: ['x', '2026-11-02', 200, 9900], samples: 1_000 });
    assert.deepEqual(a, b);
    assert.ok(a.varBps > 0 && a.volatilityBps > 0);
    assert.ok(a.varBps < a.volatilityBps * 5);

    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const simulated = aladdin.simulateRisk({
      merchantId: PARTNER,
      volatilityBps: 150,
      samples: 1_000,
      ttlSeconds: 60,
      hasCollateral: true,
      onTimeRatioBps: 9_000,
      now,
    });
    assert.equal(simulated.risk.valid, true);
    assert.equal(simulated.risk.merchantId, PARTNER);
    assert.equal(simulated.risk.source, 'MONTE_CARLO');
    assert.equal(aladdin.listRisk(PARTNER).length, 1);
    assert.equal(aladdin.latestRisk(PARTNER, now + 1_000).id, simulated.risk.id);
    assert.throws(
      () => aladdin.latestRisk(PARTNER, now + 61_000),
      (error: unknown) => error instanceof AppError && error.code === 'ALADDIN_RISK_STALE',
    );
    assert.throws(
      () =>
        aladdin.recordRisk({
          merchantId: PARTNER,
          varBps: 500,
          volatilityBps: 500,
          creditScore: 8_000,
          source: 'MONTE_CARLO',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('aladdin: prova Groth16 real aceita, detecta adulteração e recusa replay', async () => {
  const db = testDb();
  try {
    const { aladdin } = setup(db);
    const fixtureProof = await proofFixture();
    assert.equal(fixtureProof.publicSignals.length, 3);
    assert.equal(fixtureProof.publicSignals[1], '1');
    assert.equal(fixtureProof.publicSignals[2], '10000000');

    const submitted = await aladdin.submitProof({
      merchantId: PARTNER,
      thresholdCents: 10_000_000,
      proof: fixtureProof.proof,
      publicSignals: fixtureProof.publicSignals,
    });
    assert.equal(submitted.proof.verified, true);
    assert.equal(submitted.proof.thresholdCents, 10_000_000);
    assert.equal(submitted.proof.commitment, fixtureProof.commitment);
    assert.equal(aladdin.listProofs(PARTNER).length, 1);

    await assert.rejects(
      aladdin.submitProof({
        merchantId: PARTNER,
        thresholdCents: 10_000_000,
        proof: fixtureProof.proof,
        publicSignals: fixtureProof.publicSignals,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );

    const tampered = structuredClone(fixtureProof.proof);
    tampered.pi_a[0] = (BigInt(tampered.pi_a[0]) + 1n).toString();
    await assert.rejects(
      aladdin.submitProof({
        merchantId: PARTNER,
        thresholdCents: 10_000_000,
        proof: tampered,
        publicSignals: fixtureProof.publicSignals,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'ZK_PROOF_INVALID',
    );

    await assert.rejects(
      aladdin.submitProof({
        merchantId: PARTNER,
        thresholdCents: 20_000_000,
        proof: fixtureProof.proof,
        publicSignals: fixtureProof.publicSignals,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'ZK_INVALID_PROOF',
    );

    await assert.rejects(
      aladdin.prove({ netWorthCents: 5_000_000, salt: '1', thresholdCents: 10_000_000 }),
      (error: unknown) => error instanceof AppError && error.code === 'ZK_PREDICATE_UNSATISFIED',
    );
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('aladdin: crédito algorítmico exige score, prova e respeita limites e quitação', async () => {
  const db = testDb();
  try {
    const { aladdin } = setup(db);
    fundMerchant(db, PARTNER, 10_000_000);
    const fixtureProof = await proofFixture();
    const base = Date.now();

    aladdin.recordRisk({
      merchantId: PARTNER,
      varBps: 900,
      volatilityBps: 1_200,
      creditScore: 6_500,
      source: 'ORACLE_FUSION',
      now: base,
    });
    const submitted = await aladdin.submitProof({
      merchantId: PARTNER,
      thresholdCents: 10_000_000,
      proof: fixtureProof.proof,
      publicSignals: fixtureProof.publicSignals,
    });
    assert.throws(
      () => aladdin.openLoan({ borrowerId: PARTNER, principalCents: 2_000_000, zkProofId: submitted.proof.id }),
      (error: unknown) => error instanceof AppError && error.code === 'ALADDIN_SCORE_LOW',
    );

    aladdin.recordRisk({
      merchantId: PARTNER,
      varBps: 800,
      volatilityBps: 900,
      creditScore: 8_800,
      source: 'ORACLE_FUSION',
      now: base + 1_000,
    });
    assert.throws(
      () => aladdin.openLoan({ borrowerId: PARTNER, principalCents: 12_000_000, zkProofId: submitted.proof.id }),
      (error: unknown) => error instanceof AppError && error.code === 'ALADDIN_LIMIT_EXCEEDED',
    );

    const before = availableOf(db, PARTNER);
    const opened = aladdin.openLoan({
      borrowerId: PARTNER,
      principalCents: 2_000_000,
      zkProofId: submitted.proof.id,
      durationDays: 60,
    });
    assert.equal(opened.loan.principalCents, 2_000_000);
    assert.equal(opened.loan.outstandingCents, 2_360_000);
    assert.equal(opened.loan.score, 8_800);
    assert.equal(availableOf(db, PARTNER), before + 2_000_000);

    const consumed = aladdin.listProofs(PARTNER)[0];
    assert.equal(consumed?.consumedBy, opened.loan.id);

    const partial = aladdin.repayLoan({ loanId: opened.loan.id, borrowerId: PARTNER, amountCents: 1_000_000 });
    assert.equal(partial.loan.status, 'OPEN');
    assert.equal(partial.loan.outstandingCents, 1_360_000);
    const closed = aladdin.repayLoan({ loanId: opened.loan.id, borrowerId: PARTNER });
    assert.equal(closed.loan.status, 'REPAID');
    assert.equal(closed.loan.outstandingCents, 0);
    assert.equal(closed.loan.progressPct, 100);

    await assert.rejects(
      aladdin.submitProof({
        merchantId: PARTNER,
        thresholdCents: 10_000_000,
        proof: fixtureProof.proof,
        publicSignals: fixtureProof.publicSignals,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );

    const overview = aladdin.overview(PARTNER);
    assert.equal(overview.loans.total, 1);
    assert.equal(overview.loans.open, 0);
    assert.equal(overview.proofs.total, 1);
    assert.equal(overview.policy.minScore, 7_000);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('crosschain: intents com escrow, liquidez P2P, score de IA e mensagem CCIP', () => {
  const db = testDb();
  try {
    const { crosschain } = setup(db);
    const tokenization = new TokenizationHub(db);
    const { asset } = tokenization.createAsset({
      merchantId: PARTNER,
      kind: 'RWA',
      name: 'Recebível Cerrado',
      symbol: 'NFCR',
      backingPerUnitCents: 10_000,
      maxUnits: 10_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: PARTNER, units: 1_000, actor: 'test' });
    fundMerchant(db, PARTNER, 10_000);

    const { lane } = crosschain.registerLane({
      name: 'Consórcio → Agro',
      sourceChainId: 777_001,
      destChainId: 777_002,
      sourceSelector: '7770010000000000001',
      destSelector: '7770020000000000002',
      router: '0x1111111111111111111111111111111111111111',
      receiver: '0x2222222222222222222222222222222222222222',
      feeBps: 20,
      maxUnits: 5_000,
    });
    assert.equal(crosschain.listLanes('ACTIVE').length, 1);
    crosschain.registerLiquidity({
      merchantId: DEMO_MERCHANT_ID,
      laneId: lane.id,
      symbol: 'NFCR',
      availableUnits: 1_000,
      rateBps: 25,
      riskTier: 'A',
    });
    crosschain.registerLiquidity({
      merchantId: SOLVER,
      laneId: lane.id,
      symbol: 'NFCR',
      availableUnits: 1_000,
      rateBps: 40,
      riskTier: 'B',
    });

    const opened = crosschain.createIntent({
      merchantId: PARTNER,
      laneId: lane.id,
      symbol: 'NFCR',
      amountUnits: 400,
      minDestUnits: 380,
      feeBudgetCents: 5_000,
      deadlineSeconds: 600,
    });
    assert.equal(opened.intent.status, 'OPEN');

    const cheap = crosschain.quoteIntent({
      intentId: opened.intent.id,
      solverId: DEMO_MERCHANT_ID,
      providerMerchantId: DEMO_MERCHANT_ID,
      destUnits: 390,
      feeCents: 2_000,
      etaSeconds: 60,
      riskBps: 500,
    });
    const fast = crosschain.quoteIntent({
      intentId: opened.intent.id,
      solverId: SOLVER,
      providerMerchantId: SOLVER,
      destUnits: 400,
      feeCents: 4_000,
      etaSeconds: 30,
      riskBps: 800,
    });
    assert.ok(cheap.quote.score > fast.quote.score);

    const selected = crosschain.selectQuote(opened.intent.id, PARTNER);
    assert.equal(selected.quote.id, cheap.quote.id);
    assert.equal(selected.quote.status, 'SELECTED');
    assert.equal(selected.intent.status, 'QUOTED');

    const settled = crosschain.executeIntent({ intentId: opened.intent.id, merchantId: PARTNER });
    assert.equal(settled.intent.status, 'SETTLED');
    assert.equal(settled.message.sequence, 1);
    assert.equal(settled.message.status, 'SETTLED');
    assert.equal(settled.message.destUnits, 390);
    assert.equal(settled.message.receiver, '0x2222222222222222222222222222222222222222');
    assert.equal(settled.message.messageId.length, 64);

    const stored = db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(asset.id, DEMO_MERCHANT_ID) as { units: number };
    assert.equal(stored.units, 400);
    const partnerHolding = db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(asset.id, PARTNER) as { units: number };
    assert.equal(partnerHolding.units, 600);
    const demoLiquidity = crosschain.listLiquidity({ laneId: lane.id }).find((row) => row.merchantId === DEMO_MERCHANT_ID);
    assert.equal(demoLiquidity?.availableUnits, 610);
    assert.equal(availableOf(db, PARTNER), 8_000);

    const overview = crosschain.overview(PARTNER);
    assert.equal(overview.lanes, 1);
    assert.equal(overview.intents.settled, 1);
    assert.equal(overview.intents.volumeUnits, 400);
    assert.equal(overview.intents.deliveredUnits, 390);
    assert.equal(overview.messages.total, 1);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('crosschain: cotação baixa, liquidez insuficiente, expiração e cancelamento devolvem escrow', () => {
  const db = testDb();
  try {
    const { crosschain } = setup(db);
    const tokenization = new TokenizationHub(db);
    const { asset } = tokenization.createAsset({
      merchantId: PARTNER,
      kind: 'RWA',
      name: 'Recebível Cerrado 2',
      symbol: 'NFC2',
      backingPerUnitCents: 10_000,
      maxUnits: 10_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: PARTNER, units: 1_000, actor: 'test' });
    const { lane } = crosschain.registerLane({
      name: 'Consórcio → Agro 2',
      sourceChainId: 777_001,
      destChainId: 777_003,
      sourceSelector: '7770010000000000001',
      destSelector: '7770030000000000003',
      router: '0x1111111111111111111111111111111111111111',
      receiver: '0x3333333333333333333333333333333333333333',
    });
    crosschain.registerLiquidity({
      merchantId: SOLVER,
      laneId: lane.id,
      symbol: 'NFC2',
      availableUnits: 100,
      rateBps: 10,
      riskTier: 'A',
    });

    const opened = crosschain.createIntent({
      merchantId: PARTNER,
      laneId: lane.id,
      symbol: 'NFC2',
      amountUnits: 300,
      minDestUnits: 290,
      feeBudgetCents: 1_000,
      deadlineSeconds: 60,
    });
    assert.throws(
      () =>
        crosschain.quoteIntent({
          intentId: opened.intent.id,
          solverId: SOLVER,
          providerMerchantId: SOLVER,
          destUnits: 280,
          feeCents: 100,
          etaSeconds: 10,
          riskBps: 100,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'INTENT_QUOTE_LOW',
    );
    assert.throws(
      () =>
        crosschain.quoteIntent({
          intentId: opened.intent.id,
          solverId: SOLVER,
          providerMerchantId: SOLVER,
          destUnits: 300,
          feeCents: 100,
          etaSeconds: 10,
          riskBps: 100,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'CCIP_LIQUIDITY_INSUFFICIENT',
    );
    assert.throws(
      () =>
        crosschain.quoteIntent({
          intentId: opened.intent.id,
          solverId: SOLVER,
          providerMerchantId: SOLVER,
          destUnits: 295,
          feeCents: 2_000,
          etaSeconds: 10,
          riskBps: 100,
          now: Date.now() + 61_000,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'INTENT_EXPIRED',
    );

    const cancelled = crosschain.cancelIntent({ intentId: opened.intent.id, merchantId: PARTNER });
    assert.equal(cancelled.intent.status, 'CANCELLED');
    const holding = db
      .prepare('SELECT units FROM token_holdings WHERE asset_id = ? AND holder_id = ?')
      .get(asset.id, PARTNER) as { units: number };
    assert.equal(holding.units, 1_000);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('aladdin: seed de demonstração cria risco, lane CCIP e liquidez idempotentes', () => {
  const db = testDb();
  try {
    const aladdin = new AladdinEngine(db);
    const crosschain = new CrossChainHub(db);
    const config = testConfig({ SEED_DEMO: 'true' });

    seedAladdin(aladdin, crosschain, config);
    const risk = aladdin.latestRisk(DEMO_MERCHANT_ID);
    assert.equal(risk.source, 'MONTE_CARLO');
    const lane = crosschain.listLanes('ACTIVE')[0];
    assert.equal(lane?.sourceChainId, 771_001);
    assert.equal(lane?.destChainId, 771_002);
    const liquidity = crosschain.listLiquidity({ status: 'ACTIVE' });
    assert.equal(liquidity.length, 1);
    assert.equal(liquidity[0]?.merchantId, DEMO_MERCHANT_ID);
    assert.equal(liquidity[0]?.availableUnits, 1_000);

    seedAladdin(aladdin, crosschain, config);
    assert.equal(aladdin.listRisk(DEMO_MERCHANT_ID).length, 1);
    assert.equal(crosschain.listLanes().length, 1);
    assert.equal(crosschain.listLiquidity({}).length, 1);

    const disabled = testConfig({ SEED_DEMO: 'false' });
    const other = testDb();
    try {
      const otherAladdin = new AladdinEngine(other);
      const otherCrosschain = new CrossChainHub(other);
      seedAladdin(otherAladdin, otherCrosschain, disabled);
      assert.equal(otherCrosschain.listLanes().length, 0);
      assert.equal(otherAladdin.listRisk(DEMO_MERCHANT_ID).length, 0);
    } finally {
      closeDb(other);
    }
  } finally {
    closeDb(db);
  }
});

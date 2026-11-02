import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb, migrate, openDb } from '../src/kernel/db.ts';
import { trialBalance } from '../src/domain/ledger.ts';
import { verifyAnchorChain } from '../src/kernel/anchor.ts';
import { TokenizationHub } from '../src/modules/tokenization.ts';
import { seedTokenization } from '../src/modules/tokenization-seed.ts';
import { DEMO_MERCHANT_ID, seedCore } from '../src/modules/seed.ts';
import { AppError } from '../src/kernel/errors.ts';
import { testConfig, testDb } from './helpers.ts';

test('tokenização: emissão, transferência e resgate mantêm lastro e ledger', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    const { asset } = hub.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Recebíveis teste',
      symbol: 'RCBT',
      backingPerUnitCents: 1_000,
      maxUnits: 1_000,
    });
    assert.equal(asset.supplyUnits, 0);

    const minted = hub.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 100 });
    assert.equal(minted.asset.supplyUnits, 100);
    assert.equal(minted.asset.reserveCents, 100_000);
    assert.equal(minted.event.anchorHeight, 2);

    let trial = trialBalance(db);
    assert.equal(trial.balanced, true);

    hub.transfer({
      assetId: asset.id,
      fromHolder: DEMO_MERCHANT_ID,
      toHolder: 'usr_parceiro',
      units: 40,
    });
    const holdings = hub.getAssetHoldings(asset.id);
    assert.deepEqual(
      holdings.map((row) => [row.holderId, row.units]).sort(),
      [
        [DEMO_MERCHANT_ID, 60],
        ['usr_parceiro', 40],
      ].sort(),
    );

    const redeemed = hub.redeem({ assetId: asset.id, holderId: 'usr_parceiro', units: 40 });
    assert.equal(redeemed.asset.supplyUnits, 60);
    assert.equal(redeemed.asset.reserveCents, 60_000);
    assert.deepEqual(hub.getAssetHoldings(asset.id).map((row) => row.holderId), [DEMO_MERCHANT_ID]);

    trial = trialBalance(db);
    assert.equal(trial.balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);

    assert.throws(
      () => hub.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 1_000 }),
      (error: unknown) => error instanceof AppError && error.code === 'TOKEN_SUPPLY_LIMIT',
    );
    assert.throws(
      () => hub.transfer({ assetId: asset.id, fromHolder: 'usr_parceiro', toHolder: DEMO_MERCHANT_ID, units: 1 }),
      (error: unknown) => error instanceof AppError && error.code === 'TOKEN_INSUFFICIENT_UNITS',
    );
  } finally {
    closeDb(db);
  }
});

test('tokenização: bioativo exige admissão DAO e paga royalty com lastro contábil', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    const governance = hub.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Governança',
      symbol: 'ADLA',
      backingPerUnitCents: 100,
      maxUnits: 1_000_000,
    });
    hub.mint({ assetId: governance.asset.id, holderId: DEMO_MERCHANT_ID, units: 10_000 });

    const { bioAsset } = hub.createBioAsset({
      merchantId: DEMO_MERCHANT_ID,
      name: 'Dataset de teste',
      subjectPseudonym: 'subj_teste',
      consent: 'Consentimento explícito e revogável para pesquisa de crédito.',
      consentScope: 'Pesquisa de crédito',
      datasetId: 'ds_teste_v1',
      royaltyBps: 1_500,
    });
    assert.equal(bioAsset.status, 'PENDING');
    assert.throws(
      () => hub.payRoyalty({ bioAssetId: bioAsset.id, payerId: 'usr_lab', grossCents: 10_000 }),
      (error: unknown) => error instanceof AppError && error.code === 'BIO_NOT_ADMITTED',
    );

    const now = Date.now();
    const proposal = hub.createProposal({
      proposerId: DEMO_MERCHANT_ID,
      kind: 'ADMIT_BIO_SOURCE',
      subject: bioAsset.id,
      title: 'Admitir dataset',
      description: 'Consentimento verificado e royalty definido.',
      quorumUnits: 500,
      durationHours: 1,
      now,
    });
    hub.vote({ proposalId: proposal.proposal.id, voterId: DEMO_MERCHANT_ID, choice: 'FOR', now: now + 1_000 });
    assert.throws(
      () => hub.closeProposal(proposal.proposal.id, now + 2_000),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );

    const decided = hub.closeProposal(proposal.proposal.id, now + 3_600_001);
    assert.equal(decided.proposal.status, 'APPROVED');
    assert.equal(hub.getBioAsset(bioAsset.id).status, 'ADMITTED');

    const paid = hub.payRoyalty({ bioAssetId: bioAsset.id, payerId: 'usr_lab', grossCents: 10_000 });
    assert.equal(paid.royalty.royaltyCents, 1_500);
    assert.equal(paid.royalty.platformFeeCents, 8_500);
    assert.equal(trialBalance(db).balanced, true);

    const revoked = hub.revokeBioAsset(bioAsset.id, 'Titular revogou o consentimento');
    assert.equal(revoked.bioAsset.status, 'REVOKED');
    assert.throws(
      () => hub.payRoyalty({ bioAssetId: bioAsset.id, payerId: 'usr_lab', grossCents: 1_000 }),
      (error: unknown) => error instanceof AppError && error.code === 'BIO_NOT_ADMITTED',
    );
  } finally {
    closeDb(db);
  }
});

test('tokenização: guardrails de agente bloqueiam, revisam e aprovam', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    const { policy } = hub.createAgentPolicy({
      merchantId: DEMO_MERCHANT_ID,
      name: 'Agente de tesouraria',
      allowedSymbols: ['NFCR', 'ADLA'],
      maxNotionalCents: 50_000,
      dailyLimitCents: 60_000,
      humanApprovalAboveCents: 20_000,
    });
    const evaluate = (symbol: string, notionalCents: number) =>
      hub.evaluateAgentAction({
        policyId: policy.id,
        agent: 'agent.teste',
        action: 'BUY',
        symbol,
        notionalCents,
      }).decision;

    assert.equal(evaluate('NFCR', 5_000).decision, 'APPROVE');
    assert.equal(evaluate('NFCR', 30_000).decision, 'REVIEW');
    assert.equal(evaluate('ETHX', 5_000).decision, 'BLOCK');
    assert.equal(evaluate('NFCR', 60_000).decision, 'BLOCK');
    assert.equal(evaluate('NFCR', 30_000).decision, 'BLOCK');

    assert.equal(trialBalance(db).balanced, true);
  } finally {
    closeDb(db);
  }
});

test('tokenização: pontes multi-trilho cotam, liquidam e expiram', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    const rails = hub.bridgeRails().map((rail) => rail.rail);
    assert.deepEqual(rails, ['PIX', 'LIGHTNING', 'DREX', 'TCA']);

    const quote = hub.quoteBridge({ merchantId: DEMO_MERCHANT_ID, rail: 'PIX', direction: 'OUT', amountCents: 100_000 });
    assert.equal(quote.intent.feeCents, 300);
    assert.equal(quote.intent.netCents, 99_700);
    const settled = hub.settleBridge(quote.intent.id);
    assert.equal(settled.intent.status, 'SETTLED');

    const expiring = hub.quoteBridge({
      merchantId: DEMO_MERCHANT_ID,
      rail: 'LIGHTNING',
      direction: 'IN',
      amountCents: 50_000,
      now: Date.now() - 3_600_000,
    });
    assert.throws(
      () => hub.settleBridge(expiring.intent.id),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.equal(hub.listBridges(DEMO_MERCHANT_ID).find((item) => item.id === expiring.intent.id)?.status, 'EXPIRED');
  } finally {
    closeDb(db);
  }
});

test('tokenização: provas Merkle de credencial verificam e detectam adulteração', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    const first = hub.issueCredential({ subjectId: DEMO_MERCHANT_ID, claimType: 'KYC_STATUS', value: 'nivel:2' });
    hub.issueCredential({ subjectId: 'usr_a', claimType: 'KYC_STATUS', value: 'nivel:3' });
    hub.issueCredential({ subjectId: 'usr_b', claimType: 'KYC_STATUS', value: 'nivel:3' });

    const proof = hub.proveCredential({
      subjectId: DEMO_MERCHANT_ID,
      claimType: 'KYC_STATUS',
      salt: first.salt,
      value: 'nivel:2',
    });
    assert.equal(proof.valid, true);
    assert.equal(proof.setSize, 3);
    assert.equal(hub.verifyProof(proof.proof).valid, true);

    const tampered = structuredClone(proof.proof);
    tampered.path[0].hash = (tampered.path[0].hash[0] === 'a' ? 'b' : 'a') + tampered.path[0].hash.slice(1);
    assert.equal(hub.verifyProof(tampered).valid, false);
    assert.equal(
      hub.verifyCommitment(first.commitment, {
        subjectId: DEMO_MERCHANT_ID,
        claimType: 'KYC_STATUS',
        salt: first.salt,
        value: 'nivel:2',
      }).valid,
      true,
    );
  } finally {
    closeDb(db);
  }
});

test('tokenização: cadeia de âncoras detecta adulteração', () => {
  const db = testDb();
  try {
    const hub = new TokenizationHub(db);
    hub.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'KNOWLEDGE',
      name: 'Knowledge pack',
      symbol: 'KNOW',
      backingPerUnitCents: 100,
      maxUnits: 100,
    });
    assert.equal(hub.anchorStatus().chain.valid, true);
    db.prepare("UPDATE anchor_chain SET payload_hash = 'adulterado' WHERE height = 1").run();
    const status = hub.anchorStatus();
    assert.equal(status.chain.valid, false);
    assert.equal(status.chain.brokenAt, 1);
  } finally {
    closeDb(db);
  }
});

test('tokenização: seed de demonstração gera ecossistema coerente', () => {
  const config = testConfig({ SEED_DEMO: 'true' });
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedCore(db);
    const hub = new TokenizationHub(db);
    seedTokenization(db, hub, config);

    const assets = hub.listAssets(DEMO_MERCHANT_ID);
    assert.ok(assets.some((asset) => asset.symbol === 'ADLA'));
    assert.ok(assets.some((asset) => asset.symbol === 'NFCR'));
    assert.ok(assets.some((asset) => asset.symbol === 'TCA26'));

    const bio = hub.listBioAssets(DEMO_MERCHANT_ID);
    assert.equal(bio.length, 1);
    assert.equal(bio[0].status, 'ADMITTED');
    assert.ok(bio[0].royaltyPaidCents > 0);

    const devices = hub.listDevices(DEMO_MERCHANT_ID);
    assert.equal(devices.length, 1);
    assert.ok(devices[0].rewardCents > 0);

    const decisions = hub.listDecisions(DEMO_MERCHANT_ID);
    assert.deepEqual(new Set(decisions.map((row) => row.decision)), new Set(['APPROVE', 'REVIEW', 'BLOCK']));
    assert.ok(hub.listBridges(DEMO_MERCHANT_ID).every((bridge) => bridge.status === 'SETTLED'));

    const overview = hub.overview(DEMO_MERCHANT_ID);
    assert.equal(overview.bio.admitted, 1);
    assert.equal(overview.anchors.valid, true);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(hub.anchorStatus().chain.valid, true);
  } finally {
    closeDb(db);
  }
});

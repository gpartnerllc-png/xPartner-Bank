import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb, migrate, nowIso } from '../src/kernel/db.ts';
import { openDb } from '../src/kernel/db-node.ts';
import type { Db } from '../src/kernel/db.ts';
import { postGroup } from '../src/domain/ledger.ts';
import { trialBalance } from '../src/domain/ledger.ts';
import { verifyAnchorChain } from '../src/kernel/anchor.ts';
import { AppError } from '../src/kernel/errors.ts';
import { TokenizationHub } from '../src/modules/tokenization.ts';
import { seedTokenization } from '../src/modules/tokenization-seed.ts';
import { seedWeb3 } from '../src/modules/web3-seed.ts';
import { Web3Hub } from '../src/modules/web3.ts';
import { DEMO_MERCHANT_ID, seedCore } from '../src/modules/seed.ts';
import { testConfig, testDb } from './helpers.ts';

const PARTNER = 'mch_parceiro_teste';
const LIQUIDATOR = 'mch_liquidante_teste';
const DVP_CONTRACT = '0x1111111111111111111111111111111111111111';
const PAYMASTER_CONTRACT = '0x2222222222222222222222222222222222222222';

function addMerchant(db: Db, id: string, document: string): void {
  db.prepare(
    `INSERT INTO merchants (id, name, trade_name, document, mcc, ie, crt, city, uf, pix_key, status, created_at)
     VALUES (?, ?, ?, ?, '5911', '110042490114', '1', 'SAO PAULO', 'SP', NULL, 'ACTIVE', ?)`,
  ).run(id, `PARCEIRO ${id}`, `Parceiro ${id}`, document, nowIso());
}

function fundMerchant(db: Db, merchantId: string, cents: number): void {
  postGroup(db, {
    groupId: `fund_${merchantId}_${cents}`,
    groupKind: 'TEST_FUNDING',
    entries: [
      { kind: 'CASH', direction: 'DEBIT', amountCents: cents, memo: 'Aporte de teste' },
      { kind: 'MERCHANT_AVAILABLE', ownerType: 'MERCHANT', ownerId: merchantId, direction: 'CREDIT', amountCents: cents },
    ],
  });
}

function setup(db: Db) {
  const tokenization = new TokenizationHub(db);
  const web3 = new Web3Hub(db);
  addMerchant(db, PARTNER, '98765432000110');
  addMerchant(db, LIQUIDATOR, '11222333000181');
  const { network } = web3.registerNetwork({
    name: 'xPartner AppChain',
    chainId: 777_001,
    kind: 'APPCHAIN',
    rpcUrl: 'https://rpc.xpartner.example',
    explorerUrl: 'https://explorer.xpartner.example',
    dvpContract: DVP_CONTRACT,
    paymasterContract: PAYMASTER_CONTRACT,
    finalitySeconds: 2,
  });
  return { tokenization, web3, network };
}

test('web3: redes, oráculo com staleness e recusa de configuração inválida', () => {
  const db = testDb();
  try {
    const { web3, network } = setup(db);
    assert.equal(network.chainId, 777_001);
    assert.equal(network.kind, 'APPCHAIN');
    assert.equal(web3.getNetwork('777001').id, network.id);
    assert.equal(web3.listNetworks('ACTIVE').length, 1);
    assert.throws(
      () =>
        web3.registerNetwork({
          name: 'Duplicada',
          chainId: 777_001,
          kind: 'SUBNET',
          rpcUrl: 'https://rpc.xpartner.example',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.throws(
      () => web3.registerNetwork({ name: 'Inválida', chainId: 0, kind: 'L1', rpcUrl: 'ftp://x' }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () =>
        web3.registerFeed({ symbol: 'AGRO', source: 'XPARTNER', decimals: 9 }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );

    web3.registerFeed({ symbol: 'AGRO', source: 'CHAINLINK', decimals: 2, maxAgeSeconds: 600 });
    const published = web3.publishPrice({ symbol: 'AGRO', priceUnits: 50_000 });
    assert.equal(published.price.round, 1);
    const read = web3.readPrice('AGRO');
    assert.equal(read.centsPerUnit, 50_000);
    assert.equal(read.source, 'CHAINLINK');

    const stale = web3.publishPrice({
      symbol: 'AGRO',
      priceUnits: 51_000,
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    assert.equal(stale.price.round, 2);
    assert.throws(
      () => web3.readPrice('AGRO'),
      (error: unknown) => error instanceof AppError && error.code === 'ORACLE_STALE',
    );
    assert.equal(web3.priceSnapshot('AGRO'), undefined);
    assert.equal(
      web3.listFeeds().find((feed) => feed.symbol === 'AGRO')?.latest?.round,
      2,
    );
  } finally {
    closeDb(db);
  }
});

test('web3: DVP cash-for-token liquida com taxa, posições e proteção contra replay', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const { asset } = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Recebível DVP',
      symbol: 'DVPA',
      backingPerUnitCents: 1_000,
      maxUnits: 10_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 500 });
    fundMerchant(db, PARTNER, 100_000);

    const created = web3.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      kind: 'CASH_FOR_TOKEN',
      sellSymbol: 'DVPA',
      sellUnits: 100,
      cashCents: 50_000,
      feeBps: 100,
      expiresInSeconds: 3_600,
    });
    assert.equal(created.offer.status, 'OPEN');
    assert.equal(created.offer.digest.length, 64);

    const settled = web3.acceptOffer({ offerId: created.offer.id, takerId: PARTNER });
    assert.equal(settled.trade.cashCents, 50_000);
    assert.equal(settled.trade.feeCents, 500);
    assert.equal(settled.offer.status, 'FILLED');
    assert.equal(settled.trade.anchorHeight, settled.anchorHeight);
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === PARTNER)?.units, 100);
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === DEMO_MERCHANT_ID)?.units, 400);

    assert.throws(
      () => web3.acceptOffer({ offerId: created.offer.id, takerId: PARTNER }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.throws(
      () => web3.cancelOffer(created.offer.id, DEMO_MERCHANT_ID),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.throws(
      () =>
        web3.createOffer({
          networkId: network.id,
          makerId: DEMO_MERCHANT_ID,
          kind: 'CASH_FOR_TOKEN',
          sellSymbol: 'DVPA',
          sellUnits: 10,
          cashCents: 1_000,
          nonce: created.offer.nonce,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );

    const expired = web3.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      kind: 'CASH_FOR_TOKEN',
      sellSymbol: 'DVPA',
      sellUnits: 10,
      cashCents: 1_000,
      now: Date.now() - 7_200_000,
    });
    assert.throws(
      () => web3.acceptOffer({ offerId: expired.offer.id, takerId: PARTNER }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.equal(web3.getOffer(expired.offer.id).status, 'EXPIRED');

    const reserved = web3.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      takerId: LIQUIDATOR,
      kind: 'CASH_FOR_TOKEN',
      sellSymbol: 'DVPA',
      sellUnits: 10,
      cashCents: 1_000,
    });
    assert.throws(
      () => web3.acceptOffer({ offerId: reserved.offer.id, takerId: PARTNER }),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );

    assert.equal(web3.listTrades({ merchantId: PARTNER }).length, 1);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: DVP token-for-token troca unidades sem perna financeira', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const a = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'KNOWLEDGE',
      name: 'Pack A',
      symbol: 'TKNA',
      backingPerUnitCents: 100,
      maxUnits: 10_000,
    }).asset;
    const b = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'KNOWLEDGE',
      name: 'Pack B',
      symbol: 'TKNB',
      backingPerUnitCents: 100,
      maxUnits: 10_000,
    }).asset;
    tokenization.mint({ assetId: a.id, holderId: DEMO_MERCHANT_ID, units: 100 });
    tokenization.mint({ assetId: b.id, holderId: PARTNER, units: 200 });

    const offer = web3.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      kind: 'TOKEN_FOR_TOKEN',
      sellSymbol: 'TKNA',
      sellUnits: 40,
      buySymbol: 'TKNB',
      buyUnits: 80,
    });
    assert.equal(offer.offer.cashCents, 0);

    const settled = web3.acceptOffer({ offerId: offer.offer.id, takerId: PARTNER });
    assert.equal(settled.trade.cashCents, 0);
    assert.equal(settled.trade.feeCents, 0);
    assert.equal(tokenization.getAssetHoldings(a.id).find((row) => row.holderId === PARTNER)?.units, 40);
    assert.equal(tokenization.getAssetHoldings(b.id).find((row) => row.holderId === DEMO_MERCHANT_ID)?.units, 80);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: crédito agro com LTV, oráculo, quitação e liberação do escrow', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const { asset } = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Saca de soja',
      symbol: 'SOJA',
      backingPerUnitCents: 50_000,
      maxUnits: 10_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 200 });
    web3.registerFeed({ symbol: 'SOJA', source: 'XPARTNER', decimals: 2, maxAgeSeconds: 600 });
    web3.publishPrice({ symbol: 'SOJA', priceUnits: 50_000 });

    assert.throws(
      () =>
        web3.openAgroContract({
          networkId: network.id,
          merchantId: DEMO_MERCHANT_ID,
          collateralSymbol: 'SOJA',
          collateralUnits: 100,
          principalCents: 3_500_000,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'AGRO_LTV_EXCEEDED',
    );

    const opened = web3.openAgroContract({
      networkId: network.id,
      merchantId: DEMO_MERCHANT_ID,
      collateralSymbol: 'SOJA',
      collateralUnits: 100,
      principalCents: 1_000_000,
      interestBps: 1_200,
      ltvBps: 6_000,
      liquidationLtvBps: 8_000,
      durationDays: 180,
    });
    assert.equal(opened.contract.principalCents, 1_000_000);
    assert.equal(opened.contract.outstandingCents, 1_120_000);
    assert.equal(opened.contract.collateralValueCents, 5_000_000);
    assert.equal(opened.contract.currentLtvBps, 2_240);
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === 'xpartner:escrow:agro')?.units, 100);
    fundMerchant(db, DEMO_MERCHANT_ID, 1_200_000);

    const partial = web3.repayAgro({ contractId: opened.contract.id, merchantId: DEMO_MERCHANT_ID, amountCents: 120_000 });
    assert.equal(partial.contract.outstandingCents, 1_000_000);
    assert.equal(partial.contract.status, 'OPEN');
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === 'xpartner:escrow:agro')?.units, 100);

    const closed = web3.repayAgro({ contractId: opened.contract.id, merchantId: DEMO_MERCHANT_ID });
    assert.equal(closed.contract.status, 'REPAID');
    assert.equal(closed.contract.outstandingCents, 0);
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === DEMO_MERCHANT_ID)?.units, 200);
    assert.throws(
      () => web3.repayAgro({ contractId: opened.contract.id, merchantId: PARTNER }),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );

    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: staleness bloqueia abertura de crédito agro', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Café',
      symbol: 'CAFE',
      backingPerUnitCents: 10_000,
      maxUnits: 1_000,
    });
    tokenization.mint({
      assetId: tokenization.listAssets(DEMO_MERCHANT_ID).find((row) => row.symbol === 'CAFE')!.id,
      holderId: DEMO_MERCHANT_ID,
      units: 100,
    });
    web3.registerFeed({ symbol: 'CAFE', source: 'BAND', decimals: 2, maxAgeSeconds: 60 });
    web3.publishPrice({
      symbol: 'CAFE',
      priceUnits: 30_000,
      publishedAt: new Date(Date.now() - 600_000).toISOString(),
    });

    assert.throws(
      () =>
        web3.openAgroContract({
          networkId: network.id,
          merchantId: DEMO_MERCHANT_ID,
          collateralSymbol: 'CAFE',
          collateralUnits: 10,
          principalCents: 10_000,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'ORACLE_STALE',
    );
  } finally {
    closeDb(db);
  }
});

test('web3: liquidação permissionless acima do limiar de LTV', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const { asset } = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Boi gordo',
      symbol: 'BOI',
      backingPerUnitCents: 50_000,
      maxUnits: 1_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 100 });
    fundMerchant(db, LIQUIDATOR, 5_000_000);
    web3.registerFeed({ symbol: 'BOI', source: 'XPARTNER', decimals: 2, maxAgeSeconds: 600 });
    web3.publishPrice({ symbol: 'BOI', priceUnits: 50_000 });

    const opened = web3.openAgroContract({
      networkId: network.id,
      merchantId: DEMO_MERCHANT_ID,
      collateralSymbol: 'BOI',
      collateralUnits: 100,
      principalCents: 1_000_000,
      interestBps: 1_200,
      ltvBps: 6_000,
      liquidationLtvBps: 8_000,
      liquidationBonusBps: 2_000,
    });

    assert.throws(
      () => web3.liquidateAgro({ contractId: opened.contract.id, liquidatorId: LIQUIDATOR }),
      (error: unknown) => error instanceof AppError && error.code === 'AGRO_NOT_LIQUIDATABLE',
    );

    web3.publishPrice({ symbol: 'BOI', priceUnits: 10_000 });
    const liquidation = web3.liquidateAgro({ contractId: opened.contract.id, liquidatorId: LIQUIDATOR });
    assert.equal(liquidation.liquidation.debtCents, 1_120_000);
    assert.equal(liquidation.liquidation.collateralValueCents, 1_000_000);
    assert.equal(liquidation.liquidation.ltvBps, 11_200);
    assert.equal(liquidation.contract.status, 'LIQUIDATED');
    assert.equal(tokenization.getAssetHoldings(asset.id).find((row) => row.holderId === LIQUIDATOR)?.units, 100);
    assert.equal(web3.overview(DEMO_MERCHANT_ID).agro.liquidatable, 0);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: atestação de predicado com nullifier impede reuso e revogação encerra', () => {
  const db = testDb();
  try {
    const { web3 } = setup(db);
    const commitment = 'a'.repeat(64);
    const attestation = web3.attestClaim({
      commitment,
      claimType: 'RENDA_MENSAL',
      predicate: 'GTE',
      threshold: 500_000,
      issuer: 'bank@xpartner.example',
      expiresInSeconds: 86_400,
    });
    assert.equal(attestation.attestation.status, 'ACTIVE');
    assert.equal(attestation.attestation.attestationHash.length, 64);

    const verified = web3.verifyClaim({
      attestationId: attestation.attestation.id,
      purpose: 'analise-credito',
      relyingParty: DEMO_MERCHANT_ID,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.disclosed.claimType, 'RENDA_MENSAL');
    assert.equal(verified.disclosed.predicate, 'GTE');
    assert.equal(verified.disclosed.threshold, 500_000);

    assert.throws(
      () =>
        web3.verifyClaim({
          attestationId: attestation.attestation.id,
          purpose: 'analise-credito',
          relyingParty: DEMO_MERCHANT_ID,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'ZK_NULLIFIER_REUSED',
    );

    const otherPurpose = web3.verifyClaim({
      attestationId: attestation.attestation.id,
      purpose: 'limite-pix',
      relyingParty: DEMO_MERCHANT_ID,
    });
    assert.equal(otherPurpose.verified, true);

    const shortLived = web3.attestClaim({
      commitment: 'b'.repeat(64),
      claimType: 'KYC_STATUS',
      predicate: 'EQ',
      threshold: 2,
      issuer: 'bank@xpartner.example',
      expiresInSeconds: 60,
    });
    assert.throws(
      () =>
        web3.verifyClaim({
          attestationId: shortLived.attestation.id,
          purpose: 'onboarding',
          now: Date.now() + 120_000,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );

    const revoked = web3.revokeAttestation(attestation.attestation.id, 'compliance');
    assert.equal(revoked.attestation.status, 'REVOKED');
    assert.throws(
      () => web3.verifyClaim({ attestationId: attestation.attestation.id, purpose: 'novo-uso' }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.equal(web3.listVerifications().length, 2);
    assert.equal(web3.listAttestations(commitment).length, 1);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: session key de agente obedece seletores, tetos, autonomia e expiração', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const { policy } = tokenization.createAgentPolicy({
      merchantId: DEMO_MERCHANT_ID,
      name: 'Agente DVP',
      allowedSymbols: ['DVPA'],
      maxNotionalCents: 50_000,
      dailyLimitCents: 60_000,
      humanApprovalAboveCents: 20_000,
    });
    const granted = web3.grantAgentSession({
      policyId: policy.id,
      merchantId: DEMO_MERCHANT_ID,
      networkId: network.id,
      agent: 'agent.tesouraria',
      allowedSelectors: ['0x12345678'],
      spendCapCents: 30_000,
      ttlSeconds: 3_600,
    });
    assert.equal(typeof granted.sessionKey, 'string');
    assert.equal('sessionKey' in granted.session, false);
    assert.equal('keyHash' in granted.session, false);
    assert.equal(web3.listAgentSessions({ merchantId: DEMO_MERCHANT_ID }).length, 1);

    const run = (overrides: Record<string, unknown> = {}) =>
      web3.authorizeAgentAction({
        sessionId: granted.session.id,
        sessionKey: granted.sessionKey,
        action: 'BUY',
        selector: '0x12345678',
        symbol: 'DVPA',
        notionalCents: 5_000,
        ...overrides,
      });

    assert.equal(run().decision.decision, 'APPROVE');
    assert.equal(run({ notionalCents: 25_000 }).decision.decision, 'REVIEW');
    assert.equal(run({ notionalCents: 25_000, humanApproved: true }).decision.decision, 'APPROVE');
    assert.equal(run({ notionalCents: 1_000 }).decision.decision, 'BLOCK');
    assert.equal(run({ selector: '0x87654321', notionalCents: 100 }).decision.decision, 'BLOCK');
    assert.equal(run({ symbol: 'TKNX', notionalCents: 100 }).decision.decision, 'BLOCK');
    assert.throws(
      () => run({ sessionKey: 'chave-errada' }),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );

    const expired = web3.grantAgentSession({
      policyId: policy.id,
      merchantId: DEMO_MERCHANT_ID,
      networkId: network.id,
      agent: 'agent.efemero',
      allowedSelectors: ['0x12345678'],
      spendCapCents: 10_000,
      ttlSeconds: 300,
    });
    assert.throws(
      () =>
        web3.authorizeAgentAction({
          sessionId: expired.session.id,
          sessionKey: expired.sessionKey,
          action: 'BUY',
          selector: '0x12345678',
          symbol: 'DVPA',
          notionalCents: 100,
          now: Date.now() + 400_000,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.equal(web3.listAgentSessions({ merchantId: DEMO_MERCHANT_ID }).find((row) => row.id === expired.session.id)?.status, 'EXPIRED');

    const revoked = web3.revokeAgentSession(granted.session.id, DEMO_MERCHANT_ID);
    assert.equal(revoked.session.status, 'REVOKED');
    assert.throws(
      () => run(),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.equal(web3.overview(DEMO_MERCHANT_ID).agents.spentCents, 30_000);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: paymaster respeita teto por UserOp, teto global e anti-replay', () => {
  const db = testDb();
  try {
    const { web3, network } = setup(db);
    const { budget } = web3.createPaymasterBudget({
      merchantId: DEMO_MERCHANT_ID,
      networkId: network.id,
      label: 'Gas patrocinado',
      capCents: 100_000,
      perOpMaxCents: 30_000,
    });

    const op = (hash: string, gasCents: number) =>
      web3.sponsorUserOp({ budgetId: budget.id, merchantId: DEMO_MERCHANT_ID, userOpHash: hash, gasCents });

    assert.equal(op(`0x${'1'.repeat(64)}`, 20_000).op.gasCents, 20_000);
    assert.throws(
      () => op(`0x${'1'.repeat(64)}`, 10_000),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    assert.throws(
      () => op(`0x${'2'.repeat(64)}`, 40_000),
      (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_OP_LIMIT',
    );
    assert.equal(op(`0x${'3'.repeat(64)}`, 30_000).budget.spentCents, 50_000);
    assert.equal(op(`0x${'4'.repeat(64)}`, 30_000).budget.spentCents, 80_000);
    assert.throws(
      () => op(`0x${'5'.repeat(64)}`, 30_000),
      (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_CAP_EXCEEDED',
    );
    assert.equal(web3.listPaymasterOps({ merchantId: DEMO_MERCHANT_ID }).length, 3);
    const overview = web3.overview(DEMO_MERCHANT_ID);
    assert.equal(overview.paymaster.budgets, 1);
    assert.equal(overview.paymaster.spentCents, 80_000);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

test('web3: overview consolida DVP, agro, ZK, agentes e âncoras', () => {
  const db = testDb();
  try {
    const { tokenization, web3, network } = setup(db);
    const { asset } = tokenization.createAsset({
      merchantId: DEMO_MERCHANT_ID,
      kind: 'RWA',
      name: 'Cesta overview',
      symbol: 'OVW',
      backingPerUnitCents: 1_000,
      maxUnits: 1_000,
    });
    tokenization.mint({ assetId: asset.id, holderId: DEMO_MERCHANT_ID, units: 100 });
    web3.createOffer({
      networkId: network.id,
      makerId: DEMO_MERCHANT_ID,
      kind: 'CASH_FOR_TOKEN',
      sellSymbol: 'OVW',
      sellUnits: 10,
      cashCents: 1_000,
    });

    const overview = web3.overview(DEMO_MERCHANT_ID);
    assert.equal(overview.networks, 1);
    assert.equal(overview.dvp.offers, 1);
    assert.equal(overview.dvp.openOffers, 1);
    assert.equal(overview.dvp.cashVolumeCents, 0);
    assert.equal(overview.agro.contracts, 0);
    assert.equal(overview.zk.attestations, 0);
    assert.equal(overview.agents.sessions, 0);
    assert.ok(overview.anchors.height >= 1);
    assert.equal(trialBalance(db).balanced, true);
  } finally {
    closeDb(db);
  }
});

test('web3: seed de demonstração registra appchain, oráculo, DVP, ZK e paymaster', () => {
  const config = testConfig({ SEED_DEMO: 'true' });
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedCore(db);
    const tokenization = new TokenizationHub(db);
    const web3 = new Web3Hub(db);
    seedTokenization(db, tokenization, config);
    seedWeb3(db, web3, config);

    assert.equal(web3.listNetworks().length, 2);
    const soja = web3.listFeeds().find((feed) => feed.symbol === 'SOJA');
    assert.equal(soja?.latest?.centsPerUnit, 13_500);

    const overview = web3.overview(DEMO_MERCHANT_ID);
    assert.equal(overview.dvp.openOffers, 1);
    assert.equal(overview.zk.attestations, 1);
    assert.equal(overview.zk.verifications, 1);
    assert.equal(overview.paymaster.budgets, 1);
    assert.equal(overview.anchors.height > 0, true);

    seedWeb3(db, web3, config);
    assert.equal(web3.listNetworks().length, 2);
    assert.equal(trialBalance(db).balanced, true);
    assert.equal(verifyAnchorChain(db).valid, true);
  } finally {
    closeDb(db);
  }
});

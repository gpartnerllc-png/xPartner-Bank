import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALADDIN_MAX_VAR_BPS,
  creditScoreFrom,
  ccipMessageId,
  domainSeparator,
  dvpOfferDigest,
  intentDigest,
  loanToValueBps,
  maxLoanForScore,
  nullifierFor,
  oracleCentsPerUnit,
  sessionKeyHash,
  simulateMonteCarlo,
  solverScore,
} from '../src/web3-domain.ts';

test('Monte Carlo é determinístico para o mesmo seed e janela', async () => {
  const seedParts = ['holder-1', '2026-11-02'];
  const first = await simulateMonteCarlo({ seedParts, samples: 500, confidenceBps: 9_900 });
  const second = await simulateMonteCarlo({ seedParts, samples: 500, confidenceBps: 9_900 });
  const other = await simulateMonteCarlo({ seedParts: ['holder-2', '2026-11-02'], samples: 500, confidenceBps: 9_900 });
  assert.deepEqual(first, second);
  assert.notEqual(first.varBps, other.varBps);
  assert.equal(first.sampleSize, 500);
  assert.ok(first.varBps >= 0 && first.varBps <= 10_000);
});

test('Monte Carlo rejeita parâmetros fora da faixa auditada', async () => {
  await assert.rejects(() => simulateMonteCarlo({ seedParts: ['x'], samples: 99 }), /samples/);
  await assert.rejects(() => simulateMonteCarlo({ seedParts: ['x'], confidenceBps: 5_000 - 1 }), /confidenceBps/);
  await assert.rejects(() => simulateMonteCarlo({ seedParts: ['x'], volatilityBps: 0 }), /volatilityBps/);
  await assert.rejects(() => simulateMonteCarlo({ seedParts: ['x'], driftBps: 9_999 }), /driftBps/);
});

test('score de crédito premia colateral, liquidez e pontualidade', () => {
  const base = creditScoreFrom({ varBps: 400, volatilityBps: 300 });
  const premium = creditScoreFrom({
    varBps: 100,
    volatilityBps: 100,
    liquidityCents: 20_000_000,
    hasCollateral: true,
    onTimeRatioBps: 9_500,
  });
  assert.ok(premium > base);
  assert.ok(base >= 0 && base <= 10_000);
  assert.ok(premium <= 10_000);
});

test('teto de empréstimo acompanha o tier do score', () => {
  assert.equal(maxLoanForScore(9_500), 20_000_000);
  assert.equal(maxLoanForScore(8_500), 10_000_000);
  assert.equal(maxLoanForScore(7_200), 5_000_000);
  assert.equal(maxLoanForScore(6_999), 0);
});

test('VaR máximo do Aladdin continua 25%', () => {
  assert.equal(ALADDIN_MAX_VAR_BPS, 2_500);
});

test('score do solver prioriza preço sobre latência e risco', () => {
  const good = solverScore({ amountUnits: 1_000, destUnits: 995, feeCents: 100, feeBudgetCents: 1_000, etaSeconds: 30, riskBps: 50 });
  const expensive = solverScore({ amountUnits: 1_000, destUnits: 900, feeCents: 900, feeBudgetCents: 1_000, etaSeconds: 300, riskBps: 1_200 });
  assert.ok(good > expensive);
  assert.ok(good <= 10_000 && expensive >= 0);
});

test('oráculo converte fixed-point em centavos e rejeita entradas inválidas', () => {
  assert.equal(oracleCentsPerUnit(13_500, 2), 13_500);
  assert.equal(oracleCentsPerUnit(1_000_000, 8), 1);
  assert.throws(() => oracleCentsPerUnit(0, 2), /ORACLE_PRICE|Preço/);
  assert.throws(() => oracleCentsPerUnit(100, 9), /Decimais/);
});

test('LTV trata dívida e colateral zero nos extremos', () => {
  assert.equal(loanToValueBps(0, 500_000), 0);
  assert.equal(loanToValueBps(100_000, 0), 10_000);
  assert.equal(loanToValueBps(300_000, 600_000), 5_000);
});

test('digests Web3 são estáveis e sensíveis ao conteúdo', async () => {
  const intent = {
    holderId: 'bank_user_1',
    laneId: 'lane-1',
    symbol: 'NFCR',
    amountUnits: 10,
    minDestUnits: 9,
    feeBudgetCents: 500,
    deadline: '2026-11-03T00:00:00.000Z',
  };
  assert.equal(await intentDigest(intent), await intentDigest({ ...intent }));
  assert.notEqual(await intentDigest(intent), await intentDigest({ ...intent, amountUnits: 11 }));
  assert.match(await intentDigest(intent), /^[0-9a-f]{64}$/);

  assert.equal(
    await ccipMessageId({ laneId: 'l', sequence: 1, intentId: 'i', receiver: 'r', symbol: 'NFCR', amountUnits: 1 }),
    await ccipMessageId({ laneId: 'l', sequence: 1, intentId: 'i', receiver: 'r', symbol: 'NFCR', amountUnits: 1 }),
  );
  assert.equal(await nullifierFor('c', 'NET_WORTH', '2026-11-02'), await nullifierFor('c', 'NET_WORTH', '2026-11-02'));
  assert.notEqual(await sessionKeyHash('a'), await sessionKeyHash('b'));
});

test('domínio EIP-712 e digest de oferta DVP são determinísticos', async () => {
  const contract = '0x00000000000000000000000000000000000000AA';
  assert.equal(await domainSeparator(771001, contract), await domainSeparator(771001, contract.toLowerCase()));
  const offer = {
    maker: '0x00000000000000000000000000000000000000BB',
    taker: null,
    sellSymbol: 'NFCR',
    sellUnits: 10,
    buySymbol: null,
    buyUnits: null,
    cashCents: 995_000,
    feeBps: 10,
    nonce: 'seed-dvp-1',
    expiresAt: '2026-11-03T00:00:00.000Z',
  };
  const digest = await dvpOfferDigest({ chainId: 771001, verifyingContract: contract }, offer);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, await dvpOfferDigest({ chainId: 771001, verifyingContract: contract }, offer));
  assert.notEqual(digest, await dvpOfferDigest({ chainId: 771001, verifyingContract: contract }, { ...offer, cashCents: 1 }));
});

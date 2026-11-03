import { sha256Hex } from '../kernel/crypto.ts';

/** Limites do motor Aladdin — espelhados pelos guardrails do contrato de referência. */
export const ALADDIN_MIN_SCORE = 7_000;
export const ALADDIN_MAX_VAR_BPS = 2_500;
export const ALADDIN_MAX_VOLATILITY_BPS = 100_000;
export const ALADDIN_MAX_LOAN_CENTS = 20_000_000;
export const ALADDIN_LOAN_SCORE_TIERS = [
  { minScore: 9_000, maxCents: 20_000_000 },
  { minScore: 8_000, maxCents: 10_000_000 },
  { minScore: 7_000, maxCents: 5_000_000 },
] as const;
export const CCIP_ESCROW_HOLDER = 'xpartner:escrow:ccip';
export const AI_SOLVER_MODEL = 'aladdin-intent-solver-v1';

export interface RiskInputs {
  merchantId: string;
  model: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  sampleSize: number;
  varBps: number;
  volatilityBps: number;
  creditScore: number;
}

/** Seed determinístico para o Monte Carlo: mesma carteira e mesma janela, mesmo resultado. */
export function prngSeed(...parts: Array<string | number>): number {
  const hex = sha256Hex(`xpartner:aladdin:prng:v1:${parts.join('|')}`);
  return Number.parseInt(hex.slice(0, 13), 16) >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulação de Monte Carlo determinística para VaR diário.
 * Retornos em pontos base: `volatilityBps = 200` equivale a 2% de desvio diário.
 * Não é um modelo preditivo auditado; é o núcleo quantitativo reproduzível do agente.
 */
export function simulateMonteCarlo(input: {
  seedParts: Array<string | number>;
  samples?: number;
  confidenceBps?: number;
  driftBps?: number;
  volatilityBps?: number;
}): { varBps: number; volatilityBps: number; meanBps: number; sampleSize: number; confidenceBps: number } {
  const samples = input.samples ?? 2_000;
  if (!Number.isSafeInteger(samples) || samples < 100 || samples > 50_000) {
    throw new Error('samples deve estar entre 100 e 50000');
  }
  const confidenceBps = input.confidenceBps ?? 9_900;
  if (!Number.isSafeInteger(confidenceBps) || confidenceBps < 5_000 || confidenceBps > 9_999) {
    throw new Error('confidenceBps deve estar entre 5000 e 9999');
  }
  const driftBps = input.driftBps ?? 5;
  const volatilityBps = input.volatilityBps ?? 250;
  if (!Number.isSafeInteger(driftBps) || driftBps < -5_000 || driftBps > 5_000) {
    throw new Error('driftBps inválido');
  }
  if (!Number.isSafeInteger(volatilityBps) || volatilityBps <= 0 || volatilityBps > ALADDIN_MAX_VOLATILITY_BPS) {
    throw new Error('volatilityBps inválido');
  }

  const random = mulberry32(prngSeed(...input.seedParts));
  const returns: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    returns.push(driftBps + volatilityBps * normal);
  }
  returns.sort((a, b) => a - b);
  const tailIndex = Math.min(samples - 1, Math.floor(samples * (1 - confidenceBps / 10_000)));
  const tail = returns[tailIndex] ?? 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / samples;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples;
  return {
    varBps: Math.min(10_000, Math.max(0, Math.round(Math.abs(tail)))),
    volatilityBps: Math.min(ALADDIN_MAX_VOLATILITY_BPS, Math.round(Math.sqrt(variance))),
    meanBps: Math.round(mean),
    sampleSize: samples,
    confidenceBps,
  };
}

/** Score composto 0–10.000: penaliza VaR/volatilidade e premia liquidez, colateral e pontualidade. */
export function creditScoreFrom(input: {
  varBps: number;
  volatilityBps: number;
  liquidityCents?: number;
  hasCollateral?: boolean;
  onTimeRatioBps?: number;
}): number {
  const liquidity = Math.max(0, input.liquidityCents ?? 0);
  const onTime = Math.min(10_000, Math.max(0, input.onTimeRatioBps ?? 7_500));
  const raw =
    6_000 -
    Math.min(2_000, Math.floor(input.varBps * 0.8)) -
    Math.min(1_500, Math.floor(input.volatilityBps * 0.25)) +
    Math.min(1_000, Math.floor(liquidity / 1_000_000) * 50) +
    (input.hasCollateral ? 500 : 0) +
    Math.round((onTime - 7_500) / 10);
  return Math.min(10_000, Math.max(0, raw));
}

export function riskDigest(input: RiskInputs): string {
  return sha256Hex(
    `xpartner:aladdin:risk:v1:${input.merchantId}:${input.varBps}:${input.volatilityBps}:` +
      `${input.creditScore}:${input.model}:${input.source}:${input.sampleSize}:${input.observedAt}:${input.expiresAt}`,
  );
}

/** Maior principal permitido pelo score, dentro do teto global. */
export function maxLoanForScore(score: number): number {
  for (const tier of ALADDIN_LOAN_SCORE_TIERS) {
    if (score >= tier.minScore) return Math.min(tier.maxCents, ALADDIN_MAX_LOAN_CENTS);
  }
  return 0;
}

export function intentDigest(input: {
  merchantId: string;
  laneId: string;
  symbol: string;
  amountUnits: number;
  minDestUnits: number;
  feeBudgetCents: number;
  deadline: string;
}): string {
  return sha256Hex(
    `xpartner:intent:v1:${input.merchantId}:${input.laneId}:${input.symbol}:${input.amountUnits}:` +
      `${input.minDestUnits}:${input.feeBudgetCents}:${input.deadline}`,
  );
}

/** Score do solver: preço, taxa, latência e risco, com pesos fixos e auditáveis. */
export function solverScore(input: {
  amountUnits: number;
  destUnits: number;
  feeCents: number;
  feeBudgetCents: number;
  etaSeconds: number;
  riskBps: number;
}): number {
  const priceScore = Math.min(10_000, Math.floor((input.destUnits * 10_000) / input.amountUnits));
  const feeScore =
    input.feeBudgetCents > 0
      ? Math.max(0, 10_000 - Math.min(10_000, Math.floor((input.feeCents * 10_000) / input.feeBudgetCents)))
      : 10_000;
  const speedScore = Math.max(0, 10_000 - input.etaSeconds * 2);
  const riskScore = Math.max(0, 10_000 - input.riskBps);
  return Math.min(
    10_000,
    Math.max(0, Math.round(priceScore * 0.45 + feeScore * 0.2 + speedScore * 0.2 + riskScore * 0.15)),
  );
}

export function ccipMessageId(input: {
  laneId: string;
  sequence: number;
  intentId: string;
  receiver: string;
  symbol: string;
  amountUnits: number;
}): string {
  return sha256Hex(
    `xpartner:ccip:v1:${input.laneId}:${input.sequence}:${input.intentId}:${input.receiver}:` +
      `${input.symbol}:${input.amountUnits}`,
  );
}

export function proofDigest(proof: unknown, publicSignals: string[]): string {
  return sha256Hex(`xpartner:zk:groth16:v1:${JSON.stringify(proof)}|${publicSignals.join(',')}`);
}

import { sha256Hex } from './security.ts';
import { HttpError } from './http.ts';

/**
 * Primitivas do motor Aladdin no edge. As fórmulas são as mesmas do core Node:
 * Monte Carlo determinístico, score composto, teto por score, score de solver,
 * digests de risco, intenção, mensagem CCIP e oferta DVP.
 *
 * O edge usa SHA-256 via WebCrypto (assíncrono) e FNV/sha256 para a semente do
 * PRNG. Mesma carteira e mesma janela produzem o mesmo resultado no edge; o core
 * continua sendo a referência criptográfica das provas Groth16.
 */

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
export const AGRO_ESCROW_HOLDER = 'xpartner:escrow:agro';
export const AI_SOLVER_MODEL = 'aladdin-intent-solver-v1';
export const DVP_DOMAIN_NAME = 'xPartner Atomic DVP';
export const DVP_DOMAIN_VERSION = '1';

export function invalid(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(422, code, message, details);
}

export function positiveInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw invalid('WEB3_VALUE', `${field} deve ser inteiro entre 1 e ${max}.`);
  }
  return parsed;
}

export function optInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalid('WEB3_VALUE', `${field} deve ser inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}

export function requiredText(value: unknown, field: string, max = 120): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw invalid('WEB3_TEXT', `${field} é obrigatório (até ${max} caracteres).`);
  return text;
}

export function symbol(value: unknown, field = 'symbol'): string {
  const text = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(text)) {
    throw invalid('WEB3_SYMBOL', `${field} deve ter de 3 a 12 caracteres alfanuméricos.`);
  }
  return text;
}

export function evmAddress(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    throw invalid('WEB3_ADDRESS', `${field} deve ser um endereço EVM (0x + 40 hexadecimais).`);
  }
  return text.toLowerCase();
}

export function decimalSelector(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) > 2n ** 64n - 1n) {
    throw invalid('CCIP_SELECTOR', `${field} deve ser uint64 em decimal.`);
  }
  return text;
}

export function isoDateOrThrow(value: unknown, field: string, fallbackMs?: number): string {
  const text = value === undefined || value === null || value === '' ? '' : String(value);
  if (!text && fallbackMs !== undefined) return new Date(fallbackMs).toISOString();
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw invalid('WEB3_DATE', `${field} deve ser data ISO válida.`);
  return new Date(ms).toISOString();
}

export function todayEpoch(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function prngSeed(...parts: Array<string | number>): Promise<number> {
  const hex = await sha256Hex(`xpartner:aladdin:prng:v1:${parts.join('|')}`);
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

export async function simulateMonteCarlo(input: {
  seedParts: Array<string | number>;
  samples?: number;
  confidenceBps?: number;
  driftBps?: number;
  volatilityBps?: number;
}): Promise<{ varBps: number; volatilityBps: number; meanBps: number; sampleSize: number; confidenceBps: number }> {
  const samples = input.samples ?? 2_000;
  if (!Number.isSafeInteger(samples) || samples < 100 || samples > 50_000) {
    throw invalid('ALADDIN_SAMPLES', 'samples deve estar entre 100 e 50000.');
  }
  const confidenceBps = input.confidenceBps ?? 9_900;
  if (!Number.isSafeInteger(confidenceBps) || confidenceBps < 5_000 || confidenceBps > 9_999) {
    throw invalid('ALADDIN_CONFIDENCE', 'confidenceBps deve estar entre 5000 e 9999.');
  }
  const driftBps = input.driftBps ?? 5;
  const volatilityBps = input.volatilityBps ?? 250;
  if (!Number.isSafeInteger(driftBps) || driftBps < -5_000 || driftBps > 5_000) {
    throw invalid('ALADDIN_DRIFT', 'driftBps deve estar entre -5000 e 5000.');
  }
  if (!Number.isSafeInteger(volatilityBps) || volatilityBps <= 0 || volatilityBps > ALADDIN_MAX_VOLATILITY_BPS) {
    throw invalid('ALADDIN_VOLATILITY', `volatilityBps deve estar entre 1 e ${ALADDIN_MAX_VOLATILITY_BPS}.`);
  }

  const random = mulberry32(await prngSeed(...input.seedParts));
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

export function maxLoanForScore(score: number): number {
  for (const tier of ALADDIN_LOAN_SCORE_TIERS) {
    if (score >= tier.minScore) return Math.min(tier.maxCents, ALADDIN_MAX_LOAN_CENTS);
  }
  return 0;
}

/** Score do solver: preço 45%, taxa 20%, latência 20%, risco 15%. */
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

export function oracleCentsPerUnit(priceUnits: number, decimals: number): number {
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) {
    throw invalid('ORACLE_PRICE', 'Preço do oráculo inválido.');
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 8) {
    throw invalid('ORACLE_DECIMALS', 'Decimais do oráculo inválidos.');
  }
  const cents = Math.round((priceUnits * 100) / 10 ** decimals);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw invalid('ORACLE_PRICE', 'Preço do oráculo excede o limite numérico.');
  }
  return cents;
}

export function loanToValueBps(debtCents: number, collateralCents: number): number {
  if (debtCents <= 0) return 0;
  if (collateralCents <= 0) return 10_000;
  return Math.round((debtCents * 10_000) / collateralCents);
}

export function riskDigest(input: {
  holderId: string;
  varBps: number;
  volatilityBps: number;
  creditScore: number;
  model: string;
  source: string;
  sampleSize: number;
  observedAt: string;
  expiresAt: string;
}): Promise<string> {
  return sha256Hex(
    `xpartner:aladdin:risk:v1:${input.holderId}:${input.varBps}:${input.volatilityBps}:` +
      `${input.creditScore}:${input.model}:${input.source}:${input.sampleSize}:${input.observedAt}:${input.expiresAt}`,
  );
}

export function intentDigest(input: {
  holderId: string;
  laneId: string;
  symbol: string;
  amountUnits: number;
  minDestUnits: number;
  feeBudgetCents: number;
  deadline: string;
}): Promise<string> {
  return sha256Hex(
    `xpartner:intent:v1:${input.holderId}:${input.laneId}:${input.symbol}:${input.amountUnits}:` +
      `${input.minDestUnits}:${input.feeBudgetCents}:${input.deadline}`,
  );
}

export function ccipMessageId(input: {
  laneId: string;
  sequence: number;
  intentId: string;
  receiver: string;
  symbol: string;
  amountUnits: number;
}): Promise<string> {
  return sha256Hex(
    `xpartner:ccip:v1:${input.laneId}:${input.sequence}:${input.intentId}:${input.receiver}:` +
      `${input.symbol}:${input.amountUnits}`,
  );
}

export function domainSeparator(chainId: number, verifyingContract: string): Promise<string> {
  return sha256Hex(
    `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` +
      `|${DVP_DOMAIN_NAME}|${DVP_DOMAIN_VERSION}|${chainId}|${verifyingContract.toLowerCase()}`,
  );
}

export async function dvpOfferDigest(
  domain: { chainId: number; verifyingContract: string },
  offer: {
    maker: string;
    taker: string | null;
    sellSymbol: string;
    sellUnits: number;
    buySymbol: string | null;
    buyUnits: number | null;
    cashCents: number;
    feeBps: number;
    nonce: string;
    expiresAt: string;
  },
): Promise<string> {
  const struct = {
    maker: offer.maker.toLowerCase(),
    taker: (offer.taker ?? '').toLowerCase(),
    sellSymbol: offer.sellSymbol,
    sellUnits: offer.sellUnits,
    buySymbol: offer.buySymbol ?? '',
    buyUnits: offer.buyUnits ?? 0,
    cashCents: offer.cashCents,
    feeBps: offer.feeBps,
    nonce: offer.nonce,
    expiresAt: offer.expiresAt,
  };
  return sha256Hex(`${await domainSeparator(domain.chainId, domain.verifyingContract)}|${JSON.stringify(struct)}`);
}

export function attestationHash(input: {
  commitment: string;
  claimType: string;
  predicate: string;
  threshold: number;
  issuer: string;
  expiresAt: string;
}): Promise<string> {
  return sha256Hex(
    `xpartner:attest:v1:${input.commitment}:${input.claimType}:${input.predicate}:${input.threshold}:` +
      `${input.issuer}:${input.expiresAt}`,
  );
}

export function nullifierFor(commitment: string, purpose: string, epoch: string): Promise<string> {
  return sha256Hex(`xpartner:nullifier:v1:${commitment}:${purpose}:${epoch}`);
}

export function sessionKeyHash(sessionKey: string): Promise<string> {
  return sha256Hex(`xpartner:agent-session:v1:${sessionKey}`);
}

export function actionDigest(input: {
  sessionId: string;
  selector: string;
  symbol: string;
  amountCents: number;
  decision: string;
}): Promise<string> {
  return sha256Hex(
    `xpartner:agent-action:v1:${input.sessionId}:${input.selector}:${input.symbol}:` +
      `${input.amountCents}:${input.decision}`,
  );
}

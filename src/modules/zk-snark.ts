import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as SnarkjsModule from 'snarkjs';
import { AppError } from '../kernel/errors.ts';

/**
 * Prova de predicado patrimonial com Groth16/BN254 (Circom + SnarkJS).
 *
 * A prova real é gerada no cliente com `NetWorthProof.wasm` e `NetWorthProof.zkey`
 * e verificada aqui com a verification key pública. O core nunca vê `netWorth`:
 * só o compromisso Poseidon, o limiar público e o resultado booleano.
 *
 * Os artefatos são de demonstração (cerimônia local de uma contribuição).
 * Produção exige cerimônia multi-participante auditada e distribuição dos hashes.
 */

const DEFAULT_ARTIFACT_DIR = fileURLToPath(new URL('../../circuits/build/', import.meta.url));
const CIRCUIT = 'NetWorthProof';
const DECIMAL = /^(0|[1-9][0-9]{0,76})$/;
const MAX_PROOF_SIGNAL = 2n ** 254n;

export const ZK_CIRCUIT = CIRCUIT;

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface NetWorthProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  commitment: string;
  thresholdCents: number;
  satisfied: boolean;
}

export interface NetWorthVerification {
  verified: boolean;
  commitment: string | null;
  thresholdCents: number | null;
  satisfied: boolean;
}

function artifactDir(): string {
  return process.env.XPARTNER_ZK_ARTIFACTS?.trim() || DEFAULT_ARTIFACT_DIR;
}

let snarkjsPromise: Promise<typeof SnarkjsModule> | undefined;
function snarkjs(): Promise<typeof SnarkjsModule> {
  snarkjsPromise ??= import('snarkjs');
  return snarkjsPromise;
}

interface CurveHandle {
  terminate?: () => Promise<void>;
}
function currentCurve(): CurveHandle | undefined {
  return (globalThis as unknown as { curve_bn128?: CurveHandle }).curve_bn128;
}

async function releaseCurve(): Promise<void> {
  const curve = currentCurve();
  if (curve?.terminate) await curve.terminate();
}

/** SnarkJS usa estado global por curva; serializa para nunca encerrar uma prova em andamento. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseSignal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new AppError('ZK_INVALID_PROOF', `${field} deve ser um inteiro decimal positivo.`, 422);
  }
  const parsed = BigInt(value);
  if (parsed >= MAX_PROOF_SIGNAL) {
    throw new AppError('ZK_INVALID_PROOF', `${field} excede o corpo do BN254.`, 422);
  }
  return parsed;
}

function ensureStringArray(value: unknown, length: number, field: string): string[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === 'string')) {
    throw new AppError('ZK_INVALID_PROOF', `${field} deve ter ${length} elementos hexadecimais.`, 422);
  }
  return value as string[];
}

/** Valida a forma do proof antes de tocar no verificador — evita crashes e entrada malformada. */
export function normalizeProof(value: unknown): Groth16Proof {
  const candidate = value as Partial<Groth16Proof> | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw new AppError('ZK_INVALID_PROOF', 'Prova ausente ou malformada.', 422);
  }
  if (candidate.protocol !== 'groth16' || candidate.curve !== 'bn128') {
    throw new AppError('ZK_INVALID_PROOF', 'Somente provas Groth16 em BN254 são aceitas.', 422);
  }
  const piA = ensureStringArray(candidate.pi_a, 3, 'pi_a');
  const piC = ensureStringArray(candidate.pi_c, 3, 'pi_c');
  if (!Array.isArray(candidate.pi_b) || candidate.pi_b.length !== 3) {
    throw new AppError('ZK_INVALID_PROOF', 'pi_b deve ter 3 linhas.', 422);
  }
  const piB = candidate.pi_b.map((row, index) => ensureStringArray(row, 2, `pi_b[${index}]`));
  for (const point of [piA, piC, ...piB]) {
    for (const coordinate of point) if (!DECIMAL.test(coordinate)) {
      throw new AppError('ZK_INVALID_PROOF', 'Coordenada de prova inválida.', 422);
    }
  }
  return { ...candidate, pi_a: piA, pi_b: piB, pi_c: piC, protocol: 'groth16', curve: 'bn128' };
}

export function normalizeSignals(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new AppError('ZK_INVALID_PROOF', 'publicSignals deve ter 3 posições.', 422);
  }
  return value.map((signal, index) => parseSignal(signal, `publicSignals[${index}]`).toString());
}

/**
 * Verifica uma prova de patrimônio. O chamador precisa informar o limiar acordado;
 * o compromisso, quando esperado, precisa bater com o sinal público.
 */
export async function verifyNetWorthProof(input: {
  proof: unknown;
  publicSignals: unknown;
  expectedThresholdCents: number;
  expectedCommitment?: string;
}): Promise<NetWorthVerification> {
  if (!Number.isSafeInteger(input.expectedThresholdCents) || input.expectedThresholdCents <= 0) {
    throw new AppError('ZK_INVALID_PROOF', 'Limiar esperado inválido.', 422);
  }
  const proof = normalizeProof(input.proof);
  const publicSignals = normalizeSignals(input.publicSignals);
  if (parseSignal(publicSignals[1], 'satisfied') !== 1n) {
    throw new AppError('ZK_INVALID_PROOF', 'A prova não satisfaz o predicado.', 422);
  }
  if (parseSignal(publicSignals[2], 'threshold') !== BigInt(input.expectedThresholdCents)) {
    throw new AppError('ZK_INVALID_PROOF', 'Limiar público diferente do esperado.', 422);
  }
  if (input.expectedCommitment) {
    const expected = parseSignal(
      /^[0-9a-f]{64}$/i.test(input.expectedCommitment)
        ? BigInt(`0x${input.expectedCommitment}`).toString()
        : input.expectedCommitment,
      'commitment',
    );
    if (parseSignal(publicSignals[0], 'commitment') !== expected) {
      throw new AppError('ZK_INVALID_PROOF', 'Compromisso da prova não corresponde ao titular.', 422);
    }
  }

  const verificationKey = JSON.parse(
    await readFile(path.join(artifactDir(), 'verification_key.json'), 'utf8'),
  ) as unknown;
  const { groth16 } = await snarkjs();
  const verified = await serialized(async () => {
    try {
      return await groth16.verify(verificationKey, publicSignals, proof);
    } finally {
      await releaseCurve();
    }
  });

  return {
    verified,
    commitment: verified ? publicSignals[0] : null,
    thresholdCents: verified ? Number(publicSignals[2]) : null,
    satisfied: verified,
  };
}

/**
 * Gera a prova a partir da testemunha. Em produção isso acontece no dispositivo do
 * cliente; a rota demo existe para demonstrar a integração ponta a ponta.
 */
export async function proveNetWorth(input: {
  netWorthCents: number;
  salt: string;
  thresholdCents: number;
}): Promise<NetWorthProofResult> {
  if (!Number.isSafeInteger(input.netWorthCents) || input.netWorthCents < 0) {
    throw new AppError('ZK_INVALID_WITNESS', 'netWorthCents deve ser inteiro não negativo.', 422);
  }
  if (!Number.isSafeInteger(input.thresholdCents) || input.thresholdCents <= 0) {
    throw new AppError('ZK_INVALID_WITNESS', 'thresholdCents deve ser inteiro positivo.', 422);
  }
  if (input.netWorthCents < input.thresholdCents) {
    throw new AppError('ZK_PREDICATE_UNSATISFIED', 'Patrimônio abaixo do limiar exigido.', 422);
  }
  const salt = String(input.salt ?? '').trim();
  if (!/^[0-9]{1,40}$/.test(salt)) {
    throw new AppError('ZK_INVALID_WITNESS', 'salt deve ser um inteiro decimal.', 422);
  }

  const { groth16 } = await snarkjs();
  const result = await serialized(async () => {
    try {
      return await groth16.fullProve(
        {
          netWorth: String(input.netWorthCents),
          salt,
          threshold: String(input.thresholdCents),
        },
        path.join(artifactDir(), `${CIRCUIT}.wasm`),
        path.join(artifactDir(), `${CIRCUIT}.zkey`),
      );
    } finally {
      await releaseCurve();
    }
  });

  const proof = normalizeProof(result.proof);
  const publicSignals = normalizeSignals(result.publicSignals);
  return {
    proof,
    publicSignals,
    commitment: publicSignals[0],
    thresholdCents: input.thresholdCents,
    satisfied: true,
  };
}

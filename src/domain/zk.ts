import { sha256Hex } from '../kernel/crypto.ts';
import { AppError } from '../kernel/errors.ts';

/**
 * Compromissos e provas de inclusão Merkle. Provam que um atributo pertence a um conjunto
 * divulgado sem expor os demais membros — divulgação seletiva honesta, não zk-SNARK.
 */
export function commitClaim(input: {
  subjectId: string;
  claimType: string;
  salt: string;
  value: string;
}): string {
  return sha256Hex(`xpartner:commit:v1:${input.salt}:${input.subjectId}:${input.claimType}:${input.value}`);
}

export function verifyCommitment(
  commitment: string,
  input: { subjectId: string; claimType: string; salt: string; value: string },
): boolean {
  return commitClaim(input) === commitment;
}

function hashLeaf(leaf: string): string {
  return sha256Hex(`00${leaf}`);
}

function hashPair(left: string, right: string): string {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return sha256Hex(`01${a}${b}`);
}

export interface MerkleTree {
  root: string;
  levels: string[][];
}

export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) throw new AppError('MERKLE_EMPTY', 'Conjunto Merkle vazio.', 422);
  const levels: string[][] = [leaves.map(hashLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? left;
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], levels };
}

export interface MerkleProof {
  leaf: string;
  root: string;
  path: Array<{ hash: string; side: 'LEFT' | 'RIGHT' }>;
}

export function merkleProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  const base = tree.levels[0];
  if (leafIndex < 0 || leafIndex >= base.length) {
    throw new AppError('MERKLE_INDEX', 'Índice fora do conjunto Merkle.', 422);
  }
  const path: MerkleProof['path'] = [];
  let index = leafIndex;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level];
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = nodes[siblingIndex] ?? nodes[index];
    path.push({ hash: sibling, side: siblingIndex < index ? 'LEFT' : 'RIGHT' });
    index = Math.floor(index / 2);
  }
  return { leaf: base[leafIndex], root: tree.root, path };
}

export function verifyMerkleProof(proof: MerkleProof): boolean {
  let current = proof.leaf;
  for (const step of proof.path) {
    current = step.side === 'LEFT' ? hashPair(step.hash, current) : hashPair(current, step.hash);
  }
  return current === proof.root;
}

/** Prova de inclusão direta: recalcula a raiz a partir do conjunto e confere o compromisso. */
export function proveInclusion(commitments: string[], commitment: string): MerkleProof | undefined {
  const index = commitments.indexOf(commitment);
  if (index < 0) return undefined;
  return merkleProof(buildMerkleTree(commitments), index);
}

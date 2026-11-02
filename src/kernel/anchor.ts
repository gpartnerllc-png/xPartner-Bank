import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { sha256Hex } from './crypto.ts';

export const GENESIS_HASH = '0'.repeat(64);

export interface Anchor {
  height: number;
  payloadHash: string;
  prevHash: string;
  anchorHash: string;
  createdAt: string;
}

interface AnchorRow {
  height: number;
  payload_hash: string;
  prev_hash: string;
  anchor_hash: string;
  created_at: string;
}

function toAnchor(row: AnchorRow): Anchor {
  return {
    height: row.height,
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    anchorHash: row.anchor_hash,
    createdAt: row.created_at,
  };
}

/**
 * Cadeia de âncoras append-only: cada bloco amarra o hash do anterior. Serve como registro
 * à prova de adulteração local, pronto para ancoragem periódica em rede pública.
 */
export function appendAnchor(db: Db, payload: unknown, createdAt: string = nowIso()): Anchor {
  const last = db
    .prepare('SELECT height, anchor_hash FROM anchor_chain ORDER BY height DESC LIMIT 1')
    .get() as { height: number; anchor_hash: string } | undefined;
  const height = (last?.height ?? 0) + 1;
  const prevHash = last?.anchor_hash ?? GENESIS_HASH;
  const payloadHash = sha256Hex(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const anchorHash = sha256Hex(`${prevHash}|${payloadHash}|${height}|${createdAt}`);
  db.prepare(
    'INSERT INTO anchor_chain (height, payload_hash, prev_hash, anchor_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(height, payloadHash, prevHash, anchorHash, createdAt);
  return { height, payloadHash, prevHash, anchorHash, createdAt };
}

export function latestAnchor(db: Db): Anchor | undefined {
  const row = db.prepare('SELECT * FROM anchor_chain ORDER BY height DESC LIMIT 1').get() as
    | AnchorRow
    | undefined;
  return row ? toAnchor(row) : undefined;
}

export function listAnchors(db: Db, limit = 50): Anchor[] {
  const rows = db
    .prepare('SELECT * FROM anchor_chain ORDER BY height DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500)) as unknown as AnchorRow[];
  return rows.map(toAnchor);
}

export function getAnchor(db: Db, height: number): Anchor {
  const row = db.prepare('SELECT * FROM anchor_chain WHERE height = ?').get(height) as AnchorRow | undefined;
  if (!row) throw new Error(`Âncora ${height} inexistente.`);
  return toAnchor(row);
}

/** Recalcula a cadeia inteira; retorna a primeira altura divergente, se houver. */
export function verifyAnchorChain(db: Db): { valid: boolean; checked: number; brokenAt?: number } {
  const rows = db.prepare('SELECT * FROM anchor_chain ORDER BY height ASC').all() as unknown as AnchorRow[];
  let prevHash = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const expectedHeight = index + 1;
    if (row.height !== expectedHeight || row.prev_hash !== prevHash) {
      return { valid: false, checked: index, brokenAt: row.height };
    }
    const expected = sha256Hex(`${row.prev_hash}|${row.payload_hash}|${row.height}|${row.created_at}`);
    if (expected !== row.anchor_hash) return { valid: false, checked: index, brokenAt: row.height };
    prevHash = row.anchor_hash;
  }
  return { valid: true, checked: rows.length };
}

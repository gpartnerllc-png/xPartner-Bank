import type { AuthContext, Env } from './types.ts';
import { HttpError } from './http.ts';
import { audit, queueEvent } from './repo.ts';
import { buildPixPayload } from './pix-domain.ts';
import {
  MAX_ACTIVE_PIX_KEYS,
  PIX_KEY_TYPES,
  inferPixKeyType,
  maskedKey,
  normalizePixKeyValue,
  type PixKeyRow,
  type PixKeyType,
} from './pix-keys.ts';
import { newId, nowIso } from './security.ts';
import { formatBRL, maskDocument } from './validation.ts';

interface PixHolder {
  id: string;
  name: string;
  document: string;
  status: string;
  branch: string;
  number: string;
  account_status: string;
}

function keyView(row: PixKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.key_type,
    key: row.key_value,
    masked: row.key_masked,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function holderOf(env: Env, userId: string): Promise<PixHolder> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.document, u.status, a.branch, a.number, a.status AS account_status
       FROM bank_users u
       LEFT JOIN bank_accounts a ON a.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<PixHolder & { branch: string | null; number: string | null; account_status: string | null }>();
  if (!row) throw new HttpError(404, 'HOLDER_NOT_FOUND', 'Titular não encontrado.');
  if (row.status !== 'ACTIVE') throw new HttpError(403, 'HOLDER_BLOCKED', 'Cadastro não está ativo para operar chaves Pix.');
  if (!row.number || !row.branch || row.account_status !== 'ACTIVE') {
    throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Conta corrente ativa é obrigatória para registrar chaves Pix.');
  }
  return { ...row, branch: row.branch, number: row.number, account_status: row.account_status };
}

export async function listPixKeys(env: Env, userId: string): Promise<Record<string, unknown>> {
  const holder = await holderOf(env, userId);
  const result = await env.DB.prepare(
    "SELECT * FROM bank_pix_keys WHERE user_id = ? AND status <> 'DELETED' ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<PixKeyRow>();
  return {
    keys: (result.results ?? []).map(keyView),
    limit: MAX_ACTIVE_PIX_KEYS,
    holder: {
      name: holder.name,
      documentMasked: maskDocument(holder.document),
      account: `${holder.branch} / ${holder.number}`,
    },
  };
}

export async function createPixKey(
  env: Env,
  userId: string,
  input: { type?: string; value: string; label?: string },
  actorUserId = userId,
): Promise<{ key: Record<string, unknown> }> {
  const holder = await holderOf(env, userId);
  const raw = String(input.value ?? '').trim();
  if (!raw) throw new HttpError(422, 'INVALID_PIX_KEY', 'Informe o valor da chave Pix.');

  const declared = input.type ? (String(input.type).toUpperCase() as PixKeyType) : null;
  if (declared && !PIX_KEY_TYPES.includes(declared)) {
    throw new HttpError(422, 'INVALID_PIX_KEY', 'Tipo de chave Pix inválido: use CPF, CNPJ, EMAIL, PHONE ou EVP.');
  }
  const type = declared ?? inferPixKeyType(raw);
  if (!type) {
    throw new HttpError(422, 'INVALID_PIX_KEY', 'Não foi possível identificar a chave Pix. Informe o tipo.');
  }
  const value = normalizePixKeyValue(type, raw, holder.document);

  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM bank_pix_keys WHERE user_id = ? AND status <> 'DELETED'",
  )
    .bind(userId)
    .first<{ count: number }>();
  if ((active?.count ?? 0) >= MAX_ACTIVE_PIX_KEYS) {
    throw new HttpError(409, 'PIX_KEY_LIMIT', `Limite de ${MAX_ACTIVE_PIX_KEYS} chaves Pix ativas por conta atingido.`);
  }

  const duplicate = await env.DB.prepare(
    "SELECT id FROM bank_pix_keys WHERE key_type = ? AND key_value = ? AND status <> 'DELETED'",
  )
    .bind(type, value)
    .first<{ id: string }>();
  if (duplicate) throw new HttpError(409, 'PIX_KEY_EXISTS', 'Esta chave Pix já está registrada no xPartner Bank.');

  const label = input.label ? String(input.label).trim().slice(0, 40) : null;
  const id = newId('pixk');
  const stamp = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO bank_pix_keys (id, user_id, key_type, key_value, key_masked, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    )
      .bind(id, userId, type, value, maskedKey(type, value), label, stamp, stamp)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE')) {
      throw new HttpError(409, 'PIX_KEY_EXISTS', 'Esta chave Pix já está registrada no xPartner Bank.');
    }
    throw error;
  }

  await audit(env, {
    actorId: actorUserId,
    action: 'bank.pix.key.created',
    resource: 'bank_pix_key',
    resourceId: id,
    details: { userId, type, masked: maskedKey(type, value) },
  });
  await queueEvent(env, {
    topic: 'bank.pix',
    type: 'bank.pix.key.created',
    payload: { keyId: id, userId, type, masked: maskedKey(type, value) },
  });

  const row = await env.DB.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').bind(id).first<PixKeyRow>();
  return { key: keyView(row as PixKeyRow) };
}

export async function createPixEvp(
  env: Env,
  userId: string,
  label?: string,
  actorUserId = userId,
): Promise<{ key: Record<string, unknown> }> {
  return createPixKey(env, userId, { type: 'EVP', value: crypto.randomUUID(), label }, actorUserId);
}

export async function removePixKey(
  env: Env,
  userId: string,
  keyId: string,
  actorUserId = userId,
): Promise<{ id: string; status: string }> {
  const row = await env.DB.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').bind(keyId).first<PixKeyRow>();
  if (!row || row.status === 'DELETED') throw new HttpError(404, 'PIX_KEY_NOT_FOUND', 'Chave Pix não encontrada.');
  if (row.user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'Você só pode remover as suas próprias chaves Pix.');
  const stamp = nowIso();
  await env.DB.prepare("UPDATE bank_pix_keys SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(stamp, stamp, keyId)
    .run();
  await audit(env, {
    actorId: actorUserId,
    action: 'bank.pix.key.deleted',
    resource: 'bank_pix_key',
    resourceId: keyId,
    details: { userId: row.user_id, type: row.key_type, masked: row.key_masked },
  });
  await queueEvent(env, {
    topic: 'bank.pix',
    type: 'bank.pix.key.deleted',
    payload: { keyId, userId: row.user_id, type: row.key_type, masked: row.key_masked },
  });
  return { id: keyId, status: 'DELETED' };
}

export async function pixBrCode(
  env: Env,
  userId: string,
  keyId: string,
  amountCents?: number,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').bind(keyId).first<PixKeyRow>();
  if (!row || row.status !== 'ACTIVE') throw new HttpError(404, 'PIX_KEY_NOT_FOUND', 'Chave Pix ativa não encontrada.');
  if (row.user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'Chave Pix pertence a outro titular.');
  if (amountCents !== undefined && (!Number.isSafeInteger(amountCents) || amountCents <= 0)) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'amountCents deve ser um inteiro positivo em centavos.');
  }
  const holder = await holderOf(env, userId);
  const txid = `XP${crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
  const payload = buildPixPayload({
    pixKey: row.key_value,
    merchantName: holder.name,
    merchantCity: 'SAO PAULO',
    amountCents,
    txid,
  });
  return {
    payload,
    crc: payload.slice(-4),
    keyMasked: row.key_masked,
    keyType: row.key_type,
    holderName: holder.name,
    amountCents: amountCents ?? null,
    amountFormatted: amountCents === undefined ? null : formatBRL(amountCents),
    txid,
  };
}

export async function adminListPixKeys(
  env: Env,
  filters: { type?: string; status?: string; limit?: number } = {},
): Promise<Record<string, unknown>> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.type) {
    clauses.push('k.key_type = ?');
    params.push(filters.type);
  }
  if (filters.status) {
    clauses.push('k.status = ?');
    params.push(filters.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const result = await env.DB.prepare(
    `SELECT k.*, u.name, u.document, a.branch, a.number
       FROM bank_pix_keys k
       JOIN bank_users u ON u.id = k.user_id
       LEFT JOIN bank_accounts a ON a.user_id = k.user_id
       ${where}
      ORDER BY k.created_at DESC
      LIMIT ${limit}`,
  )
    .bind(...params)
    .all<PixKeyRow & { name: string; document: string; branch: string | null; number: string | null }>();
  return {
    data: (result.results ?? []).map((row) => ({
      ...keyView(row),
      holderName: row.name,
      holderDocumentMasked: maskDocument(row.document),
      account: row.number ? `${row.branch} / ${row.number}` : '—',
    })),
  };
}

/** Consulta pública interna: devolve apenas dados mascarados do recebedor. */
export async function lookupPixKey(
  env: Env,
  actorUserId: string,
  raw: string,
): Promise<Record<string, unknown>> {
  const row = await resolvePixRow(env, raw);
  if (!row) throw new HttpError(404, 'PIX_KEY_NOT_FOUND', 'Chave Pix não encontrada ou inativa no xPartner Bank.');
  if (row.user_id === actorUserId) throw new HttpError(422, 'SELF_TRANSFER', 'Não é possível transferir para a própria chave Pix.');
  return {
    keyMasked: row.key_masked,
    keyType: row.key_type,
    name: row.name,
    documentMasked: maskDocument(row.document),
    account: `${row.branch} / ${row.number}`,
  };
}

export async function resolvePixRow(
  env: Env,
  raw: string,
): Promise<(PixKeyRow & { name: string; document: string; branch: string; number: string; user_status: string; account_status: string }) | null> {
  const { pixLookupCandidates } = await import('./pix-keys.ts');
  for (const candidate of pixLookupCandidates(raw)) {
    const row = await env.DB.prepare(
      `SELECT k.*, u.name, u.document, u.status AS user_status,
              a.branch, a.number, a.status AS account_status
         FROM bank_pix_keys k
         JOIN bank_users u ON u.id = k.user_id
         JOIN bank_accounts a ON a.user_id = k.user_id
        WHERE k.key_type = ? AND k.key_value = ? AND k.status = 'ACTIVE'
          AND u.status = 'ACTIVE' AND a.status = 'ACTIVE'`,
    )
      .bind(candidate.type, candidate.value)
      .first<PixKeyRow & { name: string; document: string; branch: string; number: string; user_status: string; account_status: string }>();
    if (row) return row;
  }
  return null;
}

import { randomUUID } from 'node:crypto';
import type { Db } from '../kernel/db.ts';
import { audit, nowIso, tx } from '../kernel/db.ts';
import { enqueueEvent } from '../kernel/bus.ts';
import { AppError, Errors } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { assertPositiveCents, formatBRL, type Cents } from '../kernel/money.ts';
import {
  assertDocument,
  assertEmail,
  assertPhone,
  isValidCNPJ,
  isValidCPF,
  maskDocument,
  onlyDigits,
} from '../domain/documents.ts';
import { buildPixPayload, crc16 } from '../domain/pix.ts';

export const MAX_ACTIVE_PIX_KEYS = 5;

export type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
export type PixKeyStatus = 'ACTIVE' | 'BLOCKED' | 'DELETED';

export interface PixKeyRow {
  id: string;
  user_id: string;
  key_type: PixKeyType;
  key_value: string;
  key_masked: string;
  label: string | null;
  status: PixKeyStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PixKeyView {
  id: string;
  type: PixKeyType;
  key: string;
  masked: string;
  label: string | null;
  status: string;
  createdAt: string;
}

export interface PixKeyOwnerView {
  key: string;
  keyType: PixKeyType;
  name: string;
  documentMasked: string;
  account: string;
  branch: string;
}

export interface PixContactView {
  keyMasked: string;
  keyType: PixKeyType;
  name: string;
  documentMasked: string;
  account: string;
}

interface HolderRow {
  user_id: string;
  name: string;
  document: string;
  user_status: string;
  branch: string;
  number: string;
  account_status: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function maskEmailKey(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function maskPhoneKey(value: string): string {
  const digits = onlyDigits(value);
  return `+${digits.slice(0, 2)} ** *****-${digits.slice(-4)}`;
}

function maskEvpKey(value: string): string {
  return `••••-${value.slice(-4)}`;
}

function maskedKey(type: PixKeyType, value: string): string {
  switch (type) {
    case 'CPF':
    case 'CNPJ':
      return maskDocument(value);
    case 'EMAIL':
      return maskEmailKey(value);
    case 'PHONE':
      return maskPhoneKey(value);
    case 'EVP':
      return maskEvpKey(value);
  }
}

/** Deduz o tipo da chave a partir do valor bruto (o tipo explícito sempre tem prioridade). */
export function inferPixKeyType(raw: string): PixKeyType | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (UUID_V4.test(value)) return 'EVP';
  if (value.includes('@')) return 'EMAIL';
  if (value.startsWith('+')) return 'PHONE';
  const digits = onlyDigits(value);
  if (digits.length === 11) return 'CPF';
  if (digits.length === 14) return 'CNPJ';
  if (digits.length === 10 || digits.length === 12 || digits.length === 13) return 'PHONE';
  return null;
}

function normalizePhoneKey(raw: string): string {
  let digits = onlyDigits(raw);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  return `+55${assertPhone(digits)}`;
}

function normalizeEmailKey(raw: string): string {
  const email = assertEmail(raw);
  if (email.length > 77) throw Errors.validation('Chave Pix de e-mail excede 77 caracteres.');
  return email;
}

function normalizeKeyValue(type: PixKeyType, raw: string, holderDocument: string): string {
  switch (type) {
    case 'CPF': {
      const input = onlyDigits(raw);
      if (input.length !== 11 || !isValidCPF(input)) {
        throw new AppError('INVALID_PIX_KEY', 'Chave Pix CPF inválida: dígitos verificadores incorretos.', 422);
      }
      if (input !== holderDocument) {
        throw new AppError(
          'PIX_KEY_OWNERSHIP',
          'A chave Pix CPF precisa ser o mesmo CPF do titular da conta.',
          422,
        );
      }
      return input;
    }
    case 'CNPJ': {
      const input = onlyDigits(raw);
      if (input.length !== 14 || !isValidCNPJ(input)) {
        throw new AppError('INVALID_PIX_KEY', 'Chave Pix CNPJ inválida: dígitos verificadores incorretos.', 422);
      }
      if (input !== holderDocument) {
        throw new AppError(
          'PIX_KEY_OWNERSHIP',
          'A chave Pix CNPJ precisa ser o mesmo CNPJ do titular da conta.',
          422,
        );
      }
      return input;
    }
    case 'EMAIL':
      return normalizeEmailKey(raw);
    case 'PHONE':
      return normalizePhoneKey(raw);
    case 'EVP': {
      const value = raw.trim().toLowerCase();
      if (!UUID_V4.test(value)) {
        throw new AppError('INVALID_PIX_KEY', 'Chave aleatória (EVP) deve ser um UUID v4 válido.', 422);
      }
      return value;
    }
  }
}

function keyView(row: PixKeyRow): PixKeyView {
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

export interface CreatePixKeyInput {
  type?: string;
  value: string;
  label?: string;
  actorUserId?: string;
  now?: number;
}

export class BankPixService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private holder(userId: string): { id: string; name: string; document: string; status: string; branch: string; number: string; account_status: string } {
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, u.document, u.status, a.branch, a.number, a.status AS account_status
           FROM bank_users u
           LEFT JOIN bank_accounts a ON a.user_id = u.id
          WHERE u.id = ?`,
      )
      .get(userId) as
      | { id: string; name: string; document: string; status: string; branch: string | null; number: string | null; account_status: string | null }
      | undefined;
    if (!row) throw Errors.notFound('Titular não encontrado.');
    if (row.status !== 'ACTIVE') throw Errors.forbidden('Cadastro não está ativo para operar chaves Pix.');
    if (!row.number || row.account_status !== 'ACTIVE') {
      throw Errors.forbidden('Conta corrente ativa é obrigatória para registrar chaves Pix.');
    }
    return { ...row, branch: row.branch as string, number: row.number, account_status: row.account_status };
  }

  private find(type: PixKeyType, value: string): PixKeyRow | undefined {
    return this.db
      .prepare('SELECT * FROM bank_pix_keys WHERE key_type = ? AND key_value = ? AND status <> ?')
      .get(type, value, 'DELETED') as unknown as PixKeyRow | undefined;
  }

  list(userId: string): { keys: PixKeyView[]; limit: number; holder: { name: string; documentMasked: string; account: string } } {
    const holder = this.holder(userId);
    const rows = this.db
      .prepare(
        `SELECT * FROM bank_pix_keys
          WHERE user_id = ? AND status <> 'DELETED'
          ORDER BY created_at ASC`,
      )
      .all(userId) as unknown as PixKeyRow[];
    return {
      keys: rows.map(keyView),
      limit: MAX_ACTIVE_PIX_KEYS,
      holder: {
        name: holder.name,
        documentMasked: maskDocument(holder.document),
        account: `${holder.branch} / ${holder.number}`,
      },
    };
  }

  create(userId: string, input: CreatePixKeyInput): PixKeyView {
    const holder = this.holder(userId);
    const raw = String(input.value ?? '').trim();
    if (!raw) throw Errors.validation('Informe o valor da chave Pix.');

    const declared = input.type ? (String(input.type).toUpperCase() as PixKeyType) : null;
    const allowed: PixKeyType[] = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'];
    if (declared && !allowed.includes(declared)) {
      throw Errors.validation('Tipo de chave Pix inválido: use CPF, CNPJ, EMAIL, PHONE ou EVP.');
    }
    const type = declared ?? inferPixKeyType(raw);
    if (!type) {
      throw new AppError(
        'INVALID_PIX_KEY',
        'Não foi possível identificar a chave Pix. Informe o tipo (CPF, CNPJ, e-mail, telefone ou aleatória).',
        422,
      );
    }
    const value = normalizeKeyValue(type, raw, holder.document);

    const active = this.db
      .prepare("SELECT COUNT(*) AS count FROM bank_pix_keys WHERE user_id = ? AND status <> 'DELETED'")
      .get(userId) as { count: number };
    if (active.count >= MAX_ACTIVE_PIX_KEYS) {
      throw new AppError(
        'PIX_KEY_LIMIT',
        `Limite de ${MAX_ACTIVE_PIX_KEYS} chaves Pix ativas por conta atingido.`,
        409,
      );
    }

    if (this.find(type, value)) {
      throw new AppError('PIX_KEY_EXISTS', 'Esta chave Pix já está registrada no xPartner Bank.', 409);
    }

    const label = input.label ? String(input.label).trim().slice(0, 40) : null;
    const now = input.now ?? Date.now();
    const timestamp = nowIso(now);
    const id = newId('pixk', now);
    try {
      tx(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO bank_pix_keys
               (id, user_id, key_type, key_value, key_masked, label, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          )
          .run(id, userId, type, value, maskedKey(type, value), label, timestamp, timestamp);
        audit(this.db, input.actorUserId ?? userId, 'bank.pix.key.created', `bank_pix_key:${id}`, {
          userId,
          type,
          masked: maskedKey(type, value),
        });
        enqueueEvent(this.db, {
          topic: 'bank.pix',
          type: 'bank.pix.key.created',
          key: id,
          payload: { keyId: id, userId, type, masked: maskedKey(type, value) },
        });
      });
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new AppError('PIX_KEY_EXISTS', 'Esta chave Pix já está registrada no xPartner Bank.', 409);
      }
      throw error;
    }
    return keyView(this.db.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').get(id) as unknown as PixKeyRow);
  }

  remove(userId: string, keyId: string, actorUserId?: string, now = Date.now()): { id: string; status: string } {
    const row = this.db.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').get(keyId) as
      | PixKeyRow
      | undefined;
    if (!row || row.status === 'DELETED') throw Errors.notFound('Chave Pix não encontrada.');
    if (row.user_id !== userId) throw Errors.forbidden('Você só pode remover as suas próprias chaves Pix.');
    const timestamp = nowIso(now);
    tx(this.db, () => {
      this.db
        .prepare("UPDATE bank_pix_keys SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, keyId);
      audit(this.db, actorUserId ?? userId, 'bank.pix.key.deleted', `bank_pix_key:${keyId}`, {
        userId: row.user_id,
        type: row.key_type,
        masked: row.key_masked,
      });
      enqueueEvent(this.db, {
        topic: 'bank.pix',
        type: 'bank.pix.key.deleted',
        key: keyId,
        payload: { keyId, userId: row.user_id, type: row.key_type, masked: row.key_masked },
      });
    });
    return { id: keyId, status: 'DELETED' };
  }

  private resolveHolder(raw: string): { key: PixKeyRow; holder: HolderRow } {
    const value = String(raw ?? '').trim();
    if (!value) throw Errors.validation('Informe a chave Pix do favorecido.');
    const candidates: Array<{ type: PixKeyType; value: string }> = [];
    const inferred = inferPixKeyType(value);
    if (inferred && inferred !== 'CPF' && inferred !== 'CNPJ' && inferred !== 'PHONE') {
      candidates.push({ type: inferred, value: value.toLowerCase() });
    } else {
      const digits = onlyDigits(value);
      if (digits.length === 11) candidates.push({ type: 'CPF', value: digits });
      if (digits.length === 14) candidates.push({ type: 'CNPJ', value: digits });
      if (digits.length >= 10) {
        try {
          candidates.push({ type: 'PHONE', value: normalizePhoneKey(value) });
        } catch {
          // não é telefone válido: segue com os demais candidatos
        }
      }
      if (value.includes('@')) candidates.push({ type: 'EMAIL', value: value.toLowerCase() });
      if (UUID_V4.test(value)) candidates.push({ type: 'EVP', value: value.toLowerCase() });
    }

    for (const candidate of candidates) {
      const row = this.db
        .prepare(
          `SELECT k.*, u.name, u.document, u.status AS user_status,
                  a.branch, a.number, a.status AS account_status
             FROM bank_pix_keys k
             JOIN bank_users u ON u.id = k.user_id
             JOIN bank_accounts a ON a.user_id = k.user_id
            WHERE k.key_type = ? AND k.key_value = ? AND k.status = 'ACTIVE'`,
        )
        .get(candidate.type, candidate.value) as unknown as (PixKeyRow & HolderRow) | undefined;
      if (row) return { key: row, holder: row };
    }
    throw Errors.notFound('Chave Pix não encontrada ou inativa no xPartner Bank.');
  }

  /** Consulta pública interna: devolve apenas dados mascarados do recebedor. */
  lookup(actorUserId: string, raw: string): PixContactView {
    const { key, holder } = this.resolveHolder(raw);
    if (holder.user_status !== 'ACTIVE' || holder.account_status !== 'ACTIVE') {
      throw Errors.notFound('Chave Pix não encontrada ou inativa no xPartner Bank.');
    }
    if (holder.user_id === actorUserId) {
      throw Errors.validation('Não é possível transferir para a própria chave Pix.');
    }
    return {
      keyMasked: key.key_masked,
      keyType: key.key_type,
      name: holder.name,
      documentMasked: maskDocument(holder.document),
      account: `${holder.branch} / ${holder.number}`,
    };
  }

  /** Resolve a chave para a conta de destino usada pelo motor de transferências. */
  resolveRecipient(actorUserId: string, raw: string): { accountNumber: string; contact: PixContactView } {
    const { key, holder } = this.resolveHolder(raw);
    if (holder.user_status !== 'ACTIVE' || holder.account_status !== 'ACTIVE') {
      throw Errors.notFound('Chave Pix não encontrada ou inativa no xPartner Bank.');
    }
    if (holder.user_id === actorUserId) {
      throw Errors.validation('Não é possível transferir para a própria chave Pix.');
    }
    return {
      accountNumber: holder.number,
      contact: {
        keyMasked: key.key_masked,
        keyType: key.key_type,
        name: holder.name,
        documentMasked: maskDocument(holder.document),
        account: `${holder.branch} / ${holder.number}`,
      },
    };
  }

  brCode(
    userId: string,
    keyId: string,
    amountCents?: number,
    now = Date.now(),
  ): {
    payload: string;
    crc: string;
    keyMasked: string;
    keyType: PixKeyType;
    holderName: string;
    amountCents: Cents | null;
    amountFormatted: string | null;
    txid: string;
  } {
    const row = this.db.prepare('SELECT * FROM bank_pix_keys WHERE id = ?').get(keyId) as
      | PixKeyRow
      | undefined;
    if (!row || row.status !== 'ACTIVE') throw Errors.notFound('Chave Pix ativa não encontrada.');
    if (row.user_id !== userId) throw Errors.forbidden('Chave Pix pertence a outro titular.');
    const holder = this.holder(userId);
    const amount = amountCents === undefined ? undefined : assertPositiveCents(amountCents);
    const txid = `XP${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
    const payload = buildPixPayload({
      pixKey: row.key_value,
      merchantName: holder.name,
      merchantCity: 'SAO PAULO',
      amountCents: amount,
      txid,
    });
    return {
      payload,
      crc: crc16(payload.slice(0, -4)),
      keyMasked: row.key_masked,
      keyType: row.key_type,
      holderName: holder.name,
      amountCents: amount ?? null,
      amountFormatted: amount === undefined ? null : formatBRL(amount),
      txid,
    };
  }

  adminList(filters: { type?: string; status?: string; limit?: number } = {}): Array<
    PixKeyView & { holderName: string; holderDocumentMasked: string; account: string }
  > {
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
    const rows = this.db
      .prepare(
        `SELECT k.*, u.name, u.document, a.branch, a.number
           FROM bank_pix_keys k
           JOIN bank_users u ON u.id = k.user_id
           LEFT JOIN bank_accounts a ON a.user_id = k.user_id
           ${where}
          ORDER BY k.created_at DESC
          LIMIT ${limit}`,
      )
      .all(...params) as unknown as Array<
      PixKeyRow & { name: string; document: string; branch: string | null; number: string | null }
    >;
    return rows.map((row) => ({
      ...keyView(row),
      holderName: row.name,
      holderDocumentMasked: maskDocument(row.document),
      account: row.number ? `${row.branch} / ${row.number}` : '—',
    }));
  }

  /** Cria uma chave EVP (UUID v4) para o titular. */
  createEvp(userId: string, label?: string, actorUserId?: string): PixKeyView {
    return this.create(userId, { type: 'EVP', value: randomUUID(), label, actorUserId });
  }
}

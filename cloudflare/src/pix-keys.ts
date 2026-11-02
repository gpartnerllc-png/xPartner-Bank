import { HttpError } from './http.ts';
import { isValidCNPJ, isValidCPF, onlyDigits } from './validation.ts';

export const MAX_ACTIVE_PIX_KEYS = 5;
export const PIX_KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'] as const;

export type PixKeyType = (typeof PIX_KEY_TYPES)[number];
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

export function maskedKey(type: PixKeyType, value: string): string {
  switch (type) {
    case 'CPF':
    case 'CNPJ':
      return type === 'CPF'
        ? `${value.slice(0, 3)}.***.***-${value.slice(-2)}`
        : `${value.slice(0, 2)}.***.***/****-${value.slice(-2)}`;
    case 'EMAIL':
      return maskEmailKey(value);
    case 'PHONE':
      return maskPhoneKey(value);
    case 'EVP':
      return maskEvpKey(value);
  }
}

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
  if (digits.length !== 10 && digits.length !== 11) {
    throw new HttpError(422, 'INVALID_PIX_KEY', 'Telefone Pix deve ter DDD + número.');
  }
  if (digits.length === 11 && digits[2] !== '9') {
    throw new HttpError(422, 'INVALID_PIX_KEY', 'Celular Pix deve começar com 9 após o DDD.');
  }
  return `+55${digits}`;
}

export function normalizePixKeyValue(type: PixKeyType, raw: string, holderDocument: string): string {
  switch (type) {
    case 'CPF': {
      const input = onlyDigits(raw);
      if (input.length !== 11 || !isValidCPF(input)) {
        throw new HttpError(422, 'INVALID_PIX_KEY', 'Chave Pix CPF inválida: dígitos verificadores incorretos.');
      }
      if (input !== holderDocument) {
        throw new HttpError(422, 'PIX_KEY_OWNERSHIP', 'A chave Pix CPF precisa ser o mesmo CPF do titular da conta.');
      }
      return input;
    }
    case 'CNPJ': {
      const input = onlyDigits(raw);
      if (input.length !== 14 || !isValidCNPJ(input)) {
        throw new HttpError(422, 'INVALID_PIX_KEY', 'Chave Pix CNPJ inválida: dígitos verificadores incorretos.');
      }
      if (input !== holderDocument) {
        throw new HttpError(422, 'PIX_KEY_OWNERSHIP', 'A chave Pix CNPJ precisa ser o mesmo CNPJ do titular da conta.');
      }
      return input;
    }
    case 'EMAIL': {
      const email = String(raw ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw new HttpError(422, 'INVALID_PIX_KEY', 'Chave Pix de e-mail inválida.');
      }
      if (email.length > 77) throw new HttpError(422, 'INVALID_PIX_KEY', 'Chave Pix de e-mail excede 77 caracteres.');
      return email;
    }
    case 'PHONE':
      return normalizePhoneKey(raw);
    case 'EVP': {
      const value = String(raw ?? '').trim().toLowerCase();
      if (!UUID_V4.test(value)) {
        throw new HttpError(422, 'INVALID_PIX_KEY', 'Chave aleatória (EVP) deve ser um UUID v4 válido.');
      }
      return value;
    }
  }
}

/** Candidatos (tipo + valor normalizado) para localizar uma chave informada. */
export function pixLookupCandidates(raw: string): Array<{ type: PixKeyType; value: string }> {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  const candidates: Array<{ type: PixKeyType; value: string }> = [];
  const inferred = inferPixKeyType(value);
  if (inferred === 'EMAIL' || inferred === 'EVP') {
    candidates.push({ type: inferred, value: value.toLowerCase() });
    return candidates;
  }
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
  return candidates;
}

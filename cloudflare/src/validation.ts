import { HttpError } from './http.ts';
import { randomBytes } from './security.ts';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });

export function onlyDigits(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

function weightedMod11(base: string, weights: number[]): number {
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) sum += Number(base[index]) * weights[index];
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCPF(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const first = weightedMod11(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== Number(cpf[9])) return false;
  return weightedMod11(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(cpf[10]);
}

export function isValidCNPJ(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const first = weightedMod11(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== Number(cnpj[12])) return false;
  return weightedMod11(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(cnpj[13]);
}

export function assertDocument(input: string): { document: string; kind: 'PF' | 'PJ' } {
  const document = onlyDigits(input);
  if (document.length === 11 && isValidCPF(document)) return { document, kind: 'PF' };
  if (document.length === 14 && isValidCNPJ(document)) return { document, kind: 'PJ' };
  throw new HttpError(422, 'INVALID_DOCUMENT', 'CPF ou CNPJ inválido: confira os dígitos verificadores.');
}

export function normalizeName(input: string): string {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new HttpError(422, 'INVALID_NAME', 'Nome é obrigatório.');
  if (name.length > 80) throw new HttpError(422, 'INVALID_NAME', 'Nome excede 80 caracteres.');
  return name;
}

export function assertEmail(input: string): string {
  const email = String(input ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(422, 'INVALID_EMAIL', 'E-mail inválido.');
  }
  return email;
}

export function assertPhone(input: string | undefined): string | null {
  if (!input) return null;
  const digits = onlyDigits(input);
  if (digits.length !== 10 && digits.length !== 11) {
    throw new HttpError(422, 'INVALID_PHONE', 'Telefone deve ter DDD + número (10 ou 11 dígitos).');
  }
  if (digits.length === 11 && digits[2] !== '9') {
    throw new HttpError(422, 'INVALID_PHONE', 'Celular deve começar com 9 após o DDD.');
  }
  return digits;
}

export function parseAmountCents(value: unknown): number {
  let cents: number | null = null;
  if (typeof value === 'number' && Number.isInteger(value)) {
    cents = value;
  } else if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    if (/^\d+$/.test(raw)) {
      cents = Number.parseInt(raw, 10);
    } else {
      const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
      const parsed = Number.parseFloat(normalized);
      if (Number.isFinite(parsed)) cents = Math.round(parsed * 100);
    }
  }
  if (cents === null || !Number.isSafeInteger(cents) || cents <= 0) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'Informe um valor positivo em centavos.');
  }
  if (cents > 1_000_000_000) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'Valor acima do limite operacional.');
  }
  return cents;
}

export function formatBRL(cents: number): string {
  return BRL.format(cents / 100);
}

export function formatUSD(cents: number): string {
  return USD.format(cents / 100);
}

export function formatDocument(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(-2)}`;
  if (digits.length === 14) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(-2)}`;
  return digits || '—';
}

export function maskEmail(input: string): string {
  const [local, domain] = String(input ?? '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export function maskDocument(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 11) return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
  if (digits.length === 14) return `${digits.slice(0, 2)}.***.***/****-${digits.slice(-2)}`;
  if (!digits) return '—';
  return digits.length <= 4 ? `${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}` : `***${digits.slice(-2)}`;
}

export function maskedAccount(branch: string, number: string): string {
  return `${branch} / ••••${number.slice(-4)}`;
}

export function accountCheckDigit(base: string): string {
  let sum = 0;
  let weight = 2;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const digit = 11 - (sum % 11);
  return digit >= 10 ? '0' : String(digit);
}

export function formatAccountNumber(sequence: number): string {
  const base = String(sequence).padStart(7, '0').slice(-7);
  return `${base}${accountCheckDigit(base)}`;
}

export function endToEndId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const random = [...randomBytes(6)].map((byte) => String(byte % 10)).join('').padEnd(11, '0').slice(0, 11);
  return `E99999999${stamp}${random}`;
}

export function sanitizeDescription(input: unknown): string {
  const description = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (description.length > 120) throw new HttpError(422, 'INVALID_DESCRIPTION', 'Descrição excede 120 caracteres.');
  return description;
}

export function sanitizeIdempotencyKey(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  const key = String(input).trim();
  if (key.length < 8 || key.length > 120) {
    throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'Chave de idempotência deve ter 8 a 120 caracteres.');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'Chave de idempotência contém caracteres inválidos.');
  }
  return key;
}

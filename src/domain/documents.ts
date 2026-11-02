import { AppError } from '../kernel/errors.ts';

export type PersonKind = 'PF' | 'PJ';

export function onlyDigits(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

function weightedMod11(base: string, weights: number[]): number {
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) {
    sum += Number(base[index]) * weights[index];
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCPF(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const first = weightedMod11(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== Number(cpf[9])) return false;
  const second = weightedMod11(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return second === Number(cpf[10]);
}

export function isValidCNPJ(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const first = weightedMod11(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== Number(cnpj[12])) return false;
  const second = weightedMod11(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return second === Number(cnpj[13]);
}

export function documentKind(input: string): PersonKind | null {
  const digits = onlyDigits(input);
  if (digits.length === 11) return isValidCPF(digits) ? 'PF' : null;
  if (digits.length === 14) return isValidCNPJ(digits) ? 'PJ' : null;
  return null;
}

/** Valida dígitos verificadores e devolve o documento normalizado (somente dígitos). */
export function assertDocument(input: string, field = 'document'): { document: string; kind: PersonKind } {
  const document = onlyDigits(input);
  const kind = documentKind(document);
  if (!kind) {
    throw new AppError(
      'INVALID_DOCUMENT',
      `${field} inválido: informe CPF ou CNPJ com dígitos verificadores corretos.`,
      422,
    );
  }
  return { document, kind };
}

export function formatDocument(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  return digits;
}

/** Mascara para exibição em telas e logs (LGPD): preserva prefixo e os dois últimos dígitos. */
export function maskDocument(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 11) return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
  if (digits.length === 14) return `${digits.slice(0, 2)}.***.***/****-${digits.slice(-2)}`;
  if (!digits) return '—';
  return digits.length <= 4 ? `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}` : `***${digits.slice(-2)}`;
}

export function normalizeName(input: string, maxLength = 80): string {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new AppError('INVALID_NAME', 'Nome do cliente é obrigatório.', 422);
  if (name.length > maxLength) throw new AppError('INVALID_NAME', `Nome excede ${maxLength} caracteres.`, 422);
  return name;
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input);
}

export function assertEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!isValidEmail(email)) throw new AppError('INVALID_EMAIL', 'E-mail inválido.', 422);
  return email;
}

/** Telefone brasileiro com DDD: aceita fixo (10) ou celular (11) após normalização. */
export function assertPhone(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length !== 10 && digits.length !== 11) {
    throw new AppError('INVALID_PHONE', 'Telefone deve ter DDD + número (10 ou 11 dígitos).', 422);
  }
  if (digits.length === 11 && digits[2] !== '9') {
    throw new AppError('INVALID_PHONE', 'Celular deve começar com 9 após o DDD.', 422);
  }
  return digits;
}

export function formatPhone(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 11) return digits.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  if (digits.length === 10) return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  return digits;
}

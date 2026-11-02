import { AppError } from '../kernel/errors.ts';
import { assertPositiveCents } from '../kernel/money.ts';
import { onlyDigits } from './documents.ts';

/**
 * Boleto de cobrança no padrão FEBRABAN (44 posições / 47 posições).
 * O banco 077 é fictício e usado apenas neste ambiente de demonstração:
 * nenhum boleto gerado aqui é registrado em câmara de compensação real.
 */
export const BOLETO_BANK_CODE = '077';
export const BOLETO_CURRENCY_CODE = '9';
export const BOLETO_WALLET = '01';
const FACTOR_BASE_UTC = Date.UTC(2025, 1, 22);
const FACTOR_BASE = 1000;
const MAX_BARCODE_AMOUNT_CENTS = 9_999_999_999;

export interface BoletoParts {
  barcode: string;
  digitableLine: string;
  dueFactor: number;
  generalDigit: number;
  freeField: string;
}

function parseIsoDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DUE_DATE', 'Vencimento deve estar no formato YYYY-MM-DD.', 422);
  }
  const [year, month, day] = value.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('INVALID_DUE_DATE', 'Data de vencimento inexistente.', 422);
  }
  return utc;
}

/** Fator de vencimento com base 2025-02-22 = 1000 (reinício FEBRABAN). */
export function dueDateFactor(dueDate: string): number {
  const days = Math.round((parseIsoDate(dueDate) - FACTOR_BASE_UTC) / 86_400_000);
  const factor = FACTOR_BASE + days;
  if (factor < 1000 || factor > 9999) {
    throw new AppError('INVALID_DUE_DATE', 'Vencimento fora da janela suportada pelo fator (2025-02-22 a 2049).', 422);
  }
  return factor;
}

export function factorToDate(factor: number): string {
  if (!Number.isInteger(factor) || factor < 1000 || factor > 9999) {
    throw new AppError('INVALID_BOLETO', 'Fator de vencimento inválido.', 422);
  }
  return new Date(FACTOR_BASE_UTC + (factor - FACTOR_BASE) * 86_400_000).toISOString().slice(0, 10);
}

/** Módulo 10 com pesos alternados 2/1 da direita para a esquerda (campos da linha digitável). */
export function mod10Digit(base: string): number {
  let sum = 0;
  let weight = 2;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    const product = Number(base[index]) * weight;
    sum += product > 9 ? product - 9 : product;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** Módulo 11 com pesos 2..9 da direita para a esquerda (DV geral do código de barras). */
export function mod11Digit(base: string): number {
  let sum = 0;
  let weight = 2;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const digit = 11 - (sum % 11);
  return digit === 0 || digit === 10 || digit === 11 ? 1 : digit;
}

export function buildFreeField(merchantSuffix: number, ourNumber: number): string {
  const suffix = String(Math.abs(Math.trunc(merchantSuffix)) % 1_000_000_000).padStart(9, '0');
  const nosso = String(Math.abs(Math.trunc(ourNumber)) % 100_000_000_000).padStart(11, '0');
  return `${BOLETO_BANK_CODE}${suffix}${nosso}${BOLETO_WALLET}`;
}

export function buildDigitableLine(barcode: string): string {
  const code = onlyDigits(barcode);
  if (code.length !== 44) throw new AppError('INVALID_BOLETO', 'Código de barras deve ter 44 dígitos.', 422);
  const field1 = code.slice(0, 4) + code.slice(19, 24);
  const field2 = code.slice(24, 34);
  const field3 = code.slice(34, 44);
  const dueAndAmount = code.slice(5, 19);
  return (
    field1 +
    mod10Digit(field1) +
    field2 +
    mod10Digit(field2) +
    field3 +
    mod10Digit(field3) +
    code[4] +
    dueAndAmount
  );
}

export function buildBarcode(input: { freeField: string; dueDate: string; amountCents: number }): BoletoParts {
  const freeField = onlyDigits(input.freeField);
  if (freeField.length !== 25) {
    throw new AppError('INVALID_BOLETO', 'Campo livre do boleto deve ter 25 dígitos.', 422);
  }
  const amountCents = assertPositiveCents(input.amountCents);
  if (amountCents > MAX_BARCODE_AMOUNT_CENTS) {
    throw new AppError('INVALID_BOLETO', 'Valor excede o limite do código de barras.', 422);
  }
  const dueFactor = dueDateFactor(input.dueDate);
  const withoutDigit =
    BOLETO_BANK_CODE +
    BOLETO_CURRENCY_CODE +
    String(dueFactor).padStart(4, '0') +
    String(amountCents).padStart(10, '0') +
    freeField;
  const generalDigit = mod11Digit(withoutDigit);
  const barcode = withoutDigit.slice(0, 4) + generalDigit + withoutDigit.slice(4);
  return {
    barcode,
    digitableLine: buildDigitableLine(barcode),
    dueFactor,
    generalDigit,
    freeField,
  };
}

export interface ParsedBoleto {
  barcode: string;
  digitableLine: string;
  bankCode: string;
  currencyCode: string;
  dueFactor: number;
  dueDate: string;
  amountCents: number;
  freeField: string;
}

/** Reconstrói o código de barras a partir da linha digitável (44 ou 47 dígitos). */
export function toBarcode(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length === 44) return digits;
  if (digits.length !== 47) {
    throw new AppError('INVALID_BOLETO', 'Boleto deve ter 44 (barras) ou 47 (linha digitável) dígitos.', 422);
  }
  return digits.slice(0, 4) + digits[32] + digits.slice(33, 47) + digits.slice(4, 9) + digits.slice(10, 20) + digits.slice(21, 31);
}

export function isBarcode(input: string): boolean {
  const code = onlyDigits(input);
  if (code.length !== 44) return false;
  if (code.slice(0, 3) !== BOLETO_BANK_CODE || code[3] !== BOLETO_CURRENCY_CODE) return false;
  return Number(code[4]) === mod11Digit(code.slice(0, 4) + code.slice(5));
}

export function isDigitableLine(input: string): boolean {
  const digits = onlyDigits(input);
  if (digits.length !== 47) return false;
  if (mod10Digit(digits.slice(0, 9)) !== Number(digits[9])) return false;
  if (mod10Digit(digits.slice(10, 20)) !== Number(digits[20])) return false;
  if (mod10Digit(digits.slice(21, 31)) !== Number(digits[31])) return false;
  return isBarcode(toBarcode(digits));
}

export function parseBoleto(input: string): ParsedBoleto {
  const digits = onlyDigits(input);
  const barcode = toBarcode(digits);
  if (!isBarcode(barcode)) {
    throw new AppError('INVALID_BOLETO', 'Código de barras inválido para o arranjo 077.', 422);
  }
  const dueFactor = Number(barcode.slice(5, 9));
  return {
    barcode,
    digitableLine: buildDigitableLine(barcode),
    bankCode: barcode.slice(0, 3),
    currencyCode: barcode[3],
    dueFactor,
    dueDate: factorToDate(dueFactor),
    amountCents: Number(barcode.slice(9, 19)),
    freeField: barcode.slice(19, 44),
  };
}

export function formatDigitableLine(input: string): string {
  const digits = onlyDigits(input);
  if (digits.length !== 47) return digits;
  return `${digits.slice(0, 5)}.${digits.slice(5, 10)} ${digits.slice(10, 15)}.${digits.slice(15, 21)} ${digits.slice(21, 26)}.${digits.slice(26, 32)} ${digits[32]} ${digits.slice(33)}`;
}

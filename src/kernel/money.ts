import { AppError } from './errors.ts';

/** Dinheiro trafega sempre em centavos inteiros. Nunca use float para saldo. */
export type Cents = number;

export const MAX_TRANSACTION_CENTS = 100_000_000; // R$ 1.000.000,00
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new AppError('INVALID_AMOUNT', 'Valor monetário inválido.', 422);
  }
  return value;
}

export function assertPositiveCents(value: number, field = 'amount_cents'): Cents {
  assertCents(value);
  if (value <= 0) throw new AppError('INVALID_AMOUNT', `${field} deve ser maior que zero.`, 422);
  if (value > MAX_TRANSACTION_CENTS) {
    throw new AppError('AMOUNT_LIMIT', `${field} excede o limite de R$ 1.000.000,00.`, 422);
  }
  return value;
}

export function addCents(...values: Cents[]): Cents {
  return values.reduce((total, value) => total + assertCents(value), 0);
}

/** Aplica taxa em basis points (1 bps = 0,01%) com arredondamento bancário para o centavo. */
export function bps(amount: Cents, rateBps: number): Cents {
  if (!Number.isFinite(rateBps) || rateBps < 0) throw new AppError('INVALID_RATE', 'Taxa inválida.', 422);
  return Math.round((assertCents(amount) * rateBps) / 10_000);
}

export function formatBRL(amount: Cents): string {
  return brl.format(assertCents(amount) / 100);
}

/** Aceita "1.234,56", "1234.56", 1234.56 (reais). Para API prefira sempre centavos. */
export function parseBRLToCents(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new AppError('INVALID_AMOUNT', 'Valor inválido.', 422);
    }
    return assertCents(Math.round(input * 100));
  }
  const cleaned = input.trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (!cleaned) throw new AppError('INVALID_AMOUNT', 'Valor vazio.', 422);
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new AppError('INVALID_AMOUNT', `Valor monetário inválido: ${input}`, 422);
  }
  return assertCents(Math.round(Number(normalized) * 100));
}

/** Serializa centavos para o formato do campo 54 do BR Code Pix ("1234.56"). */
export function centsToDecimal(amount: Cents): string {
  return (assertCents(amount) / 100).toFixed(2);
}

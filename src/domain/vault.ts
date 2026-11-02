import { AppError } from '../kernel/errors.ts';
import { fingerprint } from '../kernel/crypto.ts';

export interface CardMeta {
  brand: string;
  last4: string;
  fingerprint: string;
}

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  master: 'Mastercard',
  elo: 'Elo',
  amex: 'Amex',
  hiper: 'Hipercard',
};

const TOKEN_PATTERN = /^tok_([a-z]{3,10})_(\d{4})_([a-f0-9]{8,32})$/i;

/**
 * Fronteira P2PE/HSM: a API recebe apenas o token produzido na origem (Secure Enclave /
 * Android Keystore + DUKPT). Nunca aceitamos PAN em claro — se parecer PAN, rejeitamos.
 */
export function resolvePaymentToken(token: string, masterKey: string): CardMeta {
  if (typeof token !== 'string' || token.length > 128) {
    throw new AppError('INVALID_PAYMENT_TOKEN', 'Token de pagamento inválido.', 422);
  }
  if (/^\d[\d\s-]{12,}$/.test(token)) {
    throw new AppError(
      'PAN_NOT_ACCEPTED',
      'Dados de cartão em claro são proibidos. Envie o token P2PE gerado no dispositivo.',
      422,
    );
  }
  const match = TOKEN_PATTERN.exec(token);
  if (!match) throw new AppError('INVALID_PAYMENT_TOKEN', 'Formato de token P2PE inválido.', 422);
  const brandKey = match[1].toLowerCase();
  const brand = BRANDS[brandKey];
  if (!brand) throw new AppError('UNKNOWN_BRAND', `Bandeira desconhecida: ${brandKey}.`, 422);
  return {
    brand,
    last4: match[2],
    fingerprint: fingerprint(match[3].toLowerCase(), masterKey),
  };
}

/** Usado só pela maquininha/app de demonstração — em produção quem gera é o SDK de Tap to Pay. */
export function devTokenFor(brandKey: string, last4: string, seed: string): string {
  const brand = BRANDS[brandKey] ? brandKey.toLowerCase() : 'visa';
  const hash = fingerprint(seed, 'dev-vault').slice(0, 16);
  return `tok_${brand}_${last4}_${hash}`;
}

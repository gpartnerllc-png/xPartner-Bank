import { sha256Hex } from '../kernel/crypto.ts';
import type { PaymentMethod } from './risk.ts';

export interface AuthorizationRequest {
  amountCents: number;
  method: PaymentMethod;
  installments: number;
  brand?: string;
  last4?: string;
  acquirerId: string;
  terminalId: string;
  merchantId: string;
  seed: string;
}

export interface AuthorizationResult {
  approved: boolean;
  responseCode: string;
  nsu: string;
  authorizationCode: string;
  message: string;
}

function digitsFrom(hex: string, length: number): string {
  const value = BigInt(`0x${hex}`).toString();
  return value.padStart(length, '0').slice(0, length);
}

/**
 * Simulador de emissor/bandeira com respostas ISO 8583 e resultado determinístico
 * (o mesmo payload gera a mesma resposta, o que preserva idempotência e testes).
 */
export function authorize(request: AuthorizationRequest): AuthorizationResult {
  const hash = sha256Hex(
    [
      request.acquirerId,
      request.terminalId,
      request.merchantId,
      request.amountCents,
      request.method,
      request.installments,
      request.brand ?? '',
      request.last4 ?? '',
      request.seed,
    ].join('|'),
  );

  const nsu = digitsFrom(hash.slice(0, 16), 12);
  const authorizationCode = digitsFrom(hash.slice(16, 32), 6);

  if (request.last4 === '0000') {
    return {
      approved: false,
      responseCode: '05',
      nsu,
      authorizationCode,
      message: 'Recusado pelo emissor (cartão bloqueado para esta compra).',
    };
  }
  if (request.amountCents > 2_000_000) {
    return {
      approved: false,
      responseCode: '61',
      nsu,
      authorizationCode,
      message: 'Valor excede o limite da transação no emissor.',
    };
  }

  const draw = Number.parseInt(hash.slice(32, 40), 16) / 0xffffffff;
  if (draw > 0.986) {
    return {
      approved: false,
      responseCode: '51',
      nsu,
      authorizationCode,
      message: 'Saldo/limite insuficiente no emissor.',
    };
  }

  return {
    approved: true,
    responseCode: '00',
    nsu,
    authorizationCode,
    message: 'Aprovada.',
  };
}

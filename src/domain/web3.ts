import { sha256Hex } from '../kernel/crypto.ts';
import { AppError } from '../kernel/errors.ts';

/**
 * Primitivas Web3 institucionais compartilhadas pelo core e pelos contratos de referência.
 *
 * O digest de oferta espelha o conjunto de campos do typed data EIP-712 (AtomicDVP.sol),
 * mas usa SHA-256 porque o core não carrega keccak256. Estrutura compatível, hash não:
 * a assinatura on-chain é verificada com keccak256 no contrato, nunca com este digest.
 */

export const DVP_DOMAIN_NAME = 'xPartner Atomic DVP';
export const DVP_DOMAIN_VERSION = '1';
export const AGRO_ESCROW_HOLDER = 'xpartner:escrow:agro';

export interface DvpOfferFields {
  maker: string;
  taker: string | null;
  sellSymbol: string;
  sellUnits: number;
  buySymbol: string | null;
  buyUnits: number | null;
  cashCents: number;
  feeBps: number;
  nonce: string;
  expiresAt: string;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normalizeAddress(value: string, field: string): string {
  const address = String(value ?? '').trim();
  if (!isEvmAddress(address)) {
    throw new AppError('WEB3_ADDRESS', `${field} deve ser um endereço EVM (0x + 40 hexadecimais).`, 422);
  }
  return address.toLowerCase();
}

export function optionalAddress(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizeAddress(String(value), field);
}

export function normalizeWeb3Symbol(value: unknown, field = 'symbol'): string {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(symbol)) {
    throw new AppError('WEB3_SYMBOL', `${field} deve ter de 3 a 12 caracteres alfanuméricos.`, 422);
  }
  return symbol;
}

/** Separador de domínio typed-data no formato EIP-712, com hash SHA-256 do core. */
export function domainSeparator(chainId: number, verifyingContract: string): string {
  const canonical =
    `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` +
    `|${DVP_DOMAIN_NAME}|${DVP_DOMAIN_VERSION}|${chainId}|${verifyingContract.toLowerCase()}`;
  return sha256Hex(canonical);
}

/** Digest determinístico da oferta; a ordem dos campos é o contrato de compatibilidade. */
export function dvpOfferDigest(
  domain: { chainId: number; verifyingContract: string },
  offer: DvpOfferFields,
): string {
  const struct = {
    maker: offer.maker.toLowerCase(),
    taker: (offer.taker ?? '').toLowerCase(),
    sellSymbol: offer.sellSymbol,
    sellUnits: offer.sellUnits,
    buySymbol: offer.buySymbol ?? '',
    buyUnits: offer.buyUnits ?? 0,
    cashCents: offer.cashCents,
    feeBps: offer.feeBps,
    nonce: offer.nonce,
    expiresAt: offer.expiresAt,
  };
  return sha256Hex(`${domainSeparator(domain.chainId, domain.verifyingContract)}|${JSON.stringify(struct)}`);
}

/** Hash da atestação de predicado: só o emissor conhece o valor que originou o compromisso. */
export function attestationHash(input: {
  commitment: string;
  claimType: string;
  predicate: string;
  threshold: number;
  issuer: string;
  expiresAt: string;
}): string {
  return sha256Hex(
    `xpartner:attest:v1:${input.commitment}:${input.claimType}:${input.predicate}:${input.threshold}:` +
      `${input.issuer}:${input.expiresAt}`,
  );
}

/** Nullifier por compromisso, finalidade e época diária: impede reutilização entre partes. */
export function nullifierFor(commitment: string, purpose: string, epoch: string): string {
  return sha256Hex(`xpartner:nullifier:v1:${commitment}:${purpose}:${epoch}`);
}

export function sessionKeyHash(sessionKey: string): string {
  return sha256Hex(`xpartner:agent-session:v1:${sessionKey}`);
}

export function todayEpoch(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Converte preço fixed-point do oráculo em centavos por unidade inteira do token. */
export function oracleCentsPerUnit(priceUnits: number, decimals: number): number {
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) {
    throw new AppError('ORACLE_PRICE', 'Preço do oráculo inválido.', 422);
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new AppError('ORACLE_DECIMALS', 'Decimais do oráculo inválidos.', 422);
  }
  const cents = Math.round((priceUnits * 100) / 10 ** decimals);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new AppError('ORACLE_PRICE', 'Preço do oráculo excede o limite numérico.', 422);
  }
  return cents;
}

/** LTV em basis points; dívida zero resulta em LTV zero, colateral zero em 10000. */
export function loanToValueBps(debtCents: number, collateralCents: number): number {
  if (debtCents <= 0) return 0;
  if (collateralCents <= 0) return 10_000;
  return Math.round((debtCents * 10_000) / collateralCents);
}

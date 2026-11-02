import { HttpError } from './http.ts';

/** CRC16/CCITT-FALSE, exigido pelo padrão EMV do BR Code (Pix). */
export function crc16(payload: string): string {
  let crc = 0xffff;
  const bytes = new TextEncoder().encode(payload);
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id: string, value: string): string {
  const length = new TextEncoder().encode(value).length;
  if (length > 99) throw new HttpError(422, 'PIX_FIELD_TOO_LONG', `Campo ${id} excede 99 bytes.`);
  return `${id}${String(length).padStart(2, '0')}${value}`;
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .,'-]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, maxLength);
}

export function normalizeTxid(value: string | undefined): string {
  if (!value) return '***';
  const cleaned = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  if (!cleaned) throw new HttpError(422, 'INVALID_TXID', 'txid do Pix inválido.');
  return cleaned;
}

export interface PixPayloadInput {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amountCents?: number;
  txid?: string;
  description?: string;
  mcc?: string;
}

/** Monta o BR Code estático/dinâmico (EMV® QRCPS) com CRC16 válido. */
export function buildPixPayload(input: PixPayloadInput): string {
  const key = input.pixKey.trim();
  if (!key) throw new HttpError(422, 'PIX_KEY_REQUIRED', 'Chave Pix ausente.');
  const name = normalizeText(input.merchantName, 25) || 'XPARTNER';
  const city = normalizeText(input.merchantCity, 15) || 'SAO PAULO';
  const txid = normalizeTxid(input.txid);
  const mcc = (input.mcc ?? '5499').replace(/\D/g, '').padStart(4, '0').slice(0, 4);

  let merchantAccount = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  if (input.description) merchantAccount += tlv('02', normalizeText(input.description, 40));

  const payload =
    tlv('00', '01') +
    tlv('26', merchantAccount) +
    tlv('52', mcc) +
    tlv('53', '986') +
    (input.amountCents === undefined ? '' : tlv('54', (input.amountCents / 100).toFixed(2))) +
    tlv('58', 'BR') +
    tlv('59', name) +
    tlv('60', city) +
    tlv('62', tlv('05', txid)) +
    '6304';

  return payload + crc16(payload);
}

export function validatePixPayload(payload: string): boolean {
  if (!payload.includes('6304') || payload.length < 8) return false;
  const base = payload.slice(0, payload.lastIndexOf('6304') + 4);
  const provided = payload.slice(base.length).toUpperCase();
  return provided.length === 4 && crc16(base) === provided;
}

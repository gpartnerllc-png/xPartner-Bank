import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let time = ms;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/** ULID ordenável por tempo (26 chars) para chaves primárias distribuídas. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function newId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function alphanumeric(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function numeric(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(bytes[i] % 10);
  return out;
}

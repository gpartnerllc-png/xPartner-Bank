import { HttpError } from './http.ts';

const encoder = new TextEncoder();
// Acima de 100k iterações o PBKDF2 estoura o limite de CPU do Workers e a derivação falha.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_COOKIE = 'xp_bank_session';

const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  'senha123456',
  'password123',
  'qwerty12345',
  'xpartner123',
  'banco12345',
  'admin12345',
  '12345678a',
  'abcdef1234',
]);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(bytes = 32): string {
  return toBase64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  return constantTimeEqual(encoder.encode(left), encoder.encode(right));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !saltRaw || !hashRaw) return false;
  const iterations = Number.parseInt(iterationsRaw ?? '', 10);
  if (!Number.isFinite(iterations) || iterations < 100_000 || iterations > 600_000) return false;
  try {
    const expected = fromBase64(hashRaw);
    const actual = await pbkdf2(password, fromBase64(saltRaw), iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface PasswordContext {
  name: string;
  document: string;
  email: string;
}

export function validatePassword(password: string, context: PasswordContext): void {
  if (password.length < 10 || password.length > 128) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'A senha deve ter entre 10 e 128 caracteres.');
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'A senha deve combinar letras e números.');
  }
  const normalized = password.toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'Escolha uma senha menos previsível.');
  }
  const forbidden = [
    ...context.name.toLowerCase().split(/\s+/).filter((part) => part.length >= 3),
    context.document.replace(/\D/g, ''),
    context.email.toLowerCase().split('@')[0] ?? '',
  ].filter((part) => part.length >= 3);
  if (forbidden.some((part) => normalized.includes(part))) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'A senha não pode conter seu nome, documento ou e-mail.');
  }
}

export function generateTempPassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const alphabet = letters + digits;
  const bytes = randomBytes(12);
  let body = '';
  for (let index = 0; index < 10; index += 1) body += alphabet[bytes[index] % alphabet.length];
  const digitA = digits[(bytes[10] ?? 0) % digits.length];
  const digitB = digits[(bytes[11] ?? 0) % digits.length];
  return `Xp${digitA}${body.slice(0, 5)}${digitB}${body.slice(5)}`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

export function sessionCookie(token: string, ttlSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ttlSeconds}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', secure ? 'Secure' : '']
    .filter(Boolean)
    .join('; ');
}

export function readSessionToken(request: Request): { token: string; viaCookie: boolean } | null {
  const authorization = request.headers.get('Authorization') ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return { token, viaCookie: false };
  }
  const cookie = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (cookie) return { token: cookie, viaCookie: true };
  return null;
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export async function rateLimit(
  env: { CACHE: KVNamespace },
  scope: string,
  limit: number,
  windowSeconds = 60,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${scope}:${bucket}`;
  const current = Number.parseInt((await env.CACHE.get(key)) ?? '0', 10) || 0;
  if (current >= limit) {
    throw new HttpError(429, 'RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.', {
      retryAfterSeconds: windowSeconds,
    });
  }
  await env.CACHE.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
}

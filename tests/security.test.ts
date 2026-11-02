import assert from 'node:assert/strict';
import test from 'node:test';
import { NonceCache, constantTimeEqualHex, hmacHex, signToken, verifyToken } from '../src/kernel/crypto.ts';
import { SlidingWindowLimiter } from '../src/api/security.ts';
import { devTokenFor, resolvePaymentToken } from '../src/domain/vault.ts';

const SECRET = 'segredo-de-teste-para-hmac-0123456789';

test('token: assina, verifica e rejeita adulteração', () => {
  const token = signToken({ sub: 'mch_x', merchantId: 'mch_x', scope: 'demo:read demo:write' }, SECRET, 600);
  const claims = verifyToken(token, SECRET);
  assert.equal(claims.merchantId, 'mch_x');
  assert.equal(claims.scope, 'demo:read demo:write');

  const [version, body, signature] = token.split('.');
  const tampered = `${version}.${body.slice(0, -2)}AA.${signature}`;
  assert.throws(() => verifyToken(tampered, SECRET), /Assinatura de token inválida|Token ilegível/);
  assert.throws(() => verifyToken(token, `${SECRET}x`), /Assinatura de token inválida/);
});

test('token: respeita expiração', () => {
  const token = signToken({ sub: 'mch_x', merchantId: 'mch_x', scope: 'demo:read' }, SECRET, 60);
  assert.throws(() => verifyToken(token, SECRET, Date.now() + 61_000), /Token expirado/);
});

test('hmac: assinatura determinística e comparação em tempo constante', () => {
  const left = hmacHex(SECRET, 'timestamp.nonce.corpo');
  const right = hmacHex(SECRET, 'timestamp.nonce.corpo');
  assert.equal(left, right);
  assert.equal(constantTimeEqualHex(left, right), true);
  assert.equal(constantTimeEqualHex(left, hmacHex(SECRET, 'outro-corpo')), false);
});

test('nonce: bloqueia replay', () => {
  const cache = new NonceCache(60_000);
  assert.equal(cache.use('nonce-1'), true);
  assert.equal(cache.use('nonce-1'), false);
  assert.equal(cache.use('nonce-2'), true);
});

test('rate limit: janela deslizante bloqueia após o limite', () => {
  const limiter = new SlidingWindowLimiter(3);
  const now = 1_000_000;
  assert.equal(limiter.consume('trm_1', now), true);
  assert.equal(limiter.consume('trm_1', now + 1), true);
  assert.equal(limiter.consume('trm_1', now + 2), true);
  assert.equal(limiter.consume('trm_1', now + 3), false);
  assert.equal(limiter.consume('trm_1', now + 61_000), true);
});

test('P2PE: aceita token opaco e rejeita PAN em claro', () => {
  const token = devTokenFor('visa', '4242', 'cartao-de-teste');
  const card = resolvePaymentToken(token, SECRET);
  assert.equal(card.brand, 'Visa');
  assert.equal(card.last4, '4242');
  assert.match(card.fingerprint, /^[a-f0-9]{32}$/);

  assert.throws(() => resolvePaymentToken('4111 1111 1111 1111', SECRET), /PAN|proibidos/);
  assert.throws(() => resolvePaymentToken('tok_visa_4242', SECRET), /Formato de token/);
  assert.throws(() => resolvePaymentToken('tok_diners_4242_abcdef12', SECRET), /Bandeira desconhecida/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTempPassword,
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../src/security.ts';
import {
  accountCheckDigit,
  assertDocument,
  formatAccountNumber,
  parseAmountCents,
  sanitizeIdempotencyKey,
} from '../src/validation.ts';

test('senha PBKDF2 verifica corretamente e rejeita senha errada', async () => {
  const stored = await hashPassword('BancoForte2026');
  assert.match(stored, /^pbkdf2\$210000\$/);
  assert.equal(await verifyPassword('BancoForte2026', stored), true);
  assert.equal(await verifyPassword('BancoForte2027', stored), false);
  assert.equal(await verifyPassword('BancoForte2026', 'lixo'), false);
});

test('política de senha bloqueia fraca e dados pessoais', () => {
  const context = { name: 'Ana Souza', document: '52998224725', email: 'ana@xpartner.test' };
  assert.throws(() => validatePassword('curta1', context), /entre 10 e 128/);
  assert.throws(() => validatePassword('somenteletras', context), /letras e números/);
  assert.throws(() => validatePassword('AnaLinda2026', context), /nome, documento ou e-mail/);
  assert.doesNotThrow(() => validatePassword('ClienteForte2026', context));
});

test('senha temporária tem 14 caracteres, letras e dígitos', () => {
  const password = generateTempPassword();
  assert.equal(password.length, 14);
  assert.match(password, /[A-Za-z]/);
  assert.match(password, /[0-9]/);
});

test('CPF/CNPJ validam dígitos verificadores', () => {
  assert.equal(assertDocument('529.982.247-25').kind, 'PF');
  assert.throws(() => assertDocument('529.982.247-24'), /inválido/);
  assert.equal(assertDocument('11.222.333/0001-81').kind, 'PJ');
});

test('dígito da conta e formatação são determinísticos', () => {
  const number = formatAccountNumber(1_000_001);
  assert.equal(number.length, 8);
  assert.equal(number.slice(-1), accountCheckDigit(number.slice(0, 7)));
  assert.equal(formatAccountNumber(1_000_001), number);
});

test('valores em centavos aceitam inteiro e formato brasileiro', () => {
  assert.equal(parseAmountCents(12_500), 12_500);
  assert.equal(parseAmountCents('125,00'), 12_500);
  assert.equal(parseAmountCents('1.234,56'), 123_456);
  assert.throws(() => parseAmountCents(0), /valor positivo/);
  assert.throws(() => parseAmountCents('abc'), /valor positivo/);
});

test('chave de idempotência exige tamanho e caracteres seguros', () => {
  assert.equal(sanitizeIdempotencyKey('idem-12345678'), 'idem-12345678');
  assert.throws(() => sanitizeIdempotencyKey('curta'), /8 a 120/);
  assert.throws(() => sanitizeIdempotencyKey('chave com espaço 123'), /caracteres inválidos/);
  assert.equal(sanitizeIdempotencyKey(undefined), null);
});

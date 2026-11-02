import assert from 'node:assert/strict';
import test from 'node:test';
import { bps, centsToDecimal, formatBRL, parseBRLToCents } from '../src/kernel/money.ts';

test('dinheiro: parsing de BRL em centavos inteiros', () => {
  assert.equal(parseBRLToCents('R$ 1.234,56'), 123456);
  assert.equal(parseBRLToCents('1234.56'), 123456);
  assert.equal(parseBRLToCents('129'), 12900);
  assert.equal(parseBRLToCents(12.34), 1234);
  assert.equal(parseBRLToCents('0,05'), 5);
});

test('dinheiro: rejeita valores inválidos', () => {
  assert.throws(() => parseBRLToCents('-3'), /Valor monetário inválido/);
  assert.throws(() => parseBRLToCents('12,3,4'), /Valor monetário inválido/);
  assert.throws(() => bps(1000, -1), /Taxa inválida/);
});

test('dinheiro: taxa em basis points com arredondamento ao centavo', () => {
  assert.equal(bps(12_900, 215), 277);
  assert.equal(bps(250_000, 189), 4725);
  assert.equal(bps(18_900, 119), 225);
});

test('dinheiro: formatação e serialização para o BR Code', () => {
  assert.match(formatBRL(123456), /1\.234,56/);
  assert.equal(centsToDecimal(3490), '34.90');
});

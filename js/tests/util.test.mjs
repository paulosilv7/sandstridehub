import test from 'node:test';
import assert from 'node:assert/strict';
import { soma, valor, esc, prim, dataDe } from '../util.js';

test('soma anda dias no calendário, inclusive na virada de mês e de ano', () => {
  assert.equal(soma('2026-11-30', 1), '2026-12-01');
  assert.equal(soma('2026-01-01', -1), '2025-12-31');
  assert.equal(soma('2026-03-01', -1), '2026-02-28');
});

test('valor escreve reais, porcentagem e quantidade no formato brasileiro', () => {
  assert.equal(valor(18450.5, 'reais'), 'R$ 18.450,50');
  assert.equal(valor(62, 'pct'), '62%');
  assert.equal(valor(62.5, 'pct'), '62,5%');
  assert.equal(valor(1200, 'un'), '1.200');
});

test('esc protege texto digitado antes de ir para o HTML', () => {
  assert.equal(esc('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
  assert.equal(esc(null), '');
});

test('prim devolve só o primeiro nome', () => {
  assert.equal(prim('Paulo Silva'), 'Paulo');
  assert.equal(prim(undefined), '');
});

test('dataDe usa meio-dia UTC para o dia não mudar com o fuso', () => {
  assert.equal(dataDe('2026-11-23').getUTCDay(), 1);
});

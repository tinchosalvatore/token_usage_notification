/**
 * Tests del tokenizador heurístico. Corren sin browser ni dependencias:
 *   node --test
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { approxTokens } = require('../tokenizer.js');

test('vacío / nulo → 0', () => {
  assert.equal(approxTokens(''), 0);
  assert.equal(approxTokens(null), 0);
  assert.equal(approxTokens(undefined), 0);
});

test('palabra corta latina → 1 token', () => {
  assert.equal(approxTokens('hola'), 1);   // ceil(4/4)
  assert.equal(approxTokens('de'), 1);
});

test('palabra larga → ceil(largo/4)', () => {
  assert.equal(approxTokens('tokenizador'), 3); // ceil(11/4)
});

test('dígitos agrupan ~3/token', () => {
  assert.equal(approxTokens('123'), 1);
  assert.equal(approxTokens('1234'), 2);    // ceil(4/3)
});

test('puntuación y emoji → 1 por símbolo', () => {
  assert.equal(approxTokens('!'), 1);
  assert.equal(approxTokens('🚀'), 1);       // emoji astral = 1 code point
});

test('whitespace no suma', () => {
  assert.equal(approxTokens('hola'), approxTokens('   hola   '));
});

test('monotonía: más texto nunca cuenta menos', () => {
  const a = approxTokens('una frase corta');
  const b = approxTokens('una frase corta y bastante más larga que la anterior');
  assert.ok(b > a);
});

test('alfabeto no latino cuenta ~1/char', () => {
  assert.equal(approxTokens('你好'), 2);
});

test('frase mixta es suma de partes', () => {
  // "hola" (1) + "," (1) + "mundo" (ceil5/4=2) + "!" (1) = 5
  assert.equal(approxTokens('hola, mundo!'), 5);
});

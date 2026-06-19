/**
 * Tests de pricing (modelo → límite y costo). node --test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pricing.js');

test('modelKey detecta familia', () => {
  assert.equal(P.modelKey('claude-opus-4-8'), 'opus');
  assert.equal(P.modelKey('claude-sonnet-4-6'), 'sonnet');
  assert.equal(P.modelKey('claude-haiku-4-5'), 'haiku');
  assert.equal(P.modelKey('desconocido'), null);
});

test('modelLimit: 1M vs default', () => {
  assert.equal(P.modelLimit('claude-sonnet-4-6[1m]'), 1_000_000);
  assert.equal(P.modelLimit('claude-opus-4-8'), 200_000);
  assert.equal(P.modelLimit('', 123), 123);
});

test('estimateCost: input + output', () => {
  // sonnet: $3/Mtok in, $15/Mtok out
  const cost = P.estimateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
  assert.equal(cost, 18);
});

test('estimateCost: caché read barata (10% del input)', () => {
  // opus: $15/Mtok in → cache read = $1.5/Mtok
  const cost = P.estimateCost({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-4-8');
  assert.equal(cost, 1.5);
});

test('estimateCost: modelo desconocido → 0', () => {
  assert.equal(P.estimateCost({ input_tokens: 1000 }, 'mystery'), 0);
});

test('fmtCost', () => {
  assert.equal(P.fmtCost(0), '$0');
  assert.equal(P.fmtCost(0.004), '<$0.01');
  assert.equal(P.fmtCost(1.2345), '$1.23');
});

/**
 * Tests del parser de usage real. node --test
 *
 * Cubren formatos plausibles del stream interno de claude.ai (basados en el
 * esquema de streaming de Anthropic: message_start / message_delta). Como el
 * formato real no está documentado, el parser es defensivo y estos tests fijan
 * el comportamiento esperado contra varias formas.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractUsage, contextTokens } = require('../usage-parser.js');

test('texto vacío / sin JSON → null', () => {
  assert.equal(extractUsage(''), null);
  assert.equal(extractUsage('garbage no json'), null);
});

test('SSE estilo Anthropic: merge de message_start + message_delta', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"cache_read_input_tokens":500,"cache_creation_input_tokens":0,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":250}}',
    '',
    'data: [DONE]',
  ].join('\n');
  const u = extractUsage(sse);
  assert.equal(u.input_tokens, 1000);
  assert.equal(u.cache_read_input_tokens, 500);
  assert.equal(u.output_tokens, 250);          // toma el mayor del delta
  assert.equal(u.model, 'claude-opus-4-8');
  assert.equal(contextTokens(u), 1500);
});

test('JSON plano no-stream con usage en root', () => {
  const json = JSON.stringify({ model: 'claude-sonnet-4-6', usage: { input_tokens: 42, output_tokens: 7 } });
  const u = extractUsage(json);
  assert.equal(u.input_tokens, 42);
  assert.equal(u.output_tokens, 7);
  assert.equal(u.model, 'claude-sonnet-4-6');
});

test('usage anidado en message', () => {
  const json = JSON.stringify({ message: { model: 'x', usage: { input_tokens: 9 } } });
  const u = extractUsage(json);
  assert.equal(u.input_tokens, 9);
});

test('toma el mayor output entre múltiples deltas', () => {
  const sse = [
    'data: {"usage":{"output_tokens":10}}',
    'data: {"usage":{"output_tokens":120}}',
    'data: {"usage":{"output_tokens":80}}',
  ].join('\n');
  assert.equal(extractUsage(sse).output_tokens, 120);
});

test('ignora líneas parciales/corruptas sin romper', () => {
  const sse = [
    'data: {"message":{"usage":{"input_tokens":5',   // truncado
    'data: {"usage":{"input_tokens":300,"output_tokens":5}}',
  ].join('\n');
  const u = extractUsage(sse);
  assert.equal(u.input_tokens, 300);
});

test('solo modelo, sin tokens → igual devuelve (model útil)', () => {
  const u = extractUsage('data: {"message":{"model":"claude-haiku-4-5"}}');
  assert.equal(u.model, 'claude-haiku-4-5');
});

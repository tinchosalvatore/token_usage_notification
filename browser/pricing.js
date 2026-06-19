/**
 * pricing.js — Modelo → límite de contexto y costo en USD.
 *
 * Precios APROXIMADOS por millón de tokens (USD), tarifas públicas de Anthropic.
 * Actualizar si cambian. El costo es estimativo; sirve para orden de magnitud.
 *
 * Módulo dual: ISOLATED world (expone self.Pricing) + Node (module.exports).
 */
(function (root) {
  'use strict';

  // USD por millón de tokens.
  const MODEL_PRICING = {
    opus:   { in: 15,   out: 75 },
    sonnet: { in: 3,    out: 15 },
    haiku:  { in: 0.80, out: 4  },
  };

  // Multiplicadores de caché respecto al precio de input.
  const CACHE_READ_MULT  = 0.10;   // leer de caché es ~10% del input
  const CACHE_WRITE_MULT = 1.25;   // crear caché es ~125% del input

  const DEFAULT_LIMIT = 200_000;

  function modelKey(model) {
    const m = (model || '').toLowerCase();
    if (m.includes('opus'))   return 'opus';
    if (m.includes('haiku'))  return 'haiku';
    if (m.includes('sonnet')) return 'sonnet';
    return null;
  }

  function modelLimit(model, fallback = DEFAULT_LIMIT) {
    const m = (model || '').toLowerCase();
    if (m.includes('1m') || m.includes('[1m]')) return 1_000_000;
    return fallback;
  }

  // Costo USD de UN turno (request) dado su usage real.
  function estimateCost(usage, model) {
    const key = modelKey(model);
    if (!key) return 0;
    const p = MODEL_PRICING[key];
    const perM = (v) => (v || 0) / 1_000_000;
    return (
      perM(usage.input_tokens)                * p.in
      + perM(usage.output_tokens)             * p.out
      + perM(usage.cache_read_input_tokens)   * p.in * CACHE_READ_MULT
      + perM(usage.cache_creation_input_tokens) * p.in * CACHE_WRITE_MULT
    );
  }

  function fmtCost(usd) {
    if (!usd) return '$0';
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
  }

  const Pricing = {
    MODEL_PRICING, modelKey, modelLimit, estimateCost, fmtCost, DEFAULT_LIMIT,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Pricing;
  else root.Pricing = Pricing;
})(typeof self !== 'undefined' ? self : globalThis);

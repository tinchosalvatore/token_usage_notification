/**
 * usage-parser.js — Extrae el `usage` REAL de las respuestas de claude.ai.
 *
 * El frontend de claude.ai llama a su API interna y recibe un stream SSE cuyos
 * eventos contienen el `usage` real (tokens exactos + caché + modelo) — los
 * mismos números que ve la API de Anthropic. Este módulo parsea ese texto.
 *
 * ⚠️ FRÁGIL POR DISEÑO: el formato interno de claude.ai NO está documentado y
 * puede cambiar sin aviso. Por eso el parser es defensivo: busca cualquier JSON
 * con forma de `usage` y mergea, en vez de asumir un schema rígido. Si Anthropic
 * cambia el formato, esto deja de aportar números reales y el sistema cae al
 * estimador del DOM (no rompe).
 *
 * Módulo dual: MAIN world (expone self.UsageParser) + Node (module.exports).
 */
(function (root) {
  'use strict';

  // Campos de un usage normalizado (faltantes = 0 / '').
  function normalize(u, model) {
    return {
      input_tokens:                 (u && u.input_tokens)                 || 0,
      output_tokens:                (u && u.output_tokens)                || 0,
      cache_read_input_tokens:      (u && u.cache_read_input_tokens)      || 0,
      cache_creation_input_tokens:  (u && u.cache_creation_input_tokens)  || 0,
      model: model || '',
    };
  }

  // Tokens que el modelo "ve" en ese turno (contexto actual). Igual criterio
  // que el monitor de Python: input + ambas variantes de caché.
  function contextTokens(u) {
    return (u.input_tokens || 0)
      + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);
  }

  // De un objeto cualquiera saca {usage, model} si los tiene (en root o anidado).
  function pick(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const usage = obj.usage || (obj.message && obj.message.usage) || null;
    const model = obj.model || (obj.message && obj.message.model) || '';
    if (!usage && !model) return null;
    return { usage, model };
  }

  // Junta todos los objetos JSON presentes en un texto SSE (o JSON plano).
  function collectObjects(text) {
    const out = [];
    if (!text) return out;

    for (const rawLine of text.split('\n')) {
      let line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line === '[DONE]' || line[0] !== '{') continue;
      try { out.push(JSON.parse(line)); } catch { /* fragmento parcial */ }
    }

    // Caso no-stream: el body entero es un único JSON.
    if (!out.length) {
      try { out.push(JSON.parse(text)); } catch { /* no era JSON */ }
    }
    return out;
  }

  /**
   * Extrae el usage real de un texto de respuesta completo.
   * Mergea: input/caché/model suelen venir en message_start; output_tokens se
   * va actualizando en message_delta. Tomamos el mayor output visto.
   * Devuelve usage normalizado o null si no encontró nada usable.
   */
  function extractUsage(text) {
    let found = false;
    const acc = normalize(null, '');

    for (const obj of collectObjects(text)) {
      const p = pick(obj);
      if (!p) continue;
      found = true;
      if (p.model) acc.model = p.model;
      const u = p.usage;
      if (!u) continue;
      if (u.input_tokens)                acc.input_tokens                = u.input_tokens;
      if (u.cache_read_input_tokens)     acc.cache_read_input_tokens     = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens) acc.cache_creation_input_tokens = u.cache_creation_input_tokens;
      if (u.output_tokens)               acc.output_tokens = Math.max(acc.output_tokens, u.output_tokens);
    }

    if (!found) return null;
    // Algo útil = al menos un número o un modelo.
    if (!acc.model && contextTokens(acc) === 0 && acc.output_tokens === 0) return null;
    return acc;
  }

  const UsageParser = { extractUsage, contextTokens, normalize, collectObjects };

  if (typeof module !== 'undefined' && module.exports) module.exports = UsageParser;
  else root.UsageParser = UsageParser;
})(typeof self !== 'undefined' ? self : globalThis);

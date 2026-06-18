/**
 * tokenizer.js — Estimación de tokens (heurística BPE).
 *
 * Módulo dual: funciona como content script (expone `self.Tokenizer`) y como
 * módulo Node (`module.exports`) para poder testearlo sin un browser.
 *
 * ¿Por qué heurística y no el tokenizador real?
 * Anthropic no publica el tokenizador de los modelos Claude 3+. Esta función
 * aproxima el comportamiento de un BPE (Byte-Pair Encoding). Está aislada acá a
 * propósito: si en el futuro se vendorea un tokenizador real (tiktoken / vocab
 * oficial), se reemplaza SOLO `approxTokens` y todo lo demás sigue igual.
 *
 * Reglas empíricas (precisión ±~10% vs el real):
 *  - Palabras latinas  → ceil(largo / 4)   (BPE funde ~4 chars/token)
 *  - Dígitos           → ceil(largo / 3)   (BPE agrupa ~3 dígitos/token)
 *  - Otros alfabetos   → ~1 token por char (CJK, cirílico, árabe, etc.)
 *  - Puntuación/emoji  → 1 token por símbolo
 *  - Whitespace        → se funde en el token adyacente (no suma)
 */
(function (root) {
  'use strict';

  // Segmenta en: runs de letras+marcas | runs de dígitos | runs de espacio |
  // cualquier otro símbolo suelto (puntuación, emoji). Flag `u` → cada match
  // de "símbolo suelto" es un code point completo (emoji astral = 1).
  const SEGMENT_RE = /[\p{L}\p{M}]+|\p{N}+|\s+|[^\s\p{L}\p{N}]/gu;
  const LATIN_RE   = /[a-zA-ZÀ-ÿ]/;

  function approxTokens(text) {
    if (!text) return 0;
    let n = 0;
    for (const match of text.matchAll(SEGMENT_RE)) {
      const seg = match[0];
      const head = seg[0];

      if (/\s/.test(head)) continue;                       // whitespace: no suma
      if (/\p{N}/u.test(head)) n += Math.ceil(seg.length / 3);
      else if (LATIN_RE.test(head)) n += Math.max(1, Math.ceil(seg.length / 4));
      else if (/\p{L}/u.test(head)) n += seg.length;        // alfabetos no latinos
      else n += 1;                                           // puntuación / emoji
    }
    return n;
  }

  const Tokenizer = { approxTokens };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Tokenizer;          // Node (tests)
  } else {
    root.Tokenizer = Tokenizer;          // content script
  }
})(typeof self !== 'undefined' ? self : globalThis);

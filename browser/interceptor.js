/**
 * interceptor.js — Captura el usage REAL de la red de claude.ai (el "comodín").
 *
 * Corre en el MAIN world (mundo de la página, no el aislado del content script)
 * para poder hacer monkeypatch de fetch/XHR de la propia app. Lee una COPIA del
 * stream de respuesta (response.clone()), extrae el usage real con UsageParser y
 * lo manda al content script vía window.postMessage.
 *
 * Garantías:
 *  - Nunca rompe la página: todo en try/catch, y siempre devuelve la respuesta
 *    original intacta a la app (leemos un clon, no el stream original).
 *  - Solo lee TU propia sesión, TU propio tráfico. No toca datos de terceros.
 *  - Si el formato interno cambia, simplemente deja de emitir (no falla).
 *
 * ⚠️ FRÁGIL Y POSIBLE INCUMPLIMIENTO DE ToS: depende de endpoints internos no
 * documentados de claude.ai. No es ilegal (es tu data en tu browser), pero
 * Anthropic podría considerarlo contra sus Términos. Si no querés el riesgo,
 * quitá las dos entradas "world":"MAIN" del manifest y el sistema sigue
 * funcionando como estimador del DOM.
 */
(function () {
  'use strict';

  const parser = self.UsageParser;
  if (!parser) return;  // sin parser no hay nada que hacer

  // Heurística: ¿esta URL puede traer usage? (endpoints de completado/mensajes)
  function isInteresting(url, contentType) {
    const u = String(url || '');
    if (/event-stream/i.test(contentType || '')) return true;
    return /completion|messages|chat_conversations|\/retry/i.test(u);
  }

  function emit(usage) {
    if (!usage) return;
    try {
      window.postMessage({ __ctSource: 'ct-usage', usage }, window.location.origin);
    } catch { /* noop */ }
  }

  async function scanResponse(resp) {
    try {
      const text = await resp.text();          // clon: no afecta a la app
      emit(parser.extractUsage(text));
    } catch { /* noop */ }
  }

  // ── fetch ───────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = (args[0] && args[0].url) || args[0];
        p.then((resp) => {
          try {
            const ct = resp.headers && resp.headers.get('content-type');
            if (resp.ok && isInteresting(url, ct)) scanResponse(resp.clone());
          } catch { /* noop */ }
        }).catch(() => {});
      } catch { /* noop */ }
      return p;  // la app recibe la respuesta original sin tocar
    };
  }

  // ── XMLHttpRequest ──────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ctUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader('content-type');
          if (this.status >= 200 && this.status < 300
              && isInteresting(this.__ctUrl, ct) && this.responseType === '') {
            emit(parser.extractUsage(this.responseText || ''));
          }
        } catch { /* noop */ }
      });
    } catch { /* noop */ }
    return origSend.apply(this, args);
  };
})();

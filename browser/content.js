/**
 * Claude Token Counter — content.js
 *
 * Inyecta un contador de tokens debajo del chat input de claude.ai
 * y notifica al celular vía Telegram Bot cuando se alcanzan umbrales.
 *
 * SETUP: la config (token + chatId) NO vive acá. Se carga desde
 * chrome.storage.sync, que se edita en la página de opciones de la
 * extensión (chrome://extensions → Detalles → Opciones de extensión).
 * Ver options.html / options.js.
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────
  // CONFIGURACIÓN — se carga desde chrome.storage.sync (ver options.js)
  // ──────────────────────────────────────────────────────────────
  const TELEGRAM = { token: '', chatId: '' };
  let notifyEnabled = false;

  function loadConfig() {
    chrome.storage.sync.get(['telegramToken', 'telegramChatId'], (cfg) => {
      TELEGRAM.token  = cfg.telegramToken  || '';
      TELEGRAM.chatId = cfg.telegramChatId || '';
      notifyEnabled   = Boolean(TELEGRAM.token && TELEGRAM.chatId);
    });
  }
  loadConfig();
  // Reaccionar si el usuario cambia la config sin recargar la pestaña
  chrome.storage.onChanged.addListener(loadConfig);

  // Umbrales de notificación (% del contexto total)
  // Podés agregar, quitar o cambiar los valores
  const THRESHOLDS = [
    { pct: 0.50, emoji: '⚠️',  label: '50%' },
    { pct: 0.80, emoji: '🔴',  label: '80%' },
    { pct: 0.95, emoji: '🚨',  label: '95%' },
  ].map(t => ({ ...t, fired: false }));

  // ──────────────────────────────────────────────────────────────
  // CONSTANTES
  // ──────────────────────────────────────────────────────────────
  const CONTEXT_LIMIT = 200_000;
  const BAR_ID        = 'ct-token-bar';

  // ──────────────────────────────────────────────────────────────
  // TOKENIZADOR (aproximación BPE)
  //
  // BPE (Byte-Pair Encoding): el vocabulario se construye fusionando
  // pares de bytes/chars frecuentes. Resultado empírico:
  //  - Palabras comunes cortas  → 1 token
  //  - Palabras largas          → ceil(largo / 4) tokens
  //  - Dígitos                  → ~1 token por dígito
  //  - Puntuación y símbolos    → 1 token cada uno
  // Precisión vs tokenizador real de Anthropic: ±10–15%
  // ──────────────────────────────────────────────────────────────
  function approxTokens(text) {
    if (!text) return 0;
    let n = 0;
    for (const chunk of text.match(/[a-zA-ZÀ-ÿ]+|\d+|[^\s]/g) || []) {
      if (/[a-zA-ZÀ-ÿ]/.test(chunk)) n += Math.max(1, Math.ceil(chunk.length / 4));
      else if (/\d/.test(chunk))      n += chunk.length;
      else                             n += 1;
    }
    return n;
  }

  // ──────────────────────────────────────────────────────────────
  // ESTIMACIÓN DE CONVERSACIÓN
  //
  // Subimos por el DOM desde el editor buscando el primer contenedor
  // con scroll (el div que contiene los mensajes). Su innerText
  // menos el texto del input actual nos da el historial de chat.
  // Es una aproximación — incluye algo de UI textual, pero es útil.
  // ──────────────────────────────────────────────────────────────
  function estimateConversationTokens(editor) {
    let el = editor.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 50) break;
      el = el.parentElement;
    }
    if (!el || el === document.body) return 0;

    const fullText  = el.innerText  || '';
    const inputText = editor.innerText || '';
    const convText  = inputText ? fullText.replace(inputText, '') : fullText;
    return approxTokens(convText);
  }

  // ──────────────────────────────────────────────────────────────
  // NOTIFICACIONES VÍA TELEGRAM
  // ──────────────────────────────────────────────────────────────
  function checkAndNotify(convTokens) {
    if (!notifyEnabled) return;

    const ratio = convTokens / CONTEXT_LIMIT;

    for (const t of THRESHOLDS) {
      if (!t.fired && ratio >= t.pct) {
        t.fired = true;

        // Mandamos mensaje al service worker (background.js)
        // que a su vez hace el POST a la Telegram Bot API
        chrome.runtime.sendMessage({
          type:   'TELEGRAM_NOTIFY',
          token:  TELEGRAM.token,
          chatId: TELEGRAM.chatId,
          text:   `${t.emoji} <b>Claude: ${t.label} del contexto usado</b>\n` +
                  `<code>≈${convTokens.toLocaleString('es-AR')} / ${(CONTEXT_LIMIT/1000).toFixed(0)}K tokens</code>`,
        });
      }
    }

    // Reset si la conversación parece nueva (ratio muy bajo)
    if (ratio < 0.05) THRESHOLDS.forEach(t => t.fired = false);
  }

  // ──────────────────────────────────────────────────────────────
  // UI — Barra de conteo
  // ──────────────────────────────────────────────────────────────
  function createBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('style', [
      'display:flex',
      'justify-content:space-between',
      'align-items:center',
      'padding:3px 14px 6px',
      'font-family:ui-monospace,"SF Mono","Fira Code",monospace',
      'font-size:11px',
      'color:#9ca3af',
      'pointer-events:none',
      'user-select:none',
      'transition:color 0.3s',
    ].join(';'));

    bar.innerHTML = `
      <span id="ct-conv" style="font-size:10px;opacity:.65">Conv: –</span>
      <span style="display:flex;gap:8px;align-items:center">
        <span id="ct-count">0 tokens</span>
        <span style="opacity:.3">|</span>
        <span id="ct-pct" style="font-size:10px">–</span>
      </span>
    `;
    return bar;
  }

  function updateBar(msgTokens, convTokens) {
    const countEl = document.getElementById('ct-count');
    const pctEl   = document.getElementById('ct-pct');
    const convEl  = document.getElementById('ct-conv');
    const barEl   = document.getElementById(BAR_ID);
    if (!countEl || !barEl) return;

    countEl.textContent = `≈${msgTokens.toLocaleString('es-AR')} tokens`;

    if (convEl && convTokens > 0) {
      const convPct = ((convTokens / CONTEXT_LIMIT) * 100).toFixed(1);
      convEl.textContent = `Conv: ≈${convTokens.toLocaleString('es-AR')} (${convPct}%)`;
    }

    if (pctEl) {
      if (msgTokens === 0) {
        pctEl.textContent = '–';
        barEl.style.color = '#9ca3af';
      } else {
        const pct = ((msgTokens / CONTEXT_LIMIT) * 100).toFixed(3);
        pctEl.textContent   = `${pct}% del límite`;
        barEl.style.color   =
          msgTokens > 10_000 ? '#ef4444' :
          msgTokens > 2_000  ? '#f97316' :
          msgTokens > 400    ? '#d4a017' :
                               '#6b7280';
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // INYECCIÓN EN EL DOM
  // ──────────────────────────────────────────────────────────────
  function inject(editor) {
    if (document.getElementById(BAR_ID)) return;

    // Buscamos el ancestro con más de un hijo (panel del input:
    // contiene el editor + los botones de acción)
    let anchor = editor.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!anchor || anchor.children.length > 1) break;
      anchor = anchor.parentElement;
    }
    if (!anchor) return;

    const bar = createBar();
    anchor.appendChild(bar);

    editor.addEventListener('input', () => {
      const msgTokens  = approxTokens(editor.innerText || '');
      const convTokens = estimateConversationTokens(editor);
      updateBar(msgTokens, convTokens);
      checkAndNotify(convTokens);
    });

    updateBar(0, estimateConversationTokens(editor));
    console.log('[Claude Token Counter] ✓ inyectado');
  }

  // ──────────────────────────────────────────────────────────────
  // DETECCIÓN DEL EDITOR
  // claude.ai usa ProseMirror como editor de texto enriquecido
  // ──────────────────────────────────────────────────────────────
  function findEditor() {
    return (
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][data-placeholder]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function tryInject() {
    if (document.getElementById(BAR_ID)) return;
    const editor = findEditor();
    if (editor) inject(editor);
  }

  // ──────────────────────────────────────────────────────────────
  // BOOTSTRAP
  // ──────────────────────────────────────────────────────────────

  // MutationObserver: React monta componentes de forma asíncrona,
  // así que observamos el DOM y reaccionamos cuando aparece el editor
  new MutationObserver(tryInject)
    .observe(document.body, { childList: true, subtree: true });

  // Interceptar navegación SPA (cambio de conversación sin reload)
  const _push = history.pushState.bind(history);
  history.pushState = function (...a) {
    _push(...a);
    document.getElementById(BAR_ID)?.remove();
    THRESHOLDS.forEach(t => t.fired = false);
    setTimeout(tryInject, 700);
  };
  window.addEventListener('popstate', () => {
    document.getElementById(BAR_ID)?.remove();
    THRESHOLDS.forEach(t => t.fired = false);
    setTimeout(tryInject, 700);
  });

  tryInject();
})();

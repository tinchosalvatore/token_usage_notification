/**
 * Claude Token Counter — content.js
 *
 * Inyecta un contador de tokens debajo del chat input de claude.ai
 * y notifica al celular vía Telegram Bot cuando se alcanzan umbrales.
 *
 * SETUP: la config (token, chatId, límite de contexto, umbrales) NO vive acá.
 * Se carga desde chrome.storage.sync, que se edita en la página de opciones
 * (chrome://extensions → Detalles → Opciones de extensión). Ver options.*.
 *
 * El tokenizador vive en tokenizer.js (se carga antes que este script y expone
 * self.Tokenizer).
 */

(function () {
  'use strict';

  const approxTokens = self.Tokenizer.approxTokens;

  // ──────────────────────────────────────────────────────────────
  // CONSTANTES
  // ──────────────────────────────────────────────────────────────
  const BAR_ID         = 'ct-token-bar';
  const BADGE_ID       = 'ct-broken-badge';
  const DEFAULT_LIMIT  = 200_000;
  const DEFAULT_PCTS   = [50, 80, 95];      // umbrales por defecto (% del contexto)
  const INJECT_TIMEOUT = 10_000;            // ms sin encontrar editor → aviso

  // Emoji por severidad del umbral
  function emojiFor(pct) {
    return pct >= 0.95 ? '🚨' : pct >= 0.80 ? '🔴' : '⚠️';
  }

  // ──────────────────────────────────────────────────────────────
  // CONFIGURACIÓN — se carga desde chrome.storage.sync (ver options.js)
  // ──────────────────────────────────────────────────────────────
  const cfg = {
    token:        '',
    chatId:       '',
    contextLimit: DEFAULT_LIMIT,
    thresholds:   buildThresholds(DEFAULT_PCTS),
  };
  let notifyEnabled = false;

  function buildThresholds(pcts) {
    return pcts
      .map(Number)
      .filter(p => p > 0 && p <= 100)
      .sort((a, b) => a - b)
      .map(p => {
        const pct = p / 100;
        return { pct, emoji: emojiFor(pct), label: `${p}%`, fired: false };
      });
  }

  function loadConfig() {
    chrome.storage.sync.get(
      ['telegramToken', 'telegramChatId', 'contextLimit', 'thresholds'],
      (c) => {
        cfg.token        = c.telegramToken  || '';
        cfg.chatId       = c.telegramChatId || '';
        cfg.contextLimit = Number(c.contextLimit) > 0
          ? Number(c.contextLimit) : DEFAULT_LIMIT;
        const pcts = Array.isArray(c.thresholds) && c.thresholds.length
          ? c.thresholds : DEFAULT_PCTS;
        cfg.thresholds   = buildThresholds(pcts);
        notifyEnabled    = Boolean(cfg.token && cfg.chatId);
      }
    );
  }
  loadConfig();
  // Reaccionar si el usuario cambia la config sin recargar la pestaña
  chrome.storage.onChanged.addListener(loadConfig);

  function resetThresholds() {
    cfg.thresholds.forEach(t => { t.fired = false; });
  }

  // ──────────────────────────────────────────────────────────────
  // DETECCIÓN DE LÍMITE DE CONTEXTO (best-effort)
  //
  // claude.ai no expone el modelo de forma estable. Intentamos leer el
  // selector de modelo; si menciona "1M" usamos 1.000.000. Si falla,
  // queda el valor configurado. Nunca rompe: es solo un ajuste fino.
  // ──────────────────────────────────────────────────────────────
  function detectContextLimit() {
    try {
      const text = (document.body.innerText || '').slice(0, 5000);
      if (/\b1\s?M\b|1[\.,]000[\.,]000\s*tokens/i.test(text)) return 1_000_000;
    } catch { /* noop */ }
    return cfg.contextLimit;
  }

  // ──────────────────────────────────────────────────────────────
  // ESTIMACIÓN DE CONVERSACIÓN
  //
  // Subimos por el DOM desde el editor buscando el primer contenedor con
  // scroll (el div que contiene los mensajes). Restamos el conteo del input
  // actual al conteo total (en TOKENS, no por substring de texto — así no
  // falla si lo que escribís coincide con texto previo de la conversación).
  // ──────────────────────────────────────────────────────────────
  function findScrollContainer(editor) {
    let el = editor.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 50) return el;
      el = el.parentElement;
    }
    return null;
  }

  function estimateConversationTokens(editor) {
    const el = findScrollContainer(editor);
    if (!el) return 0;
    const total = approxTokens(el.innerText || '');
    const input = approxTokens(editor.innerText || '');
    return Math.max(0, total - input);
  }

  // ──────────────────────────────────────────────────────────────
  // NOTIFICACIONES VÍA TELEGRAM
  // ──────────────────────────────────────────────────────────────
  function checkAndNotify(convTokens) {
    if (!notifyEnabled) return;

    const ratio = convTokens / cfg.contextLimit;

    for (const t of cfg.thresholds) {
      if (t.fired || ratio < t.pct) continue;
      t.fired = true;

      const text =
        `${t.emoji} <b>Claude: ${t.label} del contexto usado</b>\n` +
        `<code>≈${convTokens.toLocaleString('es-AR')} / ` +
        `${(cfg.contextLimit / 1000).toFixed(0)}K tokens</code>`;

      // Mandamos al service worker (background.js), que hace el POST real.
      // Capturamos la respuesta: si falla, lo marcamos y permitimos reintento.
      chrome.runtime.sendMessage(
        { type: 'TELEGRAM_NOTIFY', token: cfg.token, chatId: cfg.chatId, text },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            const err = chrome.runtime.lastError?.message
              || resp?.error || `HTTP ${resp?.status || '?'}`;
            t.fired = false;                 // reintentar en el próximo input
            showSendError(err);
          } else {
            clearSendError();
          }
        }
      );
    }
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
        <span id="ct-err" style="display:none;color:#ef4444"></span>
        <span id="ct-count">0 tokens</span>
        <span style="opacity:.3">|</span>
        <span id="ct-pct" style="font-size:10px">–</span>
      </span>
    `;
    return bar;
  }

  function showSendError(msg) {
    const el = document.getElementById('ct-err');
    if (!el) return;
    el.style.display = 'inline';
    el.textContent  = '⚠ envío falló';
    el.title        = `Telegram: ${msg}`;
  }
  function clearSendError() {
    const el = document.getElementById('ct-err');
    if (el) { el.style.display = 'none'; el.title = ''; }
  }

  function updateBar(msgTokens, convTokens) {
    const countEl = document.getElementById('ct-count');
    const pctEl   = document.getElementById('ct-pct');
    const convEl  = document.getElementById('ct-conv');
    const barEl   = document.getElementById(BAR_ID);
    if (!countEl || !barEl) return;

    countEl.textContent = `≈${msgTokens.toLocaleString('es-AR')} tokens`;

    if (convEl && convTokens > 0) {
      const convPct = ((convTokens / cfg.contextLimit) * 100).toFixed(1);
      convEl.textContent = `Conv: ≈${convTokens.toLocaleString('es-AR')} (${convPct}%)`;
    }

    if (pctEl) {
      if (msgTokens === 0) {
        pctEl.textContent = '–';
        barEl.style.color = '#9ca3af';
      } else {
        const pct = ((msgTokens / cfg.contextLimit) * 100).toFixed(3);
        pctEl.textContent = `${pct}% del límite`;
        barEl.style.color =
          msgTokens > 10_000 ? '#ef4444' :
          msgTokens > 2_000  ? '#f97316' :
          msgTokens > 400    ? '#d4a017' :
                               '#6b7280';
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // AVISO DE "SELECTORES ROTOS"
  //
  // Si tras INJECT_TIMEOUT no encontramos el editor, claude.ai probablemente
  // cambió su DOM. Mostramos un badge en vez de fallar en silencio.
  // ──────────────────────────────────────────────────────────────
  function showBrokenBadge() {
    if (document.getElementById(BADGE_ID) || document.getElementById(BAR_ID)) return;
    const b = document.createElement('div');
    b.id = BADGE_ID;
    b.textContent = '⚠ Token Counter: no encontré el editor (claude.ai cambió el DOM?)';
    b.setAttribute('style', [
      'position:fixed', 'bottom:12px', 'right:12px', 'z-index:99999',
      'background:#7f1d1d', 'color:#fff', 'font:12px system-ui,sans-serif',
      'padding:8px 12px', 'border-radius:8px', 'max-width:280px',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'cursor:pointer',
    ].join(';'));
    b.addEventListener('click', () => b.remove());
    document.body.appendChild(b);
  }

  // ──────────────────────────────────────────────────────────────
  // INYECCIÓN EN EL DOM
  // ──────────────────────────────────────────────────────────────
  function inject(editor) {
    if (document.getElementById(BAR_ID)) return;
    document.getElementById(BADGE_ID)?.remove();

    // Ancestro con más de un hijo (panel del input: editor + botones)
    let anchor = editor.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!anchor || anchor.children.length > 1) break;
      anchor = anchor.parentElement;
    }
    if (!anchor) return;

    anchor.appendChild(createBar());

    editor.addEventListener('input', () => {
      cfg.contextLimit = detectContextLimit();
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
  // RESET POR CAMBIO DE CONVERSACIÓN
  //
  // El ID de conversación vive en la URL (/chat/<id>). Reseteamos los umbrales
  // cuando cambia — más confiable que adivinar por "ratio bajo".
  // ──────────────────────────────────────────────────────────────
  function convId() {
    const m = location.pathname.match(/\/(chat|project)\/([\w-]+)/);
    return m ? m[2] : location.pathname;
  }
  let currentConv = convId();

  function onNavigate() {
    const id = convId();
    if (id !== currentConv) {
      currentConv = id;
      resetThresholds();
      clearSendError();
    }
    document.getElementById(BAR_ID)?.remove();
    setTimeout(tryInject, 700);
  }

  // ──────────────────────────────────────────────────────────────
  // BOOTSTRAP
  // ──────────────────────────────────────────────────────────────

  // React monta async → observamos el DOM y reaccionamos cuando aparece.
  new MutationObserver(tryInject)
    .observe(document.body, { childList: true, subtree: true });

  // SPA navigation (cambio de conversación sin reload)
  const _push = history.pushState.bind(history);
  history.pushState = function (...a) { _push(...a); onNavigate(); };
  window.addEventListener('popstate', onNavigate);

  // Si nunca aparece el editor, avisar (selectores probablemente rotos)
  setTimeout(showBrokenBadge, INJECT_TIMEOUT);

  tryInject();
})();

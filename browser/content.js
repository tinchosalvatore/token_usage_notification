/**
 * Claude Token Counter — content.js
 *
 * Cuenta tokens debajo del chat input de claude.ai y notifica por Telegram al
 * cruzar umbrales. Dos fuentes de datos:
 *
 *  1. REAL (preferida): interceptor.js (MAIN world) captura el `usage` real de
 *     la API interna y lo manda por window.postMessage. Números exactos +
 *     modelo + caché + costo. Ver interceptor.js / usage-parser.js.
 *  2. ESTIMADA (fallback): si el interceptor no aportó datos (formato cambió,
 *     o todavía no hubo turno), se estima contando el texto del DOM.
 *
 * Config (token, chatId, límite, umbrales) en chrome.storage.sync (options.*).
 * Módulos cargados antes: tokenizer.js (self.Tokenizer), pricing.js (self.Pricing).
 */

(function () {
  'use strict';

  const approxTokens = self.Tokenizer.approxTokens;
  const Pricing      = self.Pricing;

  // ──────────────────────────────────────────────────────────────
  // CONSTANTES
  // ──────────────────────────────────────────────────────────────
  const BAR_ID         = 'ct-token-bar';
  const BADGE_ID       = 'ct-broken-badge';
  const DEFAULT_LIMIT  = 200_000;
  const DEFAULT_PCTS   = [50, 80, 95];
  const INJECT_TIMEOUT = 10_000;
  const MAX_SAMPLES    = 12;          // muestras para el cálculo de ETA
  const HISTORY_KEY    = 'ct-history';

  function emojiFor(pct) {
    return pct >= 0.95 ? '🚨' : pct >= 0.80 ? '🔴' : '⚠️';
  }

  // ──────────────────────────────────────────────────────────────
  // CONFIGURACIÓN
  // ──────────────────────────────────────────────────────────────
  const cfg = {
    token: '', chatId: '',
    contextLimit: DEFAULT_LIMIT,
    thresholds: buildThresholds(DEFAULT_PCTS),
  };
  let notifyEnabled = false;

  function buildThresholds(pcts) {
    return pcts.map(Number).filter(p => p > 0 && p <= 100).sort((a, b) => a - b)
      .map(p => {
        const pct = p / 100;
        return { pct, emoji: emojiFor(pct), label: `${p}%`, fired: false };
      });
  }

  function loadConfig() {
    chrome.storage.sync.get(
      ['telegramToken', 'telegramChatId', 'contextLimit', 'thresholds'],
      (c) => {
        cfg.token  = c.telegramToken  || '';
        cfg.chatId = c.telegramChatId || '';
        cfg.contextLimit = Number(c.contextLimit) > 0 ? Number(c.contextLimit) : DEFAULT_LIMIT;
        const pcts = Array.isArray(c.thresholds) && c.thresholds.length ? c.thresholds : DEFAULT_PCTS;
        cfg.thresholds = buildThresholds(pcts);
        notifyEnabled = Boolean(cfg.token && cfg.chatId);
      }
    );
  }
  loadConfig();
  chrome.storage.onChanged.addListener(loadConfig);

  function resetThresholds() { cfg.thresholds.forEach(t => { t.fired = false; }); }

  // ──────────────────────────────────────────────────────────────
  // ESTADO DE LA SESIÓN (datos REALES del interceptor)
  // ──────────────────────────────────────────────────────────────
  const real = {
    active: false,      // ¿llegó al menos un usage real?
    ctx: 0,             // contexto actual (input + caché) del último turno
    model: '',
    turnCost: 0,        // costo del último turno
    totalCost: 0,       // costo acumulado de la conversación
    turns: 0,
    peakCtx: 0,
  };
  const samples = [];   // {t, ctx} para ETA

  function effectiveLimit() {
    // Si conocemos el modelo, su límite manda; si no, el configurado.
    return real.model ? Pricing.modelLimit(real.model, cfg.contextLimit) : cfg.contextLimit;
  }

  // Tokens de contexto vigentes: reales si los hay, si no estimación del DOM.
  function convTokens(editor) {
    if (real.active) return real.ctx;
    return editor ? estimateConversationTokens(editor) : 0;
  }

  // ──────────────────────────────────────────────────────────────
  // RECEPCIÓN DE USAGE REAL (postMessage desde interceptor.js)
  // ──────────────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ctSource !== 'ct-usage' || !d.usage) return;
    onRealUsage(d.usage);
  });

  function onRealUsage(usage) {
    const ctx = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    if (ctx === 0 && (usage.output_tokens || 0) === 0 && !usage.model) return;

    real.active = true;
    real.ctx    = ctx;
    if (usage.model) real.model = usage.model;
    real.turnCost = Pricing.estimateCost(usage, real.model);
    real.totalCost += real.turnCost;
    real.turns += 1;
    real.peakCtx = Math.max(real.peakCtx, ctx);

    pushSample(ctx);
    render();
    checkAndNotify(real.ctx);
    persistHistory();
  }

  function pushSample(ctx) {
    samples.push({ t: Date.now(), ctx });
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  // ──────────────────────────────────────────────────────────────
  // ETA — minutos estimados hasta el límite (pendiente lineal simple)
  // ──────────────────────────────────────────────────────────────
  function etaMinutes() {
    if (samples.length < 2) return null;
    const a = samples[0], b = samples[samples.length - 1];
    const dCtx = b.ctx - a.ctx;
    const dT   = b.t - a.t;
    if (dCtx <= 0 || dT <= 0) return null;            // no está subiendo
    const rate = dCtx / dT;                            // tokens por ms
    const remaining = effectiveLimit() - b.ctx;
    if (remaining <= 0) return 0;
    return remaining / rate / 60000;                   // ms → min
  }

  // ──────────────────────────────────────────────────────────────
  // HISTÓRICO — resumen por conversación en chrome.storage.local
  // ──────────────────────────────────────────────────────────────
  let lastPersist = 0;
  function persistHistory() {
    const now = Date.now();
    if (now - lastPersist < 10_000) return;            // throttle
    lastPersist = now;
    const id = convId();
    chrome.storage.local.get([HISTORY_KEY], (data) => {
      const hist = data[HISTORY_KEY] || {};
      hist[id] = {
        model: real.model,
        peakCtx: real.peakCtx,
        turns: real.turns,
        costUSD: Number(real.totalCost.toFixed(4)),
        updated: now,
      };
      chrome.storage.local.set({ [HISTORY_KEY]: hist });
    });
  }

  // ──────────────────────────────────────────────────────────────
  // ESTIMACIÓN DE CONVERSACIÓN (fallback DOM)
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
  // NOTIFICACIONES
  // ──────────────────────────────────────────────────────────────
  function checkAndNotify(tokens) {
    if (!notifyEnabled) return;
    const limit = effectiveLimit();
    const ratio = tokens / limit;

    // Re-arm: si el ratio bajó (p.ej. chat nuevo o compact), re-habilitar.
    cfg.thresholds.forEach(t => { if (t.pct > ratio) t.fired = false; });

    for (const t of cfg.thresholds) {
      if (t.fired || ratio < t.pct) continue;
      t.fired = true;

      const src = real.active ? '' : '≈';
      const costLine = real.active
        ? `\n<i>Costo conversación: ${Pricing.fmtCost(real.totalCost)}</i>` : '';
      const text =
        `${t.emoji} <b>Claude: ${t.label} del contexto usado</b>\n` +
        `<code>${src}${tokens.toLocaleString('es-AR')} / ${(limit / 1000).toFixed(0)}K tokens</code>` +
        costLine;

      chrome.runtime.sendMessage(
        { type: 'TELEGRAM_NOTIFY', token: cfg.token, chatId: cfg.chatId, text },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            const err = chrome.runtime.lastError?.message || resp?.error || `HTTP ${resp?.status || '?'}`;
            t.fired = false;
            showSendError(err);
          } else { clearSendError(); }
        }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────
  // UI
  // ──────────────────────────────────────────────────────────────
  function createBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('style', [
      'display:flex', 'justify-content:space-between', 'align-items:center',
      'padding:3px 14px 6px',
      'font-family:ui-monospace,"SF Mono","Fira Code",monospace',
      'font-size:11px', 'color:#9ca3af', 'pointer-events:none',
      'user-select:none', 'transition:color 0.3s',
    ].join(';'));
    bar.innerHTML = `
      <span id="ct-conv" style="font-size:10px;opacity:.75">Conv: –</span>
      <span style="display:flex;gap:8px;align-items:center">
        <span id="ct-err" style="display:none;color:#ef4444"></span>
        <span id="ct-count">0 tokens</span>
        <span style="opacity:.3">|</span>
        <span id="ct-pct" style="font-size:10px">–</span>
      </span>`;
    return bar;
  }

  function showSendError(msg) {
    const el = document.getElementById('ct-err');
    if (!el) return;
    el.style.display = 'inline'; el.textContent = '⚠ envío falló';
    el.title = `Telegram: ${msg}`;
  }
  function clearSendError() {
    const el = document.getElementById('ct-err');
    if (el) { el.style.display = 'none'; el.title = ''; }
  }

  let lastEditor = null;

  function render() {
    const editor  = lastEditor;
    const tokens  = convTokens(editor);
    const limit   = effectiveLimit();
    const msgTok  = editor ? approxTokens(editor.innerText || '') : 0;

    const countEl = document.getElementById('ct-count');
    const pctEl   = document.getElementById('ct-pct');
    const convEl  = document.getElementById('ct-conv');
    const barEl   = document.getElementById(BAR_ID);
    if (!countEl || !barEl) return;

    countEl.textContent = `≈${msgTok.toLocaleString('es-AR')} tokens`;

    // Línea izquierda: contexto real/estimado + modelo + costo + ETA
    if (convEl) {
      const src = real.active ? '' : '≈';
      const pct = ((tokens / limit) * 100).toFixed(1);
      let s = `Conv: ${src}${tokens.toLocaleString('es-AR')} (${pct}%)`;
      if (real.active) {
        const key = Pricing.modelKey(real.model);
        if (key) s += ` · ${key}`;
        if (real.totalCost) s += ` · ${Pricing.fmtCost(real.totalCost)}`;
      }
      const eta = etaMinutes();
      if (eta != null && eta < 600) s += ` · ~${Math.max(0, Math.round(eta))}min`;
      convEl.textContent = s;
      convEl.title = real.active
        ? 'Datos reales (interceptados de la API)'
        : 'Estimación del DOM (sin datos reales aún)';
    }

    if (pctEl) {
      if (msgTok === 0) { pctEl.textContent = '–'; barEl.style.color = '#9ca3af'; }
      else {
        pctEl.textContent = `${((msgTok / limit) * 100).toFixed(3)}% del límite`;
        barEl.style.color =
          msgTok > 10_000 ? '#ef4444' :
          msgTok > 2_000  ? '#f97316' :
          msgTok > 400    ? '#d4a017' : '#6b7280';
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // BADGE "selectores rotos"
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
  // INYECCIÓN
  // ──────────────────────────────────────────────────────────────
  function inject(editor) {
    if (document.getElementById(BAR_ID)) return;
    document.getElementById(BADGE_ID)?.remove();
    lastEditor = editor;

    let anchor = editor.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!anchor || anchor.children.length > 1) break;
      anchor = anchor.parentElement;
    }
    if (!anchor) return;

    anchor.appendChild(createBar());
    editor.addEventListener('input', () => {
      render();
      checkAndNotify(convTokens(editor));
    });
    render();
    console.log('[Claude Token Counter] ✓ inyectado');
  }

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
  // ──────────────────────────────────────────────────────────────
  function convId() {
    const m = location.pathname.match(/\/(chat|project)\/([\w-]+)/);
    return m ? m[2] : location.pathname;
  }
  let currentConv = convId();

  function resetSession() {
    real.active = false; real.ctx = 0; real.model = '';
    real.turnCost = 0; real.totalCost = 0; real.turns = 0; real.peakCtx = 0;
    samples.length = 0;
    resetThresholds();
    clearSendError();
  }

  function onNavigate() {
    const id = convId();
    if (id !== currentConv) { currentConv = id; resetSession(); }
    document.getElementById(BAR_ID)?.remove();
    setTimeout(tryInject, 700);
  }

  // ──────────────────────────────────────────────────────────────
  // BOOTSTRAP
  // ──────────────────────────────────────────────────────────────
  new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });

  const _push = history.pushState.bind(history);
  history.pushState = function (...a) { _push(...a); onNavigate(); };
  window.addEventListener('popstate', onNavigate);

  setTimeout(showBrokenBadge, INJECT_TIMEOUT);
  tryInject();
})();

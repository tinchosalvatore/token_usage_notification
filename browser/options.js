/**
 * options.js — Página de configuración de la extensión.
 *
 * Lee/escribe la config en chrome.storage.sync. Nada de esto vive en el
 * código fuente: el repo queda libre de secretos.
 *
 * Claves guardadas:
 *   telegramToken, telegramChatId  (strings)
 *   contextLimit                   (number)
 *   thresholds                     (array de números, % del contexto)
 */

const DEFAULT_LIMIT = 200_000;
const DEFAULT_PCTS  = [50, 80, 95];

const tokenEl     = document.getElementById('token');
const chatIdEl    = document.getElementById('chatId');
const limitEl     = document.getElementById('contextLimit');
const threshEl    = document.getElementById('thresholds');
const statusEl    = document.getElementById('status');

function flash(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#16a34a' : '#ef4444';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

function parseThresholds(raw) {
  return raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b);
}

// ── Cargar valores guardados ──────────────────────────────────────────
chrome.storage.sync.get(
  ['telegramToken', 'telegramChatId', 'contextLimit', 'thresholds'],
  (cfg) => {
    tokenEl.value  = cfg.telegramToken  || '';
    chatIdEl.value = cfg.telegramChatId || '';
    limitEl.value  = cfg.contextLimit   || DEFAULT_LIMIT;
    const pcts = Array.isArray(cfg.thresholds) && cfg.thresholds.length
      ? cfg.thresholds : DEFAULT_PCTS;
    threshEl.value = pcts.join(', ');
  }
);

// ── Guardar ───────────────────────────────────────────────────────────
document.getElementById('save').addEventListener('click', () => {
  const thresholds = parseThresholds(threshEl.value);
  if (!thresholds.length) { flash('Umbrales inválidos', false); return; }

  const contextLimit = Number(limitEl.value) > 0
    ? Number(limitEl.value) : DEFAULT_LIMIT;

  chrome.storage.sync.set({
    telegramToken:  tokenEl.value.trim(),
    telegramChatId: chatIdEl.value.trim(),
    contextLimit,
    thresholds,
  }, () => flash('✓ Guardado'));
});

// ── Probar notificación ───────────────────────────────────────────────
// Reusa el service worker (background.js) que hace el POST a Telegram.
document.getElementById('test').addEventListener('click', () => {
  const token  = tokenEl.value.trim();
  const chatId = chatIdEl.value.trim();
  if (!token || !chatId) { flash('Falta token o chat ID', false); return; }

  chrome.runtime.sendMessage(
    {
      type: 'TELEGRAM_NOTIFY',
      token, chatId,
      text: '✅ <b>Claude Token Counter</b>\nNotificación de prueba OK.',
    },
    (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        const err = chrome.runtime.lastError?.message
          || resp?.error || `HTTP ${resp?.status || '?'}`;
        flash(`Falló: ${err}`, false);
      } else {
        flash('✓ Enviada — revisá Telegram');
      }
    }
  );
});

/**
 * options.js — Página de configuración de la extensión.
 *
 * Lee/escribe el token y chatId de Telegram en chrome.storage.sync.
 * Nada de esto vive en el código fuente: el repo queda libre de secretos.
 */

const tokenEl  = document.getElementById('token');
const chatIdEl = document.getElementById('chatId');
const statusEl = document.getElementById('status');

// Cargar valores guardados al abrir la página
chrome.storage.sync.get(['telegramToken', 'telegramChatId'], (cfg) => {
  tokenEl.value  = cfg.telegramToken  || '';
  chatIdEl.value = cfg.telegramChatId || '';
});

document.getElementById('save').addEventListener('click', () => {
  const telegramToken  = tokenEl.value.trim();
  const telegramChatId = chatIdEl.value.trim();

  chrome.storage.sync.set({ telegramToken, telegramChatId }, () => {
    statusEl.textContent = '✓ Guardado';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
});

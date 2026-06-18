/**
 * background.js — Service Worker (Manifest V3)
 *
 * ¿Por qué existe este archivo?
 * En MV3, content scripts no pueden hacer fetch() a dominios externos.
 * El content script manda un mensaje (chrome.runtime.sendMessage) →
 * este service worker lo recibe y hace el HTTP POST real a Telegram.
 *
 * ¿Por qué Telegram y no ntfy.sh?
 * Telegram es una app masiva con integración APNs permanente en iOS.
 * ntfy.sh usa una app de tercero que iOS puede "throttlear" en background.
 * La API de Telegram es también más simple: un POST con JSON, sin headers custom.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'TELEGRAM_NOTIFY') return false;

  // Telegram Bot API — enviar mensaje a un chat
  // Docs: https://core.telegram.org/bots/api#sendmessage
  fetch(`https://api.telegram.org/bot${msg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    msg.chatId,
      text:       msg.text,
      parse_mode: 'HTML',   // permite <b>, <i>, <code> en el mensaje
    }),
  })
  .then(r => sendResponse({ ok: r.ok, status: r.status }))
  .catch(e => sendResponse({ ok: false, error: e.message }));

  // Retornar true es OBLIGATORIO en MV3 para respuestas asíncronas.
  // Sin esto el canal se cierra antes de recibir la respuesta del fetch.
  return true;
});

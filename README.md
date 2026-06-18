# Claude Token Counter

Extensión de browser para **claude.ai** que muestra el conteo aproximado de tokens en tiempo real debajo del chat input, y envía notificaciones push al celular via **Telegram Bot** cuando la conversación se acerca al límite de contexto.

**100% gratuito.** Sin servicios de pago, sin cuentas externas salvo Telegram.

---

## Cómo funciona

### Arquitectura general

```
claude.ai (browser)
│
├── content.js        Inyectado en la página. Lee el DOM, cuenta tokens,
│                     detecta umbrales y manda mensajes internos.
│
└── background.js     Service Worker. Recibe mensajes de content.js
                      y hace el HTTP POST a la Telegram Bot API.
                                │
                                ▼
                      api.telegram.org  →  tu celular (iOS / Android)
```

Hay dos actores dentro de la extensión porque **Manifest V3** (el estándar actual de extensiones) no permite que los content scripts hagan fetch a dominios externos directamente. El service worker actúa de proxy interno.

### Conteo de tokens

Claude usa un tokenizador BPE (Byte-Pair Encoding) propietario no publicado. La extensión usa una **aproximación** basada en el comportamiento conocido de este tipo de tokenizadores:

- Palabras alfabéticas: `ceil(longitud / 4)` tokens (empíricamente ~4 chars/token)
- Dígitos: ~1 token por dígito
- Puntuación y símbolos: 1 token cada uno

Precisión típica: **±10–15%** respecto al tokenizador real de Anthropic. Suficiente para el uso práctico.

La barra muestra dos valores:
- **Mensaje actual**: tokens del texto que estás escribiendo ahora
- **Conv**: estimación del total de la conversación (útil para saber cuánto contexto se consumió)

### Notificaciones

Cuando escribís y el total estimado de la conversación supera un umbral (50%, 80% o 95% del límite de 200.000 tokens), `content.js` manda un mensaje al service worker vía `chrome.runtime.sendMessage`. El service worker hace un POST a:

```
https://api.telegram.org/bot{TOKEN}/sendMessage
```

Tu celular recibe la notificación push via el sistema nativo de Telegram (APNs en iOS, FCM en Android).

**¿Por qué Telegram y no otras alternativas?**
Telegram es una app de gran escala con conexiones APNs permanentes. Otras opciones como ntfy.sh usan apps de tercero que iOS puede restringir en background, lo que reduce la confiabilidad de entrega.

---

## Requisitos

- Browser basado en Chromium (Chrome, Chromium, Brave, Edge) o Firefox
- Telegram instalado en el celular (iOS o Android)
- Cuenta de Telegram (gratuita)

---

## Configuración paso a paso

### 1. Crear el bot de Telegram

**a.** Abrí Telegram y buscá `@BotFather`

**b.** Mandá el comando `/newbot` y seguí las instrucciones:
```
Nombre del bot:   Claude Notifier        (o el que quieras)
Username del bot: claude_notifier_bot    (debe terminar en "bot", debe ser único)
```

**c.** BotFather te responde con un **TOKEN** de este formato:
```
7123456789:AAHxyzAbcDefGhiJklMnoPqrStuvWxyz
```
Guardalo, lo vas a necesitar.

**d.** Buscá tu nuevo bot en Telegram y **mandále cualquier mensaje** (ej: "hola"). Esto es necesario para que el bot pueda mandarte mensajes.

**e.** Abrí esta URL en el browser (reemplazando con tu TOKEN):
```
https://api.telegram.org/bot7123456789:AAHxyz.../getUpdates
```

**f.** En la respuesta JSON buscá el campo `"chat"` → `"id"`. Ese número es tu **CHAT_ID**:
```json
{
  "message": {
    "chat": {
      "id": 123456789,
      ...
    }
  }
}
```

### 2. Instalar la extensión (browser) o el monitor (Claude Code)

> Las credenciales **ya no se editan en el código**.
> - Extensión de browser → se configuran en la página de opciones (paso 3).
> - Monitor de Claude Code → se configuran por variables de entorno / `.env`
>   (ver sección "Claude Code" más abajo).

### 3. Instalar la extensión

**Chrome / Chromium / Brave:**
1. Abrí `chrome://extensions`
2. Activá **"Modo desarrollador"** (toggle arriba a la derecha)
3. Hacé click en **"Cargar descomprimida"**
4. Seleccioná la carpeta `claude-token-counter`

**Firefox:**
1. Abrí `about:debugging#/runtime/this-firefox`
2. Hacé click en **"Cargar complemento temporal..."**
3. Seleccioná el archivo `manifest.json` dentro de la carpeta

> ⚠️ En Firefox las extensiones temporales se eliminan al cerrar el browser.
> Para instalarla de forma permanente necesitás Firefox Developer Edition
> con `xpinstall.signatures.required = false` en `about:config`.

**Configurar credenciales:** una vez instalada, abrí la página de opciones:
- Chrome/Chromium: `chrome://extensions` → "Detalles" de la extensión → "Opciones de extensión"
- Firefox: `about:addons` → la extensión → "Preferencias"

Pegá tu **TOKEN** y **CHAT_ID**, guardá, y recargá la pestaña de claude.ai.
Los valores se guardan en `chrome.storage.sync` (no en el código).

### 4. Verificar que funciona

1. Abrí `claude.ai` en el browser
2. Iniciá una conversación
3. Deberías ver la barra de tokens debajo del input:
   ```
   Conv: ≈0  |  0 tokens  |  –
   ```
4. Empezá a escribir — el contador actualiza en tiempo real
5. Para probar las notificaciones podés bajar temporalmente el umbral
   en `content.js` (por ejemplo a `0.001`) y escribir cualquier texto

---

## Personalizar los umbrales

En `content.js`, el array `THRESHOLDS` define cuándo se envían notificaciones:

```javascript
const THRESHOLDS = [
  { pct: 0.50, emoji: '⚠️',  label: '50%' },  // ← 100.000 tokens
  { pct: 0.80, emoji: '🔴',  label: '80%' },  // ← 160.000 tokens
  { pct: 0.95, emoji: '🚨',  label: '95%' },  // ← 190.000 tokens
];
```

Podés agregar, quitar o cambiar los valores. Después de modificar `content.js` tenés que **recargar la extensión** en `chrome://extensions` (ícono de recarga junto a la extensión).

---

## Claude Code (CLI)

Para Claude Code (el CLI, no claude.ai) hay un monitor aparte que vigila los
logs JSONL en `~/.claude/projects/` y manda la misma notificación de Telegram.

```bash
# 1. Configurar credenciales
cd claude_code
cp .env.example .env
# editá .env y completá TELEGRAM_TOKEN y TELEGRAM_CHAT_ID
#   (o exportalas como variables de entorno)

# 2. Correr
python3 claude-monitor.py              # foreground
nohup python3 claude-monitor.py &      # background persistente
```

Solo usa la librería estándar de Python — sin dependencias.

---

## Estructura del proyecto

```
token_usage_notification/
├── browser/                  Extensión MV3 para claude.ai
│   ├── manifest.json         Declaración de la extensión (permisos, SW, opciones).
│   ├── content.js            Inyectado en claude.ai: tokenizador, UI, umbrales,
│   │                         estimación de contexto. Lee config de storage.
│   ├── background.js         Service Worker: hace el POST a la Telegram Bot API.
│   ├── options.html          Página de opciones (token + chatId).
│   └── options.js            Guarda/lee credenciales en chrome.storage.sync.
│
├── claude_code/              Monitor para Claude Code (CLI)
│   ├── claude-monitor.py     Tail de los logs JSONL + notificación Telegram.
│   └── .env.example          Plantilla de credenciales (copiar a .env).
│
└── README.md                 Este archivo.
```

---

## Limitaciones conocidas

- **El conteo es una aproximación.** El tokenizador real de Anthropic no es público. El error típico es ±10–15%.
- **La estimación de conversación** lee el texto visible en el DOM, lo que puede incluir algo de texto de la UI de claude.ai. Puede sobreestimar levemente.
- **Los selectores del DOM** dependen de la estructura interna de claude.ai, que puede cambiar sin aviso con actualizaciones. Si la barra deja de aparecer, revisar los selectores en `findEditor()`.
- **No funciona en Claude Desktop** (la app Electron). Solo funciona en claude.ai dentro de un browser.
- **Firefox** requiere recargar la extensión después de cada reinicio del browser (extensión temporal).

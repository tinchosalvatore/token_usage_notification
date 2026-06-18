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
5. Para validar las notificaciones, usá el botón **"Probar notificación"** en la
   página de opciones (manda un mensaje de test a Telegram al instante)

---

## Personalizar los umbrales

Los umbrales y el límite de contexto se editan en la **página de opciones**
(ya no en el código):

- **Umbrales de aviso (%)**: lista separada por comas, ej. `50, 80, 95`.
- **Límite de contexto**: default `200000`; poné `1000000` si usás contexto de 1M.

Tras guardar, recargá la pestaña de claude.ai. Los valores se guardan en
`chrome.storage.sync`.

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
python3 claude-monitor.py --once       # un solo tick (smoke test)
```

Solo usa la librería estándar de Python — sin dependencias.

**Qué hace:**
- Vigila **todas** las sesiones activas en paralelo (cada `.jsonl` con su propio
  estado), no solo la más reciente.
- Auto-detecta el límite de contexto por modelo (1M si el modelo lo soporta).
- Re-arma los umbrales tras un auto-compact: si el contexto baja y vuelve a
  subir, te avisa de nuevo.
- Si el envío a Telegram falla, reintenta en el próximo turno (no se pierde).
- Polling adaptativo (1s con actividad, 5s en idle) — bajo consumo.

**Como servicio (systemd, Linux):**
```bash
mkdir -p ~/.config/systemd/user
cp claude_code/claude-monitor.service ~/.config/systemd/user/
# editá la ruta del repo en el .service si hace falta
systemctl --user daemon-reload
systemctl --user enable --now claude-monitor.service
journalctl --user -u claude-monitor -f          # ver logs
```
> macOS: usar un `launchd` plist equivalente con `ProgramArguments` apuntando a
> `python3 .../claude-monitor.py` y `KeepAlive=true`.

**Logging a archivo:** definí `LOG_FILE` en `.env` (rotación automática 1MB×3).

**Tests:**
```bash
python3 -m unittest discover -s claude_code -p 'test_*.py'
```

---

## Estructura del proyecto

```
token_usage_notification/
├── browser/                  Extensión MV3 para claude.ai
│   ├── manifest.json         Declaración de la extensión (permisos, SW, opciones).
│   ├── tokenizer.js          Tokenizador heurístico (módulo testeable).
│   ├── content.js            Inyectado en claude.ai: UI, umbrales, estimación
│   │                         de contexto. Lee config de storage.
│   ├── background.js         Service Worker: hace el POST a la Telegram Bot API.
│   ├── options.html          Página de opciones (creds, límite, umbrales, test).
│   ├── options.js            Guarda/lee config en chrome.storage.sync.
│   └── test/                 Tests del tokenizador (node --test).
│
├── claude_code/              Monitor para Claude Code (CLI)
│   ├── claude-monitor.py     CLI thin: carga .env, valida, llama al core.
│   ├── monitor_core.py       Lógica: watcher multi-sesión, umbrales, Telegram.
│   ├── test_monitor_core.py  Tests (python3 -m unittest).
│   ├── claude-monitor.service Unit de systemd --user.
│   └── .env.example          Plantilla de credenciales (copiar a .env).
│
├── package.json              Scripts de test/lint de la extensión.
├── eslint.config.js          Config de ESLint.
└── README.md                 Este archivo.
```

---

## Desarrollo (extensión)

```bash
npm test          # tests del tokenizador (node --test, sin dependencias)
npm install       # instala eslint (solo para lint)
npm run lint
```

---

## Limitaciones conocidas

- **El conteo es una aproximación.** El tokenizador real de Anthropic no es público. El error típico es ±10–15%.
- **La estimación de conversación** lee el texto visible en el DOM, lo que puede incluir algo de texto de la UI de claude.ai. Puede sobreestimar levemente.
- **Los selectores del DOM** dependen de la estructura interna de claude.ai, que puede cambiar sin aviso. Si la barra no aparece, la extensión muestra un badge de aviso a los ~10s; revisar los selectores en `findEditor()`.
- **No funciona en Claude Desktop** (la app Electron). Solo funciona en claude.ai dentro de un browser.
- **Firefox** requiere recargar la extensión después de cada reinicio del browser (extensión temporal).

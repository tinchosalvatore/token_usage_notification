# Claude Token Counter

Extensión de browser para **claude.ai** que muestra el conteo de tokens en tiempo real (reales cuando es posible, estimados si no), el costo en USD y un ETA al límite, y envía notificaciones push al celular via **Telegram Bot** cuando la conversación se acerca al límite de contexto.

**100% gratuito.** Sin servicios de pago, sin cuentas externas salvo Telegram.

---

## Cómo funciona

### Arquitectura general

```
claude.ai (browser)
│
├── interceptor.js    MAIN world. Monkeypatch de fetch/XHR: lee una copia del
│   (+ usage-parser)  stream de la API interna y extrae el usage REAL.
│                            │  window.postMessage
│                            ▼
├── content.js        Inyectado en la página (mundo aislado). Recibe el usage
│   (+ tokenizer,     real (o estima del DOM como fallback), calcula costo/ETA,
│      pricing)       detecta umbrales y manda mensajes internos.
│
└── background.js     Service Worker. Recibe mensajes de content.js
                      y hace el HTTP POST a la Telegram Bot API.
                                │
                                ▼
                      api.telegram.org  →  tu celular (iOS / Android)
```

Hay varios actores porque **Manifest V3** impone límites: los content scripts no
pueden hacer fetch a dominios externos (de ahí el service worker como proxy a
Telegram), y no pueden tocar el `fetch` de la página (de ahí el interceptor en el
*MAIN world*).

### Conteo de tokens

Cuando el **interceptor** logra leer el `usage` real de la API, los tokens son
**exactos** (incluyen caché, imágenes, tool calls — todo lo que ve Anthropic).

Como fallback, si no hay datos reales, se **estima** contando el texto del DOM
con una heurística BPE (~4 chars/token, ±10–15%). La barra marca con `≈` cuando
el valor es estimado. Detalle en la sección "Datos reales vs estimados".

La barra muestra:
- **Mensaje actual**: tokens del texto que estás escribiendo ahora
- **Conv**: contexto total + modelo + costo USD + ETA al límite

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
   Conv: ≈0 (0.0%)                          ≈0 tokens  |  –
   ```
   Tras el primer turno, si el interceptor funciona, cambia a datos reales
   (sin `≈`) con modelo y costo, ej:
   ```
   Conv: 18.432 (9.2%) · sonnet · $0.06     ≈0 tokens  |  –
   ```
4. Empezá a escribir — el contador actualiza en tiempo real
5. Para validar las notificaciones, usá el botón **"Probar notificación"** en la
   página de opciones (manda un mensaje de test a Telegram al instante)

---

## Datos reales vs estimados (el "interceptor")

La extensión usa dos fuentes de datos:

1. **Reales (preferido).** `interceptor.js` corre en el *MAIN world* de la página
   y hace monkeypatch de `fetch`/`XHR` para leer una **copia** del stream de
   respuesta de la API interna de claude.ai. De ahí saca el `usage` real:
   tokens exactos, caché, modelo y, con eso, el **costo en USD** y un **ETA** al
   límite. Son los mismos números que ve la API de Anthropic.
2. **Estimados (fallback).** Si el interceptor no aporta datos (claude.ai cambió
   su formato interno, o todavía no hubo un turno), se cae a contar el texto del
   DOM (aprox ±10–15%). La barra marca con `≈` cuando el valor es estimado.

La barra muestra: `Conv: <tokens> (<%>) · <modelo> · <costo> · ~<ETA>min`.

> **⚠️ Sobre el interceptor (leé esto):**
> - **No es ilegal**: lee *tu* propio tráfico, en *tu* browser, de *tu* sesión.
>   Equivale a mirar la pestaña Network de DevTools.
> - **Sí puede ir contra los Términos de Anthropic** (acceso a endpoints
>   internos no documentados). El peor caso es una acción sobre tu cuenta, no un
>   tema legal.
> - **Es frágil**: el formato interno no está documentado y puede cambiar sin
>   aviso. Si pasa, el sistema sigue funcionando como estimador del DOM.
>
> **Para desactivarlo**: borrá del `manifest.json` la segunda entrada de
> `content_scripts` (la que tiene `"world": "MAIN"`) y recargá la extensión.
> Quedás solo con el estimador, sin tocar endpoints internos.

El histórico por conversación (pico de contexto, turnos, costo) se guarda en
`chrome.storage.local` y sobrevive a recargas.

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
│   ├── tokenizer.js          Tokenizador heurístico (fallback, testeable).
│   ├── usage-parser.js       Extrae el usage REAL del stream de la API (testeable).
│   ├── interceptor.js        MAIN world: monkeypatch fetch/XHR → usage real.
│   ├── pricing.js            Modelo → límite de contexto y costo USD (testeable).
│   ├── content.js            UI (tokens/costo/ETA), umbrales, notificación.
│   ├── background.js         Service Worker: hace el POST a la Telegram Bot API.
│   ├── options.html          Página de opciones (creds, límite, umbrales, test).
│   ├── options.js            Guarda/lee config en chrome.storage.sync.
│   └── test/                 Tests (tokenizer, usage-parser, pricing).
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

- **Cuando hay datos reales** (interceptor activo), el conteo, el costo y el modelo son exactos. Cuando cae al **estimador del DOM** (marcado con `≈`), el error típico es ±10–15%.
- **El interceptor es frágil**: depende del formato interno no documentado de claude.ai. Si Anthropic lo cambia, deja de aportar números reales (sin romper: vuelve al estimador). Puede además ir contra los Términos (ver sección "Datos reales").
- **El costo en USD es aproximado**: usa tarifas públicas hardcodeadas en `pricing.js`; actualizalas si cambian.
- **El ETA** es una extrapolación lineal simple del ritmo reciente; es una señal, no una garantía.
- **Los selectores del DOM** dependen de la estructura interna de claude.ai, que puede cambiar sin aviso. Si la barra no aparece, la extensión muestra un badge de aviso a los ~10s; revisar los selectores en `findEditor()`.
- **No funciona en Claude Desktop** (la app Electron). Solo funciona en claude.ai dentro de un browser.
- **Firefox** requiere recargar la extensión después de cada reinicio del browser (extensión temporal).

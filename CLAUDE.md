# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two **independent** tools that both estimate Claude context usage and push
Telegram notifications when usage crosses thresholds (50% / 80% / 95% of a
200,000-token context limit). They share no code — only the same Telegram
notification idea and threshold scheme.

1. **`browser/`** — Chrome/Firefox extension (Manifest V3) for **claude.ai in a
   browser**. Shows a live token counter under the chat input.
2. **`claude_code/claude-monitor.py`** — Python daemon for **Claude Code** (the
   CLI). Tails `~/.claude/projects/**/*.jsonl` logs.

Codebase comments and README are in **Spanish**. Match that language when
editing comments.

## Running

**Python monitor** (stdlib only, no deps, no venv needed):
```bash
python3 claude_code/claude-monitor.py        # foreground
nohup python3 claude_code/claude-monitor.py & # persistent background
```

**Browser extension** (load unpacked, no build step — plain files):
- Chromium: `chrome://extensions` → Developer mode → "Load unpacked" → select `browser/`
- Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → pick `browser/manifest.json`
- After editing any `browser/*.js`, **reload the extension** in `chrome://extensions`.

**Tests / lint** (extension):
```bash
npm test            # node --test on browser/test/*.test.js — zero deps, offline
npm install && npm run lint   # eslint (flat config in eslint.config.js)
```
Only `tokenizer.js` is unit-tested (pure functions). `content.js` is DOM-bound
and untested. The Python monitor has no tests.

## Configuration (no secrets in source)

Credentials live **outside** the repo — never hardcode token/chatId:
- **Browser**: all config in `chrome.storage.sync`, edited via the options page
  (`browser/options.html` + `options.js`): `telegramToken`, `telegramChatId`,
  `contextLimit` (number), `thresholds` (array of percent numbers, e.g.
  `[50,80,95]`). `content.js` loads them async with `chrome.storage.sync.get`
  and refreshes on `chrome.storage.onChanged`. The options page has a "test
  notification" button that reuses the same `TELEGRAM_NOTIFY` SW path.
- **Python**: read from env vars `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID`, with a
  stdlib `.env` auto-loader (`_load_dotenv`, reads `claude_code/.env`). Template
  is `claude_code/.env.example`. Optional env: `CONTEXT_LIMIT`, `POLL_INTERVAL`.

`.env`, `*.secret`, `node_modules/` are gitignored. Python `THRESHOLDS` are
still in `claude-monitor.py` (not secret); the browser's are user-configurable.

## Architecture notes that aren't obvious from one file

**Browser: why two scripts.** MV3 forbids content scripts from `fetch()`-ing
external domains. `content.js` reads the DOM and counts tokens, then sends a
`chrome.runtime.sendMessage({type:'TELEGRAM_NOTIFY', ...})` to `background.js`
(service worker), which does the actual POST to `api.telegram.org`. The listener
**must `return true`** for the async `sendResponse` to survive. `content.js`
reads the `sendResponse` result: on failure it un-fires the threshold (retries
next input) and shows `⚠ envío falló` in the bar.

**Browser: script load order.** `manifest.json` loads `tokenizer.js` **before**
`content.js`; the tokenizer attaches `self.Tokenizer` (dual export — also
`module.exports` for Node tests). `content.js` calls `self.Tokenizer.approxTokens`.
Keep that order if adding content scripts.

**Browser: DOM coupling.** Token estimation depends on claude.ai's internal DOM
(ProseMirror editor, scroll container). Selectors live in `findEditor()` and
`findScrollContainer()` — first suspects if it breaks. If the editor isn't found
within `INJECT_TIMEOUT` (~10s), `showBrokenBadge()` surfaces a visible warning
instead of failing silently. SPA navigation patches `history.pushState` +
`MutationObserver`; threshold `fired` flags reset on conversation-ID change
(parsed from `/chat/<id>` in `onNavigate()`), not on a "low ratio" heuristic.

**Token counting is an approximation** (`tokenizer.js` `approxTokens`): ~4
chars/token for latin words, ~3 digits/token, ~1/char for non-latin scripts,
1/symbol. ±~10–15% vs Anthropic's real (unpublished) BPE tokenizer. It's
isolated on purpose: swap only `approxTokens` to drop in a real tokenizer.
Context limit is configurable (default 200_000; `detectContextLimit()` bumps to
1M if the page mentions it). The Python monitor still hardcodes 200_000 default.

**Python: do NOT sum `input_tokens` across turns.** Each Claude request resends
the full history, so turn N's `input_tokens` already = cumulative context. The
monitor tracks the **latest** turn's value (`ctx_now`), not a running sum.
Context = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(see `context_tokens()`). It reads only newly-appended lines via a saved file
offset (`file_pos`) and resets state when a newer `.jsonl` appears (new session).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two **independent** tools that both estimate Claude context usage and push
Telegram notifications when usage crosses thresholds (default 50% / 80% / 95% of
the context limit; 200k default, auto-detected per model). They share no code —
only the same Telegram notification idea and threshold scheme.

1. **`browser/`** — Chrome/Firefox extension (Manifest V3) for **claude.ai in a
   browser**. Shows a live token counter under the chat input.
2. **`claude_code/claude-monitor.py`** — Python daemon for **Claude Code** (the
   CLI). Tails `~/.claude/projects/**/*.jsonl` logs.

Codebase comments and README are in **Spanish**. Match that language when
editing comments.

## Running

**Python monitor** (stdlib only, no deps, no venv needed):
```bash
python3 claude_code/claude-monitor.py          # foreground
nohup python3 claude_code/claude-monitor.py &  # persistent background
python3 claude_code/claude-monitor.py --once   # single tick (smoke test)
python3 -m unittest discover -s claude_code -p 'test_*.py'   # tests
```
Runs as a `systemd --user` service via `claude_code/claude-monitor.service`.

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

`.env`, `*.secret`, `node_modules/` are gitignored. Python `THRESHOLDS` live in
`monitor_core.py` (not secret); the browser's are user-configurable.

## Architecture notes that aren't obvious from one file

**Browser: two data sources (real vs estimate).** Primary = REAL usage from the
page's internal API. `interceptor.js` runs in the **MAIN world** (manifest
`"world": "MAIN"`, `run_at: document_start`), monkeypatches `fetch`/`XHR`, reads
a `response.clone()` (never consumes the app's stream), and `usage-parser.js`
extracts the `usage` (exact tokens + cache + model). It posts to the ISOLATED
`content.js` via `window.postMessage` (`{__ctSource:'ct-usage', usage}`).
Fallback = DOM estimate (`tokenizer.js`) when no real data yet. `content.js`
prefers `real.ctx`; the bar marks estimates with `≈`. This is the "comodín":
it's fragile (undocumented internal format → silently falls back if it changes)
and may breach Anthropic's ToS (not illegal — your own traffic). Disable by
deleting the MAIN-world `content_scripts` entry.

**Browser: why the service worker.** MV3 forbids content scripts from
`fetch()`-ing external domains, so `content.js` sends
`chrome.runtime.sendMessage({type:'TELEGRAM_NOTIFY', ...})` to `background.js`,
which POSTs to `api.telegram.org`. The listener **must `return true`** for the
async `sendResponse`. `content.js` reads the result: on failure it un-fires the
threshold (retry) and shows `⚠ envío falló`.

**Browser: script load order & worlds.** ISOLATED world loads `tokenizer.js`,
`pricing.js`, then `content.js`. MAIN world loads `usage-parser.js`, then
`interceptor.js`. Each helper is a dual export (sets a `self.*` global AND
`module.exports` for Node tests): `Tokenizer`, `Pricing`, `UsageParser`. Keep
order if adding scripts.

**Browser: cost / ETA / history.** `pricing.js` maps model→limit and→USD
(hardcoded public rates; cache read 0.1×, write 1.25×). `content.js` accumulates
`real.totalCost` per turn, computes a linear-extrapolation `etaMinutes()` from
recent `samples`, and persists a per-conversation summary (peak ctx, turns,
cost) to `chrome.storage.local` (`ct-history`, throttled 10s).

**Browser: DOM coupling (fallback path).** DOM estimate depends on claude.ai's
internal DOM (ProseMirror editor, scroll container) — selectors in `findEditor()`
/ `findScrollContainer()`. If the editor isn't found within `INJECT_TIMEOUT`
(~10s), `showBrokenBadge()` shows a visible warning. SPA navigation patches
`history.pushState` + `MutationObserver`; session state + threshold `fired` reset
on conversation-ID change (`/chat/<id>` in `onNavigate()` → `resetSession()`).
Effective context limit is per-model (`Pricing.modelLimit`), falling back to the
configured value. The Python monitor still defaults to 200_000.

**Python: core/CLI split.** Logic lives in `claude_code/monitor_core.py`
(importable — underscore name); `claude-monitor.py` is a thin CLI that loads
`.env`, validates creds, and calls `monitor_core.main()`. The CLI's hyphen makes
it non-importable, hence the split (so `test_monitor_core.py` can import logic).

**Python: do NOT sum `input_tokens` across turns.** Each Claude request resends
the full history, so turn N's `input_tokens` already = cumulative context.
`process_line()` sets `session.ctx` to the **latest** value, never a sum.
Context = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(`context_tokens()`).

**Python: multi-session, per-file state.** The loop keeps `dict[path, Session]`
(`Session` dataclass holds `pos`/`ctx`/`fired`/`limit` per `.jsonl`). It watches
**all** files modified within `ACTIVE_WINDOW` (not just the newest), so parallel
Claude Code sessions don't clobber each other. Each reads only newly-appended
lines via its own `pos` offset. The FS glob is cached and refreshed every
`REFRESH_EVERY` ticks; sleep is adaptive (`POLL_ACTIVE`/`POLL_IDLE`).

**Python: threshold re-arm (`rearm()`).** Claude Code auto-compacts context, so
the ratio drops sharply then climbs again. `rearm()` un-fires any threshold now
above the current ratio, so it re-notifies on the next climb. `send_telegram()`
returns a bool; a threshold is only added to `fired` on success (else retried) —
parity with the browser. Context limit is per-session, auto-detected from the
model id (`model_limit()`, e.g. `[1m]` → 1,000,000).

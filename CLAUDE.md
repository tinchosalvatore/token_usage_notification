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

**Browser extension** (load unpacked):
- Chromium: `chrome://extensions` → Developer mode → "Load unpacked" → select `browser/`
- Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → pick `browser/manifest.json`
- After editing `content.js`/`background.js`, **reload the extension** in `chrome://extensions`.

No build, lint, or test setup exists.

## Configuration (no secrets in source)

Credentials live **outside** the repo — never hardcode token/chatId:
- **Browser**: stored in `chrome.storage.sync`, edited via the options page
  (`browser/options.html` + `options.js`). `content.js` loads them async with
  `chrome.storage.sync.get` and refreshes on `chrome.storage.onChanged`.
- **Python**: read from env vars `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID`, with a
  stdlib `.env` auto-loader (`_load_dotenv`, reads `claude_code/.env`). Template
  is `claude_code/.env.example`. Optional env: `CONTEXT_LIMIT`, `POLL_INTERVAL`.

`.env` and `*.secret` are gitignored. `THRESHOLDS` arrays (not secret) are still
defined separately in `content.js` and `claude-monitor.py`.

## Architecture notes that aren't obvious from one file

**Browser: why two scripts.** MV3 forbids content scripts from `fetch()`-ing
external domains. `content.js` reads the DOM and counts tokens, then sends a
`chrome.runtime.sendMessage({type:'TELEGRAM_NOTIFY', ...})` to `background.js`
(service worker), which does the actual POST to `api.telegram.org`. The listener
**must `return true`** for the async `sendResponse` to survive.

**Browser: DOM coupling.** Token estimation depends on claude.ai's internal DOM
(ProseMirror editor, scroll container). If the bar stops appearing, the
selectors in `findEditor()` and `estimateConversationTokens()` are the first
suspects — claude.ai can change them without notice. SPA navigation is handled
by patching `history.pushState` + a `MutationObserver`.

**Token counting is an approximation** (`approxTokens`): ~4 chars/token for
words, ~1/digit, 1/symbol. ±10–15% vs Anthropic's real (unpublished) BPE
tokenizer. Both tools assume `CONTEXT_LIMIT = 200_000`.

**Python: do NOT sum `input_tokens` across turns.** Each Claude request resends
the full history, so turn N's `input_tokens` already = cumulative context. The
monitor tracks the **latest** turn's value (`ctx_now`), not a running sum.
Context = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(see `context_tokens()`). It reads only newly-appended lines via a saved file
offset (`file_pos`) and resets state when a newer `.jsonl` appears (new session).

#!/usr/bin/env python3
"""
claude-monitor.py — Claude Code Token Monitor

Observa los logs JSONL que Claude Code escribe en ~/.claude/projects/
y envía notificaciones push via Telegram al superar umbrales de contexto.

Uso:
    python3 claude-monitor.py              # foreground
    python3 claude-monitor.py &            # background (ctrl+c para detener)
    nohup python3 claude-monitor.py &      # background persistente (cierra terminal)
"""

import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURACIÓN — vía variables de entorno (no se hardcodean secretos)
#
# Definí en tu entorno, o en un archivo .env junto a este script:
#     TELEGRAM_TOKEN=7123456789:AAHx...
#     TELEGRAM_CHAT_ID=123456789
# Opcionales: CONTEXT_LIMIT, POLL_INTERVAL
# Ver .env.example.
# ─────────────────────────────────────────────────────────────────────────────

def _load_dotenv(path: str) -> None:
    """Mini-loader de .env (stdlib, sin dependencias).
    No pisa variables ya presentes en el entorno real."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

TELEGRAM_TOKEN   = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

CONTEXT_LIMIT = int(os.environ.get("CONTEXT_LIMIT", 200_000))  # tokens máx del modelo
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", 2))        # segundos entre lecturas

THRESHOLDS = [
    {"pct": 0.50, "emoji": "⚠️",  "label": "50%"},
    {"pct": 0.80, "emoji": "🔴",  "label": "80%"},
    {"pct": 0.95, "emoji": "🚨",  "label": "95%"},
]

# Path donde Claude Code guarda sus logs (no debería ser necesario cambiar esto)
CLAUDE_DIR = os.path.expanduser("~/.claude/projects")

# ─────────────────────────────────────────────────────────────────────────────
# TELEGRAM
# ─────────────────────────────────────────────────────────────────────────────

def send_telegram(text: str) -> None:
    url     = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id":    TELEGRAM_CHAT_ID,
        "text":       text,
        "parse_mode": "HTML",
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except urllib.error.URLError as e:
        print(f"  ⚠  No se pudo notificar: {e}")

# ─────────────────────────────────────────────────────────────────────────────
# PARSING DE LOGS JSONL
#
# Claude Code escribe en ~/.claude/projects/**/*.jsonl una línea por evento.
# Los registros de tipo "assistant" contienen el campo "usage" con los tokens.
#
# IMPORTANTE — por qué NO sumamos input_tokens entre turnos:
# Cada request a Claude incluye el historial completo de la conversación.
# Entonces input_tokens del turno N = contexto acumulado hasta N.
# Sumarlos implicaría contar el mismo contexto múltiples veces.
# Lo que nos interesa es el valor del ÚLTIMO turno (= contexto actual).
#
# Fórmula de contexto total:
#   input_tokens                 → tokens nuevos (no cacheados)
#   cache_creation_input_tokens  → tokens que crearon una entrada de caché
#   cache_read_input_tokens      → tokens leídos desde caché
# Los tres juntos = todo lo que el modelo está "viendo" en ese turno.
# ─────────────────────────────────────────────────────────────────────────────

def extract_usage(record: dict) -> dict | None:
    """Extrae el dict 'usage' de un record JSONL. Maneja múltiples formatos."""
    # Formato principal: {"type": "assistant", "message": {"usage": {...}}}
    if record.get("type") == "assistant":
        msg = record.get("message", {})
        if isinstance(msg, dict) and "usage" in msg:
            return msg["usage"]

    # Formato alternativo: usage en root del record
    if "usage" in record and isinstance(record["usage"], dict):
        return record["usage"]

    return None

def context_tokens(usage: dict) -> int:
    """Tokens totales en contexto para ese turno (incluye caché)."""
    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
    )

def output_tokens(usage: dict) -> int:
    return usage.get("output_tokens", 0)

# ─────────────────────────────────────────────────────────────────────────────
# FILE WATCHER
# ─────────────────────────────────────────────────────────────────────────────

def find_latest_jsonl() -> str | None:
    """Retorna el .jsonl modificado más recientemente en ~/.claude/projects/"""
    files = glob.glob(os.path.join(CLAUDE_DIR, "**", "*.jsonl"), recursive=True)
    return max(files, key=os.path.getmtime) if files else None

def fmt(n: int) -> str:
    """Formato de número con puntos de miles."""
    return f"{n:,}".replace(",", ".")

# ─────────────────────────────────────────────────────────────────────────────
# LOOP PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────

def monitor() -> None:
    print("━" * 54)
    print("  Claude Code Token Monitor")
    print("━" * 54)
    print(f"  Logs:     {CLAUDE_DIR}")
    print(f"  Contexto: {fmt(CONTEXT_LIMIT)} tokens")
    print(f"  Umbrales: {', '.join(t['label'] for t in THRESHOLDS)}")
    print("━" * 54)
    print()

    current_file    = None
    file_pos        = 0
    ctx_now         = 0   # input_tokens del último turno (contexto actual)
    out_total       = 0   # output_tokens acumulados (informativo)
    fired: set[float] = set()
    turn            = 0

    while True:
        latest = find_latest_jsonl()

        # ── Detectar nueva sesión ────────────────────────────────────────────
        if latest != current_file:
            current_file = latest
            file_pos     = 0
            ctx_now      = 0
            out_total    = 0
            fired        = set()
            turn         = 0
            if latest:
                # El dirname es el hash del proyecto
                project = os.path.basename(os.path.dirname(latest))
                ts = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts}] 📂 Sesión nueva: ...{project[-12:]}")

        if not current_file or not os.path.exists(current_file):
            time.sleep(POLL_INTERVAL)
            continue

        # ── Leer líneas nuevas ───────────────────────────────────────────────
        try:
            with open(current_file, "r", encoding="utf-8") as f:
                f.seek(file_pos)
                new_lines = f.readlines()
                file_pos  = f.tell()
        except (IOError, OSError):
            time.sleep(POLL_INTERVAL)
            continue

        for line in new_lines:
            line = line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            usage = extract_usage(record)
            if not usage:
                continue

            ctx = context_tokens(usage)
            out = output_tokens(usage)

            if ctx == 0 and out == 0:
                continue

            # Actualizamos ctx_now con el valor más reciente (no sumamos)
            ctx_now    = ctx
            out_total += out
            turn      += 1

            ratio = ctx_now / CONTEXT_LIMIT
            pct   = ratio * 100

            ts = datetime.now().strftime("%H:%M:%S")
            print(
                f"[{ts}] Turno {turn:>3} │ "
                f"ctx {fmt(ctx_now):>9} tok ({pct:5.1f}%) │ "
                f"out +{fmt(out)}"
            )

            # ── Notificaciones ───────────────────────────────────────────────
            for t in THRESHOLDS:
                key = t["pct"]
                if key not in fired and ratio >= key:
                    fired.add(key)
                    print(f"            🔔 Notificando: {t['label']}")
                    send_telegram(
                        f"{t['emoji']} <b>Claude Code: {t['label']} del contexto</b>\n"
                        f"<code>≈{fmt(ctx_now)} / {fmt(CONTEXT_LIMIT)} tokens</code>\n"
                        f"<i>Turno {turn} · out acumulado: {fmt(out_total)}</i>"
                    )

        time.sleep(POLL_INTERVAL)

# ─────────────────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("❌  Faltan credenciales. Definí TELEGRAM_TOKEN y TELEGRAM_CHAT_ID")
        print("    como variables de entorno o en un archivo .env (ver .env.example).")
        sys.exit(1)

    if not os.path.exists(CLAUDE_DIR):
        print(f"❌  No encontré {CLAUDE_DIR}")
        print("    ¿Tenés Claude Code instalado y al menos una sesión ejecutada?")
        sys.exit(1)

    try:
        monitor()
    except KeyboardInterrupt:
        print("\n\n👋  Monitor detenido.")

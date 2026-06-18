"""
monitor_core.py — Lógica del Claude Code Token Monitor.

Módulo importable (de ahí el guión bajo en el nombre): el CLI thin
`claude-monitor.py` lo importa y llama a `main()`. Separar la lógica acá hace
que las funciones puras sean testeables sin browser ni daemon corriendo.

Vigila los logs JSONL que Claude Code escribe en ~/.claude/projects/ y notifica
por Telegram al superar umbrales de contexto. Cero dependencias (solo stdlib).
"""

from __future__ import annotations

import glob
import json
import logging
import logging.handlers
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURACIÓN (defaults; el CLI los override por env / .env)
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_LIMIT = 200_000        # tokens de contexto por defecto (Sonnet/Opus)
POLL_ACTIVE   = 1.0            # seg entre lecturas cuando hay actividad
POLL_IDLE     = 5.0            # seg entre lecturas en idle
REFRESH_EVERY = 10             # cada cuántos ticks se re-globbea el FS
ACTIVE_WINDOW = 600            # seg: solo se vigilan archivos modificados recién

THRESHOLDS = [
    {"pct": 0.50, "emoji": "⚠️",  "label": "50%"},
    {"pct": 0.80, "emoji": "🔴",  "label": "80%"},
    {"pct": 0.95, "emoji": "🚨",  "label": "95%"},
]

# Límites de contexto por modelo. La clave se busca como substring del id.
# Claude Code marca el contexto de 1M con el sufijo "[1m]" en el model id.
MODEL_LIMITS = {
    "[1m]": 1_000_000,
    "-1m":  1_000_000,
}

CLAUDE_DIR = os.path.expanduser("~/.claude/projects")

log = logging.getLogger("claude-monitor")

# ─────────────────────────────────────────────────────────────────────────────
# FUNCIONES PURAS (testeables)
# ─────────────────────────────────────────────────────────────────────────────

def extract_usage(record: dict) -> dict | None:
    """Extrae el dict 'usage' de un record JSONL. Maneja múltiples formatos."""
    # Formato principal: {"type": "assistant", "message": {"usage": {...}}}
    if record.get("type") == "assistant":
        msg = record.get("message", {})
        if isinstance(msg, dict) and isinstance(msg.get("usage"), dict):
            return msg["usage"]

    # Formato alternativo: usage en root del record
    if isinstance(record.get("usage"), dict):
        return record["usage"]

    return None


def extract_model(record: dict) -> str:
    """Devuelve el model id del record, o '' si no está."""
    msg = record.get("message", {})
    if isinstance(msg, dict) and isinstance(msg.get("model"), str):
        return msg["model"]
    if isinstance(record.get("model"), str):
        return record["model"]
    return ""


def context_tokens(usage: dict) -> int:
    """Tokens totales en contexto para ese turno (incluye caché).

    IMPORTANTE: cada request a Claude reenvía la conversación completa, así que
    input_tokens del turno N = contexto acumulado hasta N. Por eso NO se suman
    entre turnos: nos interesa el valor del último turno.
    """
    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
    )


def output_tokens(usage: dict) -> int:
    return usage.get("output_tokens", 0)


def model_limit(model: str, default: int = DEFAULT_LIMIT) -> int:
    """Límite de contexto según el model id. Si no matchea, devuelve default."""
    m = (model or "").lower()
    for needle, limit in MODEL_LIMITS.items():
        if needle in m:
            return limit
    return default


def due_thresholds(ratio: float, fired: set, thresholds=THRESHOLDS) -> list:
    """Umbrales que deben dispararse ahora (cruzados y todavía no notificados)."""
    return [t for t in thresholds if ratio >= t["pct"] and t["pct"] not in fired]


def rearm(ratio: float, fired: set, thresholds=THRESHOLDS) -> None:
    """Re-arma (saca de 'fired') los umbrales cuyo pct quedó por encima del ratio.

    Claude Code compacta el contexto automáticamente: tras un compact el ratio
    cae de golpe. Re-armar permite volver a avisar cuando el contexto vuelva a
    subir, en vez de quedar silenciado para siempre.
    """
    for t in thresholds:
        if t["pct"] > ratio:
            fired.discard(t["pct"])


def fmt(n: int) -> str:
    """Formato de número con puntos de miles."""
    return f"{n:,}".replace(",", ".")


# ─────────────────────────────────────────────────────────────────────────────
# ESTADO POR SESIÓN
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Session:
    path: str
    pos: int = 0                 # offset de lectura dentro del archivo
    ctx: int = 0                 # tokens del último turno (contexto actual)
    out_total: int = 0           # output acumulado (informativo)
    turn: int = 0
    limit: int = DEFAULT_LIMIT
    fired: set = field(default_factory=set)

    @property
    def short(self) -> str:
        """Identificador corto para logs (hash del proyecto)."""
        project = os.path.basename(os.path.dirname(self.path))
        return project[-12:] if project else os.path.basename(self.path)


# ─────────────────────────────────────────────────────────────────────────────
# TELEGRAM
# ─────────────────────────────────────────────────────────────────────────────

def send_telegram(text: str, token: str, chat_id: str) -> bool:
    """Manda un mensaje. Devuelve True si salió OK, False si falló (para retry)."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id, "text": text, "parse_mode": "HTML",
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError) as e:
        log.warning("No se pudo notificar: %s", e)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

def setup_logging(log_file: str | None = None) -> logging.Logger:
    """Configura el logger: consola siempre + archivo rotado si se pide."""
    log.setLevel(logging.INFO)
    log.handlers.clear()
    fmt_str = "%(asctime)s %(message)s"
    datefmt = "%H:%M:%S"

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter(fmt_str, datefmt))
    log.addHandler(console)

    if log_file:
        fh = logging.handlers.RotatingFileHandler(
            os.path.expanduser(log_file), maxBytes=1_000_000, backupCount=3,
            encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        log.addHandler(fh)

    return log


# ─────────────────────────────────────────────────────────────────────────────
# FILE WATCHER (stdlib optimizado)
# ─────────────────────────────────────────────────────────────────────────────

def active_files(window: int = ACTIVE_WINDOW) -> list[str]:
    """.jsonl modificados dentro de la ventana de actividad (sesiones vivas)."""
    cutoff = time.time() - window
    out = []
    for p in glob.glob(os.path.join(CLAUDE_DIR, "**", "*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(p) >= cutoff:
                out.append(p)
        except OSError:
            continue
    return out


def read_new_lines(session: Session) -> list[str]:
    """Lee las líneas agregadas desde el último offset. Actualiza session.pos."""
    try:
        with open(session.path, "r", encoding="utf-8") as f:
            f.seek(session.pos)
            lines = f.readlines()
            session.pos = f.tell()
        return lines
    except (IOError, OSError):
        return []


def process_line(line: str, session: Session) -> dict | None:
    """Parsea una línea y actualiza el estado de la sesión.

    Devuelve un dict con info del turno si tenía usage relevante, o None.
    """
    line = line.strip()
    if not line:
        return None
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return None

    usage = extract_usage(record)
    if not usage:
        return None

    ctx = context_tokens(usage)
    out = output_tokens(usage)
    if ctx == 0 and out == 0:
        return None

    session.ctx = ctx                       # NO se suma: es el contexto actual
    session.out_total += out
    session.turn += 1
    session.limit = model_limit(extract_model(record), session.limit)

    ratio = session.ctx / session.limit if session.limit else 0.0
    return {"ctx": ctx, "out": out, "ratio": ratio}


# ─────────────────────────────────────────────────────────────────────────────
# NOTIFICACIÓN POR SESIÓN
# ─────────────────────────────────────────────────────────────────────────────

def notify_thresholds(session: Session, ratio: float, token: str, chat_id: str,
                      thresholds=THRESHOLDS) -> None:
    """Re-arma, calcula umbrales pendientes y notifica (con retry implícito)."""
    rearm(ratio, session.fired, thresholds)
    for t in due_thresholds(ratio, session.fired, thresholds):
        text = (
            f"{t['emoji']} <b>Claude Code: {t['label']} del contexto</b>\n"
            f"<code>≈{fmt(session.ctx)} / {fmt(session.limit)} tokens</code>\n"
            f"<i>Turno {session.turn} · out acumulado: {fmt(session.out_total)}</i>"
        )
        log.info("   🔔 Notificando %s (sesión ...%s)", t["label"], session.short)
        if send_telegram(text, token, chat_id):
            session.fired.add(t["pct"])     # solo marca si salió OK
        else:
            log.info("   ↻ envío falló; se reintenta en el próximo turno")


# ─────────────────────────────────────────────────────────────────────────────
# LOOP PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────

def tick(sessions: dict[str, Session], files: list[str],
         token: str, chat_id: str, default_limit: int) -> bool:
    """Un paso del loop: procesa todos los archivos activos.

    Devuelve True si hubo líneas nuevas en algún archivo (para sleep adaptativo).
    """
    active = set(files)
    activity = False

    # Prune: sesiones cuyo archivo ya no está activo
    for path in list(sessions):
        if path not in active:
            del sessions[path]

    for path in files:
        session = sessions.get(path)
        if session is None:
            session = Session(path=path, limit=default_limit)
            sessions[path] = session
            log.info("📂 Sesión nueva: ...%s", session.short)

        lines = read_new_lines(session)
        if lines:
            activity = True
        for line in lines:
            info = process_line(line, session)
            if info is None:
                continue
            log.info(
                "Turno %3d │ ctx %9s tok (%5.1f%%) │ out +%s  [...%s]",
                session.turn, fmt(session.ctx), info["ratio"] * 100,
                fmt(info["out"]), session.short,
            )
            notify_thresholds(session, info["ratio"], token, chat_id)

    return activity


def monitor(token: str, chat_id: str, default_limit: int = DEFAULT_LIMIT,
            once: bool = False) -> None:
    """Loop principal. Si once=True hace un solo tick (para tests/smoke)."""
    log.info("%s", "━" * 54)
    log.info("  Claude Code Token Monitor")
    log.info("%s", "━" * 54)
    log.info("  Logs:     %s", CLAUDE_DIR)
    log.info("  Contexto: %s tokens (default)", fmt(default_limit))
    log.info("  Umbrales: %s", ", ".join(t["label"] for t in THRESHOLDS))
    log.info("%s", "━" * 54)

    sessions: dict[str, Session] = {}
    files: list[str] = []
    n = 0

    while True:
        if n % REFRESH_EVERY == 0:          # re-glob solo cada N ticks
            files = active_files()
        n += 1

        activity = tick(sessions, files, token, chat_id, default_limit)

        if once:
            return
        time.sleep(POLL_ACTIVE if activity else POLL_IDLE)


def main(token: str, chat_id: str, default_limit: int = DEFAULT_LIMIT,
         log_file: str | None = None, once: bool = False) -> None:
    """Entry point invocado desde el CLI."""
    setup_logging(log_file)
    try:
        monitor(token, chat_id, default_limit, once=once)
    except KeyboardInterrupt:
        log.info("👋  Monitor detenido.")

#!/usr/bin/env python3
"""
claude-monitor.py — CLI del Claude Code Token Monitor.

Thin wrapper: carga config (env / .env), valida credenciales y delega toda la
lógica a monitor_core.main(). La lógica vive en monitor_core.py para poder
testearla (este archivo no es importable por el guión en el nombre).

Uso:
    python3 claude-monitor.py                 # foreground
    nohup python3 claude-monitor.py &         # background persistente
    python3 claude-monitor.py --once          # un solo tick (smoke test)

Config (variables de entorno o archivo .env junto a este script):
    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID          # requeridas
    CONTEXT_LIMIT, LOG_FILE, ACTIVE_WINDOW_SEC # opcionales
Ver .env.example.
"""

import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)  # para importar monitor_core (mismo dir)


def load_dotenv(path: str) -> None:
    """Mini-loader de .env (stdlib). No pisa variables ya presentes."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def main() -> None:
    load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

    parser = argparse.ArgumentParser(description="Claude Code Token Monitor")
    parser.add_argument("--once", action="store_true",
                        help="un solo tick y salir (smoke test)")
    parser.add_argument("--log-file", default=os.environ.get("LOG_FILE"),
                        help="archivo de log rotado (o env LOG_FILE)")
    args = parser.parse_args()

    token   = os.environ.get("TELEGRAM_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    limit   = int(os.environ.get("CONTEXT_LIMIT", 200_000))

    if not token or not chat_id:
        print("❌  Faltan credenciales. Definí TELEGRAM_TOKEN y TELEGRAM_CHAT_ID")
        print("    como variables de entorno o en un archivo .env (ver .env.example).")
        sys.exit(1)

    import monitor_core

    if not os.path.exists(monitor_core.CLAUDE_DIR):
        print(f"❌  No encontré {monitor_core.CLAUDE_DIR}")
        print("    ¿Tenés Claude Code instalado y al menos una sesión ejecutada?")
        sys.exit(1)

    # ACTIVE_WINDOW_SEC override opcional
    win = os.environ.get("ACTIVE_WINDOW_SEC")
    if win:
        monitor_core.ACTIVE_WINDOW = int(win)

    monitor_core.main(token, chat_id, default_limit=limit,
                      log_file=args.log_file, once=args.once)


if __name__ == "__main__":
    main()

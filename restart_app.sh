#!/usr/bin/env bash

set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_PORT=8000
APP_PYTHON="$APP_DIR/.venv/bin/python"

if ! command -v lsof >/dev/null 2>&1; then
  echo "Cannot restart: lsof is required to identify the process on port $APP_PORT." >&2
  exit 1
fi

if [[ ! -x "$APP_PYTHON" ]]; then
  echo "Cannot restart: $APP_PYTHON was not found." >&2
  echo "Create the virtual environment and install requirements first." >&2
  exit 1
fi

LISTENER_PIDS="$(lsof -tiTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null || true)"

for LISTENER_PID in $LISTENER_PIDS; do
  LISTENER_CWD="$(lsof -a -p "$LISTENER_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  if [[ "$LISTENER_CWD" != "$APP_DIR" ]]; then
    echo "Refusing to stop PID $LISTENER_PID: port $APP_PORT belongs to $LISTENER_CWD." >&2
    exit 1
  fi

  echo "Stopping Rental Property Deal Analyzer (PID $LISTENER_PID)..."
  kill "$LISTENER_PID"

  for _ in {1..20}; do
    if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if kill -0 "$LISTENER_PID" 2>/dev/null; then
    echo "PID $LISTENER_PID did not stop. Stop it manually and try again." >&2
    exit 1
  fi
done

if [[ -z "$LISTENER_PIDS" ]]; then
  echo "No existing analyzer found on port $APP_PORT."
fi

echo "Starting Rental Property Deal Analyzer at http://localhost:$APP_PORT ..."
cd "$APP_DIR"
exec "$APP_PYTHON" app.py

#!/usr/bin/env bash
# Запуск панели управления Ollama.
#
#   ./run.sh                 # запуск на 127.0.0.1:5000
#   PANEL_PORT=8080 ./run.sh # другой порт
#
# Скрипт сам создаёт виртуальное окружение и ставит зависимости, если их нет.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$PROJECT_DIR/venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo ">> Создаю виртуальное окружение: $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade pip
  "$VENV_DIR/bin/pip" install -r "$PROJECT_DIR/requirements.txt"
fi

echo ">> Панель управления Ollama: http://${PANEL_HOST:-127.0.0.1}:${PANEL_PORT:-5000}"
exec "$VENV_DIR/bin/python" "$PROJECT_DIR/app.py" "$@"

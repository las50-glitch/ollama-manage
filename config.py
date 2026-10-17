"""Конфигурация панели управления Ollama.

Все параметры можно переопределить переменными окружения, например:

    PANEL_PORT=8080 OLLAMA_HOST=http://127.0.0.1:11434 ./venv/bin/python app.py

В Windows путь к интерпретатору виртуального окружения другой —
`venv\\Scripts\\python.exe` (или просто запустите `run.bat`).
"""

import os


def _env_int(name: str, default: int) -> int:
    """Читает целочисленную переменную окружения с безопасным fallback."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    """Читает булеву переменную окружения ("1", "true", "yes", "on")."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Ollama ---------------------------------------------------------------
# Адрес REST API локально установленной Ollama.
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# Имя systemd-юнита службы Ollama (используется на Linux с systemd).
OLLAMA_SERVICE = os.environ.get("OLLAMA_SERVICE", "ollama.service")

# Имя процесса Ollama для Windows и macOS, где службы systemd нет. Пусто —
# подставляется «ollama.exe» в Windows и «ollama» в остальных системах.
OLLAMA_PROCESS_NAME = os.environ.get("OLLAMA_PROCESS_NAME", "").strip()

# Файл журнала Ollama: нужен на Windows и macOS (там Ollama пишет журнал в файл),
# а также если Ollama запущена вручную, без systemd. Пусто — путь определяется
# автоматически: %LOCALAPPDATA%\Ollama\server.log, ~/.ollama/logs/server.log.
# Если переменная задана, панель читает журнал из файла даже при наличии systemd.
OLLAMA_LOG_FILE = os.environ.get("OLLAMA_LOG_FILE", "").strip()

# --- Веб-панель -----------------------------------------------------------
# По умолчанию панель слушает только loopback: у неё нет аутентификации,
# а доступ к Ollama API и журналу из сети не нужен.
PANEL_HOST = os.environ.get("PANEL_HOST", "127.0.0.1")
PANEL_PORT = _env_int("PANEL_PORT", 5000)
PANEL_DEBUG = _env_bool("PANEL_DEBUG", False)

# --- Таймауты (секунды) ---------------------------------------------------
HTTP_TIMEOUT = _env_int("HTTP_TIMEOUT", 10)          # обычные запросы к Ollama
PULL_TIMEOUT = _env_int("PULL_TIMEOUT", 3600)        # чтение потока /api/pull
CHAT_TIMEOUT = _env_int("CHAT_TIMEOUT", 600)         # чтение потока /api/chat
LOAD_TIMEOUT = _env_int("LOAD_TIMEOUT", 600)         # загрузка модели в память

# --- Журнал Ollama (journalctl на Linux, файл журнала на Windows/macOS) ---
JOURNAL_LINES_DEFAULT = _env_int("JOURNAL_LINES_DEFAULT", 200)
JOURNAL_LINES_MAX = _env_int("JOURNAL_LINES_MAX", 5000)

# --- Поиск моделей на Hugging Face ---------------------------------------
# Публичный API Hugging Face (токен не нужен для открытых репозиториев).
HF_API_BASE = os.environ.get("HF_API_BASE", "https://huggingface.co/api")
HF_TIMEOUT = _env_int("HF_TIMEOUT", 20)
HF_SEARCH_LIMIT_DEFAULT = _env_int("HF_SEARCH_LIMIT_DEFAULT", 20)
HF_SEARCH_LIMIT_MAX = _env_int("HF_SEARCH_LIMIT_MAX", 50)
# Токен по умолчанию: нужен для закрытых (gated) репозиториев. Значение,
# сохранённое в панели (data/settings.json), перекрывает переменную окружения.
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

# --- Настройки панели, сохраняемые на диск -------------------------------
# В data/settings.json лежит, например, токен Hugging Face (права 600).
SETTINGS_DIR = os.environ.get(
    "PANEL_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
)
SETTINGS_FILE = os.environ.get(
    "PANEL_SETTINGS_FILE", os.path.join(SETTINGS_DIR, "settings.json")
)

# --- Чат и загрузка моделей в память -------------------------------------
# keep_alive — сколько держать модель в памяти (формат Ollama: "5m", "1h", "0").
CHAT_KEEP_ALIVE = os.environ.get("CHAT_KEEP_ALIVE", "5m")
PRELOAD_KEEP_ALIVE = os.environ.get("PRELOAD_KEEP_ALIVE", "30m")
# Ограничения параметров генерации, которые можно менять из интерфейса.
CHAT_TEMPERATURE_MAX = 2.0
CHAT_NUM_CTX_MIN = 512
CHAT_NUM_CTX_MAX = 131072
CHAT_NUM_PREDICT_MAX = 8192
CHAT_HISTORY_MAX = 100        # максимум сообщений в одном запросе
CHAT_MESSAGE_MAX_CHARS = 200_000  # максимум символов в одном сообщении
# Размышления моделей (qwen3, deepseek-r1 …): "auto" — как в Ollama,
# "off" — передавать think=false, "on" — think=true.
CHAT_THINK_DEFAULT = os.environ.get("CHAT_THINK", "auto").strip().lower()
if CHAT_THINK_DEFAULT not in {"auto", "on", "off"}:
    CHAT_THINK_DEFAULT = "auto"

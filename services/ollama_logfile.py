"""Ollama без systemd: состояние процесса и журнал из файла.

Windows и macOS не используют systemd: там Ollama работает как обычное
приложение (значок в трее) и пишет журнал в файл. Модуль даёт вкладкам
«Служба» и «Логи» те же данные, что systemd-бэкенд на Linux:

* состояние процесса (запущен, PID, память) — `tasklist` на Windows, `ps` на
  macOS и Linux;
* автозапуск — ключи `Run` реестра и папка «Автозагрузка» на Windows, агенты
  `launchd` на macOS;
* журнал — «хвост» файла `server.log` (см. `services/logtail.py`).

Число перезапусков и время старта процесса не заполняются: у обычного процесса
этих сведений нет, поэтому в интерфейсе на их месте стоит «—».
"""

from __future__ import annotations

import csv
import os
import platform
import re
import subprocess
import sys
from typing import Any

import config
from services import logtail
from utils import human_size

IS_WINDOWS = os.name == "nt"
IS_MACOS = platform.system().lower() == "darwin"

# Флаги, чтобы на Windows не мигало окно консоли у вспомогательных команд.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Имена файлов журнала Ollama (в порядке проверки).
LOG_FILE_NAMES = ("server.log", "ollama.log", "app.log")


class LogfileError(RuntimeError):
    """Ошибка при чтении состояния процесса или файла журнала Ollama."""


# ----------------------------------------------------------------------
# процесс Ollama
# ----------------------------------------------------------------------
def process_name() -> str:
    """Имя процесса Ollama для текущей ОС (переопределяется OLLAMA_PROCESS_NAME)."""
    if config.OLLAMA_PROCESS_NAME:
        return config.OLLAMA_PROCESS_NAME
    return "ollama.exe" if IS_WINDOWS else "ollama"


def _run(cmd: list[str], *, timeout: int = 15) -> subprocess.CompletedProcess:
    """Запускает вспомогательную команду, не выбрасывая исключений."""
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise LogfileError(f"Команда «{cmd[0]}» не найдена в системе") from exc
    except subprocess.TimeoutExpired as exc:
        raise LogfileError(f"Команда «{cmd[0]}» не завершилась за {timeout} с") from exc
    except OSError as exc:
        raise LogfileError(f"Не удалось выполнить «{cmd[0]}»: {exc}") from exc


def _is_ollama(name: str) -> bool:
    """Похоже ли имя процесса на Ollama (сам сервер или раннер модели)."""
    base = (name or "").strip().lower().replace("\\", "/").rsplit("/", 1)[-1]
    target = process_name().strip().lower()
    if base == target:
        return True
    # Раннеры моделей: ollama_llama_server(.exe) — учитываем их память тоже.
    return base.startswith(target.rsplit(".", 1)[0] + "_")


def _kb_to_bytes(value: str) -> int | None:
    """Преобразует поле памяти `tasklist` («1 234 567 КБ») в байты."""
    digits = re.sub(r"[^0-9]", "", value or "")
    if not digits:
        return None
    return int(digits) * 1024


def parse_tasklist(text: str) -> list[dict[str, Any]]:
    """Разбирает вывод `tasklist /FO CSV /NH` в список процессов.

    Формат строки: `"ollama.exe","1234","Console","1","1 234 567 КБ"`.
    Разделитель тысяч и единица измерения зависят от локали Windows, поэтому из
    поля памяти берутся только цифры (это всегда килобайты).
    """
    processes: list[dict[str, Any]] = []
    for row in csv.reader(text.splitlines()):
        if len(row) < 2:
            continue
        name = (row[0] or "").strip()
        pid_raw = (row[1] or "").strip()
        if not name or not pid_raw.isdigit():
            continue
        processes.append(
            {
                "name": name,
                "pid": int(pid_raw),
                "memory_bytes": _kb_to_bytes(row[4]) if len(row) > 4 else None,
            }
        )
    return processes


def parse_ps(text: str) -> list[dict[str, Any]]:
    """Разбирает вывод `ps -eo pid=,rss=,comm=` в список процессов.

    `rss` в этом формате — килобайты, `comm` может быть полным путём к файлу.
    """
    processes: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid_raw, rss_raw, command = parts
        if not pid_raw.isdigit():
            continue
        processes.append(
            {
                "name": os.path.basename(command.strip()),
                "pid": int(pid_raw),
                "memory_bytes": int(rss_raw) * 1024 if rss_raw.isdigit() else None,
            }
        )
    return processes


def processes() -> list[dict[str, Any]]:
    """Возвращает процессы Ollama (пустой список, если их нет)."""
    target = process_name()
    if IS_WINDOWS:
        proc = _run(
            ["tasklist", "/FI", f"IMAGENAME eq {target}", "/FO", "CSV", "/NH"], timeout=15
        )
        found = parse_tasklist(proc.stdout or "")
    else:
        proc = _run(["ps", "-eo", "pid=,rss=,comm="], timeout=15)
        found = parse_ps(proc.stdout or "")
    return [item for item in found if _is_ollama(item["name"])]


# ----------------------------------------------------------------------
# автозапуск
# ----------------------------------------------------------------------
def _windows_autostart() -> str | None:
    """Состояние автозапуска Ollama в Windows: enabled/disabled/None."""
    try:
        import winreg  # доступен только на Windows
    except ImportError:
        return None

    # Ключи Run текущего пользователя и всей системы.
    keys = [
        (0x80000001, r"Software\Microsoft\Windows\CurrentVersion\Run"),
        (0x80000002, r"Software\Microsoft\Windows\CurrentVersion\Run"),
    ]
    try:
        for root, path in keys:
            try:
                with winreg.OpenKey(root, path) as key:
                    index = 0
                    while True:
                        try:
                            _name, value, _kind = winreg.EnumValue(key, index)
                        except OSError:
                            break
                        index += 1
                        if "ollama" in str(value).lower():
                            return "enabled"
            except OSError:
                continue
        # Ярлык в папке «Автозагрузка» — второй способ, которым пользуется установщик.
        startup = os.path.join(
            os.environ.get("APPDATA", ""),
            "Microsoft",
            "Windows",
            "Start Menu",
            "Programs",
            "Startup",
        )
        if startup and os.path.isdir(startup):
            for name in os.listdir(startup):
                if "ollama" in name.lower():
                    return "enabled"
        return "disabled"
    except OSError:
        return None


def _macos_autostart() -> str | None:
    """Состояние автозапуска Ollama в macOS (агенты launchd): enabled/disabled."""
    agents = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")
    try:
        names = os.listdir(agents)
    except OSError:
        return None
    return "enabled" if any("ollama" in name.lower() for name in names) else "disabled"


def autostart_state() -> str | None:
    """Состояние автозапуска Ollama: enabled/disabled или None, если неизвестно."""
    if IS_WINDOWS:
        return _windows_autostart()
    if IS_MACOS:
        return _macos_autostart()
    return None


# ----------------------------------------------------------------------
# состояние «службы»
# ----------------------------------------------------------------------
def unit_status() -> dict[str, Any]:
    """Состояние процесса Ollama в формате, который ждёт интерфейс панели."""
    target = process_name()
    found = processes()
    exact = [item for item in found if item["name"].strip().lower() == target.lower()]
    main_pid = (exact or found)[0]["pid"] if found else None
    memory = sum(item["memory_bytes"] or 0 for item in found) or None
    running = bool(found)

    return {
        "unit": target,
        "active_state": "active" if running else "inactive",
        "sub_state": "process" if running else "not-found",
        "unit_file_state": autostart_state() or "unknown",
        "running": running,
        "main_pid": main_pid,
        "n_restarts": None,
        "memory_bytes": memory,
        "memory_human": human_size(memory),
        "active_since": None,
        "started_at": None,
    }


# ----------------------------------------------------------------------
# файл журнала
# ----------------------------------------------------------------------
def _log_dirs() -> list[str]:
    """Каталоги, в которых ищем журнал Ollama (по убыванию вероятности)."""
    if config.OLLAMA_LOG_FILE:
        directory = os.path.dirname(os.path.abspath(config.OLLAMA_LOG_FILE))
        return [directory] if directory else []
    dirs: list[str] = []
    if IS_WINDOWS:
        local = os.environ.get("LOCALAPPDATA") or ""
        if local:
            dirs.append(os.path.join(local, "Ollama"))
    # ~/.ollama/logs — macOS и ручной запуск `ollama serve` на Linux.
    dirs.append(os.path.join(os.path.expanduser("~"), ".ollama", "logs"))
    if not IS_WINDOWS:
        dirs.append("/var/log/ollama")
    unique: list[str] = []
    for directory in dirs:
        if directory not in unique:
            unique.append(directory)
    return unique


def log_file_candidates() -> list[str]:
    """Возможные пути к журналу Ollama (по убыванию вероятности)."""
    if config.OLLAMA_LOG_FILE:
        return [config.OLLAMA_LOG_FILE]
    return [
        os.path.join(directory, name) for directory in _log_dirs() for name in LOG_FILE_NAMES
    ]


def _rotated_files() -> list[str]:
    """Ротированные журналы вида `server-1.log` (Ollama хранит и старые)."""
    found: list[str] = []
    for directory in _log_dirs():
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            low = name.lower()
            if low.startswith("server-") and low.endswith(".log"):
                found.append(os.path.join(directory, name))
    return found


def _mtime(path: str) -> float:
    """Время последнего изменения файла (0, если файл исчез)."""
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def log_file() -> str | None:
    """Путь к существующему журналу Ollama или None, если журнала нет."""
    for candidate in log_file_candidates():
        if os.path.isfile(candidate):
            return candidate
    rotated = _rotated_files()
    if rotated:
        return max(rotated, key=_mtime)
    return None


def _clamp_lines(lines: int | None) -> int:
    """Ограничивает количество строк журнала разумными рамками."""
    if lines is None:
        return config.JOURNAL_LINES_DEFAULT
    try:
        value = int(lines)
    except (TypeError, ValueError):
        return config.JOURNAL_LINES_DEFAULT
    return max(1, min(value, config.JOURNAL_LINES_MAX))


def _missing_log_error() -> LogfileError:
    """Ошибка «журнал не найден» с перечислением проверенных путей."""
    return LogfileError(
        "Журнал Ollama не найден. Искали: "
        + ", ".join(log_file_candidates())
        + ". Запустите Ollama или укажите путь переменной OLLAMA_LOG_FILE."
    )


def log_lines(lines: int | None = None) -> list[str]:
    """Последние строки журнала Ollama (снимок)."""
    path = log_file()
    if path is None:
        raise _missing_log_error()
    try:
        return logtail.tail_lines(path, _clamp_lines(lines))
    except OSError as exc:
        raise LogfileError(f"Не удалось прочитать журнал {path}: {exc}") from exc


def start_log_follow(lines: int | None = None) -> subprocess.Popen:
    """Запускает слежение за файлом журнала отдельным процессом."""
    path = log_file()
    if path is None:
        raise _missing_log_error()
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logtail.py")
    # -X utf8: дочерний процесс печатает в UTF-8 независимо от локали Windows.
    cmd = [sys.executable, "-X", "utf8", script, path, "-n", str(_clamp_lines(lines)), "-f"]
    try:
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,  # построчная буферизация: строки уходят в поток сразу
            creationflags=_NO_WINDOW,
        )
    except OSError as exc:
        raise LogfileError(f"Не удалось запустить чтение журнала: {exc}") from exc


# ----------------------------------------------------------------------
# подписи и подсказки для интерфейса
# ----------------------------------------------------------------------
def service_kind() -> str:
    """Как называть Ollama в интерфейсе: служба (systemd) или процесс."""
    return "процесс"


def service_title() -> str:
    """Заголовок вкладки «Служба»."""
    return "Процесс Ollama"


def service_hint() -> str:
    """Подсказка «как управлять Ollama» для текущей ОС."""
    if IS_WINDOWS:
        return (
            "Ollama на Windows запускается как приложение (значок в трее) — отдельной "
            "службы нет. Перезапуск: «Quit Ollama» в трее и снова запуск из меню «Пуск». "
            "Автозапуск включается в «Диспетчер задач → Автозагрузка». PID и память "
            "показаны для процесса ollama.exe."
        )
    if IS_MACOS:
        return (
            "Ollama на macOS запускается как приложение. Перезапуск: выход через меню "
            "значка Ollama и повторный запуск из «Программ». Автозапуск — в «Системные "
            "настройки → Основные → Элементы входа»."
        )
    return (
        "systemd в системе не найден, поэтому панель показывает состояние процесса ollama "
        "и журнал из файла. Запуск и остановка — командой ollama serve в терминале."
    )


def logs_title() -> str:
    """Заголовок вкладки «Логи»."""
    return "Журнал Ollama"


def logs_source() -> str:
    """Что читает панель во вкладке «Логи» (путь к файлу журнала)."""
    return log_file() or (config.OLLAMA_LOG_FILE or log_file_candidates()[0])


def logs_hint() -> str:
    """Подсказка про источник журнала и путь к нему."""
    if IS_WINDOWS:
        return (
            "Ollama на Windows пишет журнал в файл %LOCALAPPDATA%\\Ollama\\server.log "
            "(старые — server-N.log). Панель показывает последние строки и следит за "
            "новыми (аналог tail -f). Свой путь можно задать переменной OLLAMA_LOG_FILE."
        )
    if IS_MACOS:
        return (
            "Ollama на macOS пишет журнал в файл ~/.ollama/logs/server.log. Панель "
            "показывает последние строки и следит за новыми (аналог tail -f). Свой путь "
            "можно задать переменной OLLAMA_LOG_FILE."
        )
    return (
        "Журнал читается из файла и передаётся в браузер через Server-Sent Events, "
        "поэтому новые строки появляются сразу. Свой путь можно задать переменной "
        "OLLAMA_LOG_FILE."
    )


def logs_available() -> bool:
    """Есть ли файл журнала, который можно читать."""
    return log_file() is not None

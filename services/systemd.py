"""Бэкенд Linux/systemd: состояние юнита Ollama и его журнал.

Только чтение: панель не выполняет привилегированных команд и не требует
прав root. Запуск, остановка и перезапуск службы, а также правка её окружения
выполняются вручную в системе (`systemctl`, `systemctl edit`).

На Windows и macOS systemd нет — там используется бэкенд из
`services/ollama_logfile.py`; какой бэкенд активен, решает
`services/ollama_service.py`.
"""

from __future__ import annotations

import shutil
import subprocess
from typing import Any

import config
from utils import human_size, pretty_timestamp


class SystemdError(RuntimeError):
    """Ошибка при работе с systemd."""


def _run(
    cmd: list[str], *, input_text: str | None = None, timeout: int = 30
) -> subprocess.CompletedProcess:
    """Запускает команду и возвращает результат, не выбрасывая исключений."""
    try:
        return subprocess.run(
            cmd,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise SystemdError(f"Команда «{cmd[0]}» не найдена в системе") from exc
    except subprocess.TimeoutExpired as exc:
        raise SystemdError(
            f"Команда «{' '.join(cmd)}» не завершилась за {timeout} с"
        ) from exc


def systemctl_available() -> bool:
    """Есть ли в системе systemctl."""
    return shutil.which("systemctl") is not None


def journal_available() -> bool:
    """Есть ли в системе journalctl."""
    return shutil.which("journalctl") is not None


# ----------------------------------------------------------------------
# состояние юнита
# ----------------------------------------------------------------------
def unit_status() -> dict[str, Any]:
    """Возвращает состояние юнита Ollama."""
    if not systemctl_available():
        raise SystemdError("systemctl не найден: панель не может управлять службой")

    props = (
        "ActiveState",
        "SubState",
        "UnitFileState",
        "MainPID",
        "NRestarts",
        "MemoryCurrent",
        "ActiveEnterTimestamp",
        "ExecMainStartTimestamp",
    )
    proc = _run(
        ["systemctl", "show", config.OLLAMA_SERVICE, *[f"-p{name}" for name in props]],
        timeout=10,
    )
    if proc.returncode != 0:
        raise SystemdError(
            f"Не удалось получить состояние {config.OLLAMA_SERVICE}: "
            f"{(proc.stderr or proc.stdout).strip() or 'неизвестная ошибка'}"
        )

    data: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip()

    active_state = data.get("ActiveState") or "unknown"
    memory_raw = data.get("MemoryCurrent") or ""
    main_pid_raw = data.get("MainPID") or "0"
    restarts_raw = data.get("NRestarts") or "0"
    memory_bytes = int(memory_raw) if memory_raw.isdigit() else None

    return {
        "unit": config.OLLAMA_SERVICE,
        "active_state": active_state,
        "sub_state": data.get("SubState") or "unknown",
        "unit_file_state": data.get("UnitFileState") or "unknown",
        "running": active_state == "active",
        "main_pid": int(main_pid_raw) if main_pid_raw.isdigit() else None,
        "n_restarts": int(restarts_raw) if restarts_raw.isdigit() else 0,
        "memory_bytes": memory_bytes,
        "memory_human": human_size(memory_bytes),
        "active_since": pretty_timestamp(data.get("ActiveEnterTimestamp")),
        "started_at": pretty_timestamp(data.get("ExecMainStartTimestamp")),
    }


# ----------------------------------------------------------------------
# журнал службы
# ----------------------------------------------------------------------
def _journal_cmd(lines: int, *, follow: bool) -> list[str]:
    """Собирает команду journalctl для юнита Ollama."""
    cmd = [
        "journalctl",
        "-u",
        config.OLLAMA_SERVICE,
        "--no-pager",
        "-o",
        "short-iso",
        "-n",
        str(lines),
    ]
    if follow:
        cmd.append("-f")
    return cmd


def log_lines(lines: int | None = None) -> list[str]:
    """Возвращает последние строки журнала службы (снимок)."""
    if not journal_available():
        raise SystemdError("journalctl не найден: журнал недоступен")
    count = _clamp_lines(lines)
    proc = _run(_journal_cmd(count, follow=False), timeout=20)
    output = proc.stdout or ""
    if proc.returncode != 0 and not output.strip():
        raise SystemdError(
            "Не удалось прочитать журнал: "
            f"{(proc.stderr or '').strip() or 'неизвестная ошибка'}. "
            "Добавьте пользователя в группу adm или systemd-journal."
        )
    return output.splitlines()


def start_log_follow(lines: int | None = None) -> subprocess.Popen:
    """Запускает `journalctl -f` и возвращает процесс для чтения потока."""
    if not journal_available():
        raise SystemdError("journalctl не найден: журнал недоступен")
    count = _clamp_lines(lines)
    try:
        return subprocess.Popen(
            _journal_cmd(count, follow=True),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,  # построчная буферизация
        )
    except OSError as exc:
        raise SystemdError(f"Не удалось запустить journalctl: {exc}") from exc


def _clamp_lines(lines: int | None) -> int:
    """Ограничивает количество строк журнала разумными рамками."""
    if lines is None:
        return config.JOURNAL_LINES_DEFAULT
    try:
        value = int(lines)
    except (TypeError, ValueError):
        return config.JOURNAL_LINES_DEFAULT
    return max(1, min(value, config.JOURNAL_LINES_MAX))


# ----------------------------------------------------------------------
# подписи и подсказки для интерфейса
# ----------------------------------------------------------------------
def service_kind() -> str:
    """Как называть Ollama в интерфейсе: служба (systemd) или процесс."""
    return "служба"


def service_title() -> str:
    """Заголовок вкладки «Служба»."""
    return "Служба"


def service_name() -> str:
    """Имя юнита systemd, состояние которого читает панель."""
    return config.OLLAMA_SERVICE


def service_hint() -> str:
    """Подсказка «как управлять службой» (панель этого не делает)."""
    return (
        "Панель не выполняет привилегированных команд и не требует прав root. "
        "Запуск, остановка и перезапуск выполняются вручную в терминале: "
        f"sudo systemctl restart {config.OLLAMA_SERVICE}."
    )


def logs_title() -> str:
    """Заголовок вкладки «Логи»."""
    return "Журнал службы"


def logs_source() -> str:
    """Что читает панель во вкладке «Логи» (команда journalctl)."""
    return f"journalctl -f -u {config.OLLAMA_SERVICE}"


def logs_hint() -> str:
    """Подсказка про источник журнала."""
    return (
        f"Поток читается из journalctl -f -u {config.OLLAMA_SERVICE} и передаётся "
        "в браузер через Server-Sent Events, поэтому новые строки появляются сразу."
    )


def logs_available() -> bool:
    """Доступен ли журнал systemd в этой системе."""
    return journal_available()


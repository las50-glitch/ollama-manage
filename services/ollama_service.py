"""Единая точка доступа к «службе Ollama» на разных ОС.

Панель работает одинаково на Linux, Windows и macOS, но источник данных о
состоянии Ollama там разный:

* **Linux с systemd** — состояние юнита и журнал через `systemctl`/`journalctl`
  (`services/systemd.py`);
* **Windows, macOS и Linux без systemd** — состояние процесса Ollama и журнал
  из файла (`services/ollama_logfile.py`).

Бэкенд выбирается один раз при старте панели:

* если задана переменная `OLLAMA_LOG_FILE`, используется файл журнала — так
  читается журнал Ollama, запущенной вручную (без systemd);
* иначе, если в системе есть `systemctl` или `journalctl` — systemd;
* в остальных случаях — файл журнала.

Остальной код работает через функции этого модуля и не знает, какой бэкенд
активен. Ошибки бэкендов приводятся к общему типу `ServiceError`.
"""

from __future__ import annotations

import platform
import subprocess
from typing import Any, Callable, Iterator

import config
from services import ollama_logfile, systemd


class ServiceError(RuntimeError):
    """Ошибка при чтении состояния Ollama или её журнала."""


def _detect_backend() -> str:
    """Определяет активный бэкенд: systemd или файл журнала."""
    if config.OLLAMA_LOG_FILE:
        return "logfile"
    if systemd.systemctl_available() or systemd.journal_available():
        return "systemd"
    return "logfile"


# Активный бэкенд: "systemd" или "logfile".
BACKEND = _detect_backend()

BACKEND_LABELS = {"systemd": "systemd", "logfile": "файл журнала"}
PLATFORM_LABELS = {"linux": "Linux", "windows": "Windows", "darwin": "macOS"}


# ----------------------------------------------------------------------
# бэкенд и платформа
# ----------------------------------------------------------------------
def backend() -> str:
    """Имя активного бэкенда: systemd или logfile."""
    return BACKEND


def backend_label() -> str:
    """Человекочитаемое имя бэкенда (для подсказок в интерфейсе)."""
    return BACKEND_LABELS[BACKEND]


def platform_name() -> str:
    """Имя ОС в нижнем регистре: linux, windows, darwin."""
    return platform.system().lower()


def platform_label() -> str:
    """Название ОС для интерфейса."""
    return PLATFORM_LABELS.get(platform_name()) or platform.system() or "неизвестная ОС"


def _module():
    """Модуль активного бэкенда."""
    return systemd if BACKEND == "systemd" else ollama_logfile


def _call(func: Callable[..., Any], *args: Any) -> Any:
    """Вызывает функцию бэкенда, приводя его ошибки к общему ServiceError."""
    try:
        return func(*args)
    except (systemd.SystemdError, ollama_logfile.LogfileError) as exc:
        raise ServiceError(str(exc)) from exc


# ----------------------------------------------------------------------
# состояние Ollama и её журнал
# ----------------------------------------------------------------------
def unit_status() -> dict[str, Any]:
    """Состояние Ollama: юнит systemd (Linux) или процесс (Windows/macOS)."""
    return _call(_module().unit_status)


def log_lines(lines: int | None = None) -> list[str]:
    """Последние строки журнала Ollama (снимок)."""
    return _call(_module().log_lines, lines)


def start_log_follow(lines: int | None = None) -> subprocess.Popen:
    """Запускает слежение за журналом (`journalctl -f` или «хвост» файла)."""
    return _call(_module().start_log_follow, lines)


def logs_available() -> bool:
    """Доступен ли журнал Ollama в этой системе (есть journalctl или файл)."""
    return _call(_module().logs_available)


def iter_process_lines(process: subprocess.Popen) -> Iterator[str]:
    """Отдаёт строки вывода процесса и гарантированно останавливает его."""
    try:
        if process.stdout is None:
            return
        for line in process.stdout:
            yield line.rstrip("\n")
    finally:
        stop_process(process)


def stop_process(process: subprocess.Popen) -> None:
    """Аккуратно завершает дочерний процесс (journalctl или «хвост» журнала)."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


# ----------------------------------------------------------------------
# подписи и подсказки для интерфейса
# ----------------------------------------------------------------------
def service_kind() -> str:
    """Как называть Ollama в интерфейсе: служба (systemd) или процесс."""
    return _module().service_kind()


def service_title() -> str:
    """Заголовок вкладки «Служба»."""
    return _module().service_title()


def service_name() -> str:
    """Имя юнита systemd или имя процесса Ollama."""
    if BACKEND == "systemd":
        return systemd.service_name()
    return ollama_logfile.process_name()


def service_hint() -> str:
    """Подсказка «как управлять Ollama» для текущей ОС."""
    return _module().service_hint()


def logs_title() -> str:
    """Заголовок вкладки «Логи»."""
    return _module().logs_title()


def logs_source() -> str:
    """Что читает панель во вкладке «Логи»."""
    return _module().logs_source()


def logs_hint() -> str:
    """Подсказка про источник журнала."""
    return _module().logs_hint()

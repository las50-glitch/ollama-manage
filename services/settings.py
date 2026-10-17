"""Настройки панели, которые сохраняются на диск.

Сейчас здесь хранится токен Hugging Face: он нужен панели, чтобы искать и
показывать кванты закрытых (gated) репозиториев. Значение из переменной
окружения `HF_TOKEN` считается значением по умолчанию, а сохранённое из
интерфейса панели — перекрывает его.

Файл настроек (`data/settings.json`) создаётся с правами 600: токен не должен
быть доступен другим пользователям системы. Запись идёт через временный файл
с последующим `os.replace`, поэтому панель никогда не оставит обрезанный JSON.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import config

log = logging.getLogger("ollama-panel.settings")

# Токен Hugging Face: латинские буквы, цифры и «_-.» (например hf_XXXXXXXX…).
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-.]{8,200}$")

# Ключ, в котором хранится токен Hugging Face.
HF_TOKEN_KEY = "hf_token"


def settings_path() -> str:
    """Путь к файлу настроек панели."""
    return config.SETTINGS_FILE


def load() -> dict[str, Any]:
    """Читает файл настроек; при любой проблеме возвращает пустой словарь."""
    try:
        with open(settings_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        log.warning("Не удалось прочитать настройки (%s): %s", settings_path(), exc)
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict[str, Any]) -> None:
    """Атомарно сохраняет настройки с правами 600."""
    path = settings_path()
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def save(patch: dict[str, Any]) -> dict[str, Any]:
    """Дописывает значения в файл настроек и возвращает результат."""
    data = load()
    data.update(patch)
    _write(data)
    return data


def clean_token(raw: Any) -> str:
    """Проверяет формат токена Hugging Face (пустая строка = удалить токен)."""
    token = str(raw or "").strip()
    if not token:
        return ""
    if not _TOKEN_RE.match(token):
        raise ValueError(
            "Токен Hugging Face должен состоять из латинских букв, цифр и «_-.» "
            "(минимум 8 символов), например hf_AbCdEf…"
        )
    return token


def set_hf_token(raw: Any) -> str:
    """Сохраняет (или удаляет) токен Hugging Face и возвращает его значение."""
    token = clean_token(raw)
    data = load()
    if token:
        data[HF_TOKEN_KEY] = token
    else:
        data.pop(HF_TOKEN_KEY, None)
    _write(data)
    return token


def hf_token() -> tuple[str, str | None]:
    """Возвращает пару (токен, источник): источник — «panel», «env» или None."""
    stored = load().get(HF_TOKEN_KEY)
    if isinstance(stored, str) and stored.strip():
        return stored.strip(), "panel"
    if config.HF_TOKEN:
        return config.HF_TOKEN, "env"
    return "", None


def token_hint(token: str) -> str:
    """Короткая подсказка о токене, которую безопасно показывать в интерфейсе."""
    if not token:
        return ""
    if len(token) <= 10:
        return f"{token[:3]}…"
    return f"{token[:6]}…{token[-4:]}"

"""Поиск GGUF-моделей на Hugging Face и разбор доступных квантов.

Используется публичный REST API https://huggingface.co/api — запросы идут с
сервера панели, поэтому в браузере не бывает CORS-проблем и токен не попадает
в клиентский код.

Репозитории с флагом `gated` (и приватные) требуют токен. Панель берёт его из
настроек (`data/settings.json`, задаётся в интерфейсе на вкладке Hugging Face)
или из переменной окружения `HF_TOKEN`. Тот же токен нужно прописать в
окружение службы Ollama, чтобы `ollama pull hf.co/…` мог скачать такой
репозиторий — панель умеет делать это за вас (см. `services/systemd.py`).
"""

from __future__ import annotations

import re
from typing import Any

import requests

import config
from services import settings
from utils import human_size

# Кванты в именах файлов: Q4_K_M, Q8_0, IQ4_XS, BF16, F16, F32.
_QUANT_RE = re.compile(
    r"(?i)(IQ\d+_[A-Z0-9_]+|Q\d+_K_[A-Z]+|Q\d+_K|Q\d+_\d+|Q\d+|BF16|FP16|F16|F32)"
)

# Разбитые на части GGUF: `...-00001-of-00003.gguf`.
_SPLIT_RE = re.compile(r"-\d{5}-of-\d{5}$")

_REPO_RE = re.compile(r"^[\w.\-]+/[\w.\-]+$")

# Поддерживаемые варианты сортировки выдачи.
SORT_OPTIONS = {
    "downloads": "downloads",
    "likes": "likes",
    "trending": "trendingScore",
    "updated": "lastModified",
}


class HuggingFaceError(RuntimeError):
    """Ошибка при обращении к API Hugging Face."""


class HuggingFaceRequestError(HuggingFaceError):
    """Некорректный запрос пользователя (пустой или неверный параметр)."""


class HuggingFaceNotFound(HuggingFaceError):
    """Репозиторий не найден на Hugging Face."""


def _auth_headers(token: str | None) -> dict[str, str]:
    """Заголовки авторизации Hugging Face (пустой токен — анонимный доступ)."""
    return {"Authorization": f"Bearer {token}"} if token else {}


def _get(
    path: str, params: dict[str, Any] | None = None, *, token: str | None = None
) -> Any:
    """Выполняет GET-запрос к API Hugging Face.

    Если токен не передан явно, берётся сохранённый в панели (или из окружения
    `HF_TOKEN`) — с ним видны закрытые (gated) и приватные репозитории.
    """
    url = f"{config.HF_API_BASE.rstrip('/')}{path}"
    if token is None:
        token = settings.hf_token()[0]
    try:
        response = requests.get(
            url, params=params, headers=_auth_headers(token), timeout=config.HF_TIMEOUT
        )
    except requests.exceptions.ConnectionError as exc:
        raise HuggingFaceError(
            "Нет соединения с huggingface.co — проверьте доступ в интернет"
        ) from exc
    except requests.exceptions.Timeout as exc:
        raise HuggingFaceError("Превышено время ожидания ответа Hugging Face") from exc
    except requests.exceptions.RequestException as exc:
        raise HuggingFaceError(f"Ошибка запроса к Hugging Face: {exc}") from exc

    if response.status_code == 404:
        raise HuggingFaceNotFound("Репозиторий не найден на Hugging Face")
    if response.status_code in (401, 403):
        hint = (
            "Токен Hugging Face задан, но не подошёл — возможно, он истёк или у "
            "него нет доступа к репозиторию."
            if token
            else "Токен Hugging Face не задан: вкладка «Поиск на Hugging Face» → "
            "блок «Токен Hugging Face»."
        )
        raise HuggingFaceNotFound(
            f"Hugging Face отклонил запрос (HTTP {response.status_code}): "
            f"репозиторий не найден, закрыт (gated) или приватный. {hint}"
        )
    if response.status_code >= 400:
        raise HuggingFaceError(f"Hugging Face вернул HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise HuggingFaceError("Hugging Face вернул некорректный JSON") from exc


def verify_token(token: str) -> dict[str, Any]:
    """Проверяет токен запросом `/whoami-v2` и не выбрасывает исключений.

    Возвращает словарь с полями `ok`, `user`, `type`, `message`: интерфейсу
    нужно показать результат проверки, а не падать с ошибкой.
    """
    if not token:
        return {"ok": False, "user": None, "type": None, "message": "Токен не задан"}
    try:
        data = _get("/whoami-v2", token=token)
    except HuggingFaceNotFound as exc:
        return {
            "ok": False,
            "user": None,
            "type": None,
            "message": f"Токен не принят Hugging Face ({exc})",
        }
    except HuggingFaceError as exc:
        return {"ok": False, "user": None, "type": None, "message": str(exc)}

    if not isinstance(data, dict):
        return {"ok": False, "user": None, "type": None, "message": "Неожиданный ответ"}
    user = data.get("name") or data.get("fullname") or data.get("email")
    return {
        "ok": True,
        "user": user,
        "type": data.get("type"),
        "message": f"Токен принят: {user}" if user else "Токен принят",
    }


def token_state() -> dict[str, Any]:
    """Состояние токена Hugging Face для интерфейса (сам токен не отдаётся)."""
    token, source = settings.hf_token()
    return {
        "set": bool(token),
        "source": source,                    # "panel" | "env" | None
        "hint": settings.token_hint(token),
        "env_set": bool(config.HF_TOKEN),
        "file": settings.settings_path(),
    }


def clean_query(query: str | None) -> str:
    """Нормализует поисковый запрос."""
    text = " ".join((query or "").split())
    if not text:
        raise HuggingFaceRequestError("Введите поисковый запрос")
    if len(text) > 120:
        raise HuggingFaceRequestError("Слишком длинный поисковый запрос")
    return text


def clean_repo(repo: str | None) -> str:
    """Приводит ссылку на репозиторий к виду `user/name`."""
    text = (repo or "").strip()
    for prefix in ("https://huggingface.co/", "http://huggingface.co/", "hf.co/", "huggingface.co/"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
            break
    text = text.split("?", 1)[0].split("#", 1)[0].strip("/")
    if ":" in text:  # отбрасываем возможный тег кванта
        text = text.split(":", 1)[0]
    if not _REPO_RE.match(text):
        raise HuggingFaceRequestError("Укажите репозиторий в формате «пользователь/имя»")
    return text


def clamp_limit(limit: Any) -> int:
    """Ограничивает количество результатов поиска."""
    try:
        value = int(limit)
    except (TypeError, ValueError):
        value = config.HF_SEARCH_LIMIT_DEFAULT
    return max(1, min(value, config.HF_SEARCH_LIMIT_MAX))


def detect_quant(filename: str) -> str | None:
    """Извлекает имя кванта из имени файла GGUF."""
    stem = filename.rsplit("/", 1)[-1]
    if stem.lower().endswith(".gguf"):
        stem = stem[:-5]
    match = _QUANT_RE.search(stem)
    if not match:
        return None
    quant = match.group(1).upper()
    return "F16" if quant == "FP16" else quant


def _normalize_model(item: dict[str, Any]) -> dict[str, Any]:
    """Приводит карточку модели из поиска HF к виду, удобному интерфейсу."""
    repo = str(item.get("id") or item.get("modelId") or "")
    author, _, name = repo.partition("/")
    tags = [tag for tag in (item.get("tags") or []) if tag != "gguf"]
    return {
        "repo": repo,
        "author": author,
        "name": name or repo,
        "downloads": int(item.get("downloads") or 0),
        "likes": int(item.get("likes") or 0),
        "modified_at": item.get("lastModified"),
        "gated": bool(item.get("gated")),
        "tags": tags[:8],
        "pull_name": f"hf.co/{repo}",
        "page_url": f"https://huggingface.co/{repo}",
    }


def search(
    query: str, *, limit: Any = None, sort: str = "downloads"
) -> list[dict[str, Any]]:
    """Ищет GGUF-модели на Hugging Face.

    Возвращает список словарей с готовым именем для `ollama pull` в поле
    `pull_name` (`hf.co/<repo>`); конкретный квант выбирается отдельно.
    """
    text = clean_query(query)
    params = {
        "search": text,
        "filter": "gguf",
        "sort": SORT_OPTIONS.get(sort, SORT_OPTIONS["downloads"]),
        "direction": -1,
        "limit": clamp_limit(limit),
        "full": "false",
    }
    data = _get("/models", params)
    if not isinstance(data, list):
        raise HuggingFaceError("Неожиданный формат ответа Hugging Face")
    return [_normalize_model(item) for item in data if isinstance(item, dict)]


def quants(repo: str) -> dict[str, Any]:
    """Возвращает список GGUF-файлов (квантов) в репозитории.

    Для каждого файла формируется готовое имя для Ollama:
    `hf.co/<repo>:<QUANT>`. Разбитые на части файлы
    (`...-00001-of-00003.gguf`) объединяются в одну запись: суммируется
    размер, количество частей попадает в поле `parts`.
    """
    repo_id = clean_repo(repo)
    data = _get(f"/models/{repo_id}", {"blobs": "true"})
    if not isinstance(data, dict):
        raise HuggingFaceError("Неожиданный формат ответа Hugging Face")

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for item in data.get("siblings") or []:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("rfilename") or "")
        if not filename.lower().endswith(".gguf"):
            continue
        quant = detect_quant(filename)
        if not quant:
            continue
        stem = filename[:-5]
        base = _SPLIT_RE.sub("", stem)
        size = item.get("size")
        size = size if isinstance(size, int) else 0

        entry = grouped.get((quant, base))
        if entry is None:
            entry = {
                "file": filename,
                "base": base,
                "quant": quant,
                "size": size,
                "parts": 1,
                "split": base != stem,
                "pull_name": f"hf.co/{repo_id}:{quant}",
            }
            grouped[(quant, base)] = entry
        else:
            entry["size"] += size
            entry["parts"] += 1

    files = []
    for entry in grouped.values():
        entry["size_human"] = human_size(entry["size"]) if entry["size"] else "—"
        files.append(entry)

    files.sort(key=lambda item: (item["quant"], item["base"]))
    return {
        "repo": repo_id,
        "gated": bool(data.get("gated")),
        "pull_name": f"hf.co/{repo_id}",
        "files": files,
        "count": len(files),
    }

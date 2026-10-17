"""Обёртка над REST API Ollama.

Описание API: https://github.com/ollama/ollama/blob/main/docs/api.md
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Iterator

import requests

import config
from utils import human_size

# keep_alive: секунды числом ("300", "-1", "0") или длительность ("5m", "1h").
_KEEP_ALIVE_RE = re.compile(r"^-?\d+(\.\d+)?(ms|us|ns|s|m|h)?$")


class OllamaError(RuntimeError):
    """Ошибка при обращении к API Ollama."""


class OllamaClient:
    """Клиент локального HTTP API Ollama."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or config.OLLAMA_HOST).rstrip("/")

    # ------------------------------------------------------------------
    # низкоуровневые помощники
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        stream: bool = False,
        timeout: int | None = None,
    ) -> requests.Response:
        """Выполняет HTTP-запрос к Ollama, превращая сетевые сбои в OllamaError."""
        url = f"{self.base_url}{path}"
        try:
            return requests.request(
                method,
                url,
                json=json_body,
                stream=stream,
                timeout=timeout or config.HTTP_TIMEOUT,
            )
        except requests.exceptions.ConnectionError as exc:
            raise OllamaError(
                f"Служба Ollama недоступна по адресу {self.base_url}. "
                f"Проверьте, запущена ли она (вкладка «Служба»)."
            ) from exc
        except requests.exceptions.Timeout as exc:
            raise OllamaError(
                f"Превышено время ожидания ответа от {self.base_url}"
            ) from exc
        except requests.exceptions.RequestException as exc:
            raise OllamaError(f"Ошибка запроса к Ollama: {exc}") from exc

    @staticmethod
    def _error_text(response: requests.Response) -> str:
        """Извлекает текст ошибки из ответа Ollama."""
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and payload.get("error"):
            return str(payload["error"])
        text = (response.text or "").strip()
        if text:
            return f"Ollama вернула HTTP {response.status_code}: {text[:500]}"
        return f"Ollama вернула HTTP {response.status_code}"

    def _json(self, response: requests.Response) -> dict[str, Any]:
        """Проверяет статус ответа и возвращает его JSON-тело."""
        if response.status_code >= 400:
            raise OllamaError(self._error_text(response))
        try:
            return response.json()
        except ValueError as exc:
            raise OllamaError("Ollama вернула некорректный JSON") from exc

    @staticmethod
    def _clean_name(name: str | None) -> str:
        """Проверяет и нормализует имя модели."""
        model = (name or "").strip()
        if not model:
            raise OllamaError("Не указано имя модели")
        if len(model) > 512:
            raise OllamaError("Слишком длинное имя модели")
        return model

    # ------------------------------------------------------------------
    # публичные методы
    # ------------------------------------------------------------------
    def version(self) -> str:
        """Возвращает версию сервера Ollama."""
        data = self._json(self._request("GET", "/api/version"))
        return str(data.get("version", "неизвестно"))

    def list_models(self) -> list[dict[str, Any]]:
        """Список установленных моделей, отсортированный по имени."""
        data = self._json(self._request("GET", "/api/tags"))
        models = []
        for item in data.get("models") or []:
            details = item.get("details") or {}
            size = item.get("size") or 0
            models.append(
                {
                    "name": item.get("name") or item.get("model") or "—",
                    "size": size,
                    "size_human": human_size(size),
                    "modified_at": item.get("modified_at"),
                    "digest": item.get("digest"),
                    "family": details.get("family"),
                    "parameter_size": details.get("parameter_size"),
                    "quantization_level": details.get("quantization_level"),
                    "format": details.get("format"),
                }
            )
        models.sort(key=lambda m: m["name"].lower())
        return models

    def list_running(self) -> list[dict[str, Any]]:
        """Список моделей, загруженных в память (аналог `ollama ps`)."""
        data = self._json(self._request("GET", "/api/ps"))
        running = []
        for item in data.get("models") or []:
            size = item.get("size") or 0
            size_vram = item.get("size_vram") or 0
            details = item.get("details") or {}
            running.append(
                {
                    "name": item.get("name") or item.get("model") or "—",
                    "size": size,
                    "size_human": human_size(size),
                    "size_vram": size_vram,
                    "size_vram_human": human_size(size_vram),
                    "vram_percent": round(size_vram / size * 100, 1) if size else 0.0,
                    "expires_at": item.get("expires_at"),
                    "parameter_size": details.get("parameter_size"),
                    "quantization_level": details.get("quantization_level"),
                }
            )
        running.sort(key=lambda m: m["name"].lower())
        return running

    def show(self, name: str) -> dict[str, Any]:
        """Подробная информация о модели (`ollama show`)."""
        model = self._clean_name(name)
        return self._json(self._request("POST", "/api/show", json_body={"model": model}))

    def pull(self, name: str, *, insecure: bool = False) -> Iterator[dict[str, Any]]:
        """Скачивает модель, отдавая поток событий прогресса.

        Ollama возвращает поток JSON-объектов по одному на строку, например:
        {"status": "pulling manifest"}
        {"status": "downloading", "completed": 123, "total": 456, "digest": "..."}
        """
        model = self._clean_name(name)
        body: dict[str, Any] = {"model": model, "stream": True}
        if insecure:
            body["insecure"] = True

        response = self._request(
            "POST", "/api/pull", json_body=body, stream=True, timeout=config.PULL_TIMEOUT
        )
        if response.status_code >= 400:
            raise OllamaError(self._error_text(response))

        with response:
            for line in response.iter_lines(decode_unicode=True):
                if not line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    if "total" in event:
                        event["total_human"] = human_size(event.get("total"))
                        event["completed_human"] = human_size(event.get("completed"))
                    yield event

    def delete(self, name: str) -> None:
        """Удаляет установленную модель."""
        model = self._clean_name(name)
        response = self._request("DELETE", "/api/delete", json_body={"model": model})
        if response.status_code == 405:  # старые сборки Ollama принимают только POST
            response = self._request("POST", "/api/delete", json_body={"model": model})
        if response.status_code >= 400:
            raise OllamaError(self._error_text(response))

    def unload(self, name: str) -> None:
        """Выгружает модель из памяти (keep_alive = 0)."""
        model = self._clean_name(name)
        self._json(
            self._request(
                "POST", "/api/generate", json_body={"model": model, "keep_alive": 0}
            )
        )

    def load(self, name: str, keep_alive: str | int | None = None) -> dict[str, Any]:
        """Загружает модель в память, не выполняя генерацию.

        Так же поступает `ollama run`: пустой запрос к /api/generate заставляет
        Ollama прочитать веса и держать их в памяти `keep_alive`. На пустой
        промпт Ollama отвечает `{"done": true, "done_reason": "load"}` без
        статистики, поэтому время загрузки измеряем сами.
        """
        model = self._clean_name(name)
        keep = clean_keep_alive(keep_alive, config.PRELOAD_KEEP_ALIVE)
        body: dict[str, Any] = {
            "model": model,
            "prompt": "",
            "stream": False,
            "keep_alive": keep,
        }
        started = time.perf_counter()
        data = self._json(
            self._request(
                "POST", "/api/generate", json_body=body, timeout=config.LOAD_TIMEOUT
            )
        )
        elapsed = round(time.perf_counter() - started, 2)
        return {
            "name": model,
            "keep_alive": keep,
            "load_seconds": elapsed,
            "done_reason": data.get("done_reason"),
        }

    def chat_stream(
        self,
        name: str,
        messages: list[dict[str, Any]],
        *,
        options: dict[str, Any] | None = None,
        keep_alive: str | int | None = None,
        think: bool | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Отдаёт поток событий чата (`/api/chat` со stream=True).

        Каждое событие — словарь Ollama, например:
        {"message": {"role": "assistant", "content": "привет"}, "done": false}
        {"done": true, "eval_count": 42, "eval_duration": 1234567890}

        `think=False` отключает «размышления» у моделей, которые их умеют
        (qwen3, deepseek-r1 и подобные); `None` — не передавать параметр и
        оставить решение модели (поведение по умолчанию в Ollama).
        """
        model = self._clean_name(name)
        keep = clean_keep_alive(keep_alive, config.CHAT_KEEP_ALIVE)
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "keep_alive": keep,
        }
        if options:
            body["options"] = options
        if think is not None:
            body["think"] = think

        response = self._request(
            "POST",
            "/api/chat",
            json_body=body,
            stream=True,
            timeout=config.CHAT_TIMEOUT,
        )
        if response.status_code >= 400:
            raise OllamaError(self._error_text(response))

        with response:
            for line in response.iter_lines(decode_unicode=True):
                if not line or not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    yield event


def clean_keep_alive(value: str | int | None, default: str) -> str:
    """Проверяет keep_alive из интерфейса (число секунд или строка «5m»)."""
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    if not _KEEP_ALIVE_RE.match(text):
        raise OllamaError(
            f"Некорректное значение keep_alive «{text}» (примеры: 5m, 1h, 300, 0)"
        )
    return text


def default_client() -> OllamaClient:
    """Создаёт клиент с настройками из config.py."""
    return OllamaClient()

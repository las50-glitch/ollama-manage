"""Flask-панель управления локально установленной Ollama.

Возможности:
  * список установленных моделей, скачивание и удаление моделей;
  * поиск GGUF-моделей на Hugging Face и скачивание выбранного кванта;
  * токен Hugging Face: задаётся прямо в панели (для поиска и скачивания
    закрытых репозиториев);
  * `ollama ps` — модели в памяти, с выгрузкой и предзагрузкой («В память»);
  * чат с моделью в модальном окне в стиле `ollama run` (поток токенов,
    «размышления» сворачиваются, их можно отключить параметром think);
  * журнал Ollama в реальном времени (Server-Sent Events) и состояние Ollama —
    только чтение, без root и sudo.

Панель работает на Linux, Windows и macOS. Источник состояния и журнала
выбирается автоматически (см. `services/ollama_service.py`): на Linux с systemd
это `systemctl show` и `journalctl`, на Windows и macOS — процесс Ollama и файл
журнала (`%LOCALAPPDATA%\\Ollama\\server.log`, `~/.ollama/logs/server.log`).

Запуск: ./run.sh (Linux/macOS) или run.bat (Windows); вручную —
`./venv/bin/python app.py` / `venv\\Scripts\\python.exe app.py`.
"""

from __future__ import annotations

import getpass
import json
import logging
from typing import Any, Iterator

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    stream_with_context,
    url_for,
)

import config
from services import huggingface, ollama_api, ollama_service, settings
from utils import human_size

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ollama-panel")

app = Flask(__name__)
app.json.ensure_ascii = False  # отдавать JSON с русским текстом как есть
app.json.sort_keys = False
# Шаблон перечитывается с диска при каждом запросе: правка templates/index.html
# видна после обычного обновления страницы, без перезапуска панели (иначе Jinja
# держит скомпилированный шаблон в памяти и отдаёт старую разметку).
app.config["TEMPLATES_AUTO_RELOAD"] = True
# Статика отдаётся с обязательной проверкой по ETag (ответ 304, если не менялась):
# браузер не показывает старые style.css/chat.css/*.js после правки.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

client = ollama_api.default_client()


# ----------------------------------------------------------------------
# вспомогательные функции
# ----------------------------------------------------------------------
def sse_event(payload: dict[str, Any]) -> str:
    """Форматирует словарь как одно событие Server-Sent Events."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_response(generator: Iterator[str]) -> Response:
    """Оборачивает генератор в потоковый SSE-ответ."""
    return Response(
        stream_with_context(generator),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def json_payload() -> dict[str, Any]:
    """Возвращает JSON-тело запроса или пустой словарь."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def requested_lines(default: int | None = None) -> int:
    """Читает параметр `lines` из query string."""
    raw = request.args.get("lines")
    if raw is None:
        return default if default is not None else config.JOURNAL_LINES_DEFAULT
    try:
        return int(raw)
    except ValueError:
        return default if default is not None else config.JOURNAL_LINES_DEFAULT


def chat_options(raw: Any) -> dict[str, Any]:
    """Проверяет параметры генерации, пришедшие из интерфейса чата."""
    if not isinstance(raw, dict):
        return {}
    options: dict[str, Any] = {}
    floats = {
        "temperature": (0.0, config.CHAT_TEMPERATURE_MAX),
        "top_p": (0.0, 1.0),
        "repeat_penalty": (0.0, 4.0),
    }
    integers = {
        "num_ctx": (config.CHAT_NUM_CTX_MIN, config.CHAT_NUM_CTX_MAX),
        "num_predict": (-1, config.CHAT_NUM_PREDICT_MAX),
    }
    for key, (low, high) in floats.items():
        value = raw.get(key)
        if value is None or value == "":
            continue
        try:
            parsed = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Параметр «{key}» должен быть числом") from exc
        if not low <= parsed <= high:
            raise ValueError(f"Параметр «{key}» должен быть в диапазоне {low}…{high}")
        options[key] = parsed
    for key, (low, high) in integers.items():
        value = raw.get(key)
        if value is None or value == "":
            continue
        try:
            parsed = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Параметр «{key}» должен быть целым числом") from exc
        if not low <= parsed <= high:
            raise ValueError(f"Параметр «{key}» должен быть в диапазоне {low}…{high}")
        options[key] = parsed
    return options


def chat_think(raw: Any) -> bool | None:
    """Проверяет параметр «размышления» (think) из интерфейса чата.

    True/False — явно включить или выключить размышления, None — не передавать
    параметр вовсе (Ollama решает сама, как для выбранной модели).
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        text = raw.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
        if text in {"auto", "default", "none"}:
            return None
    raise ValueError("Параметр «think» должен быть true, false или не задан")


def chat_messages(raw: Any) -> list[dict[str, str]]:
    """Проверяет историю сообщений чата перед отправкой в Ollama."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("Пустая история сообщений")
    if len(raw) > config.CHAT_HISTORY_MAX:
        raise ValueError(
            f"Слишком длинная история: максимум {config.CHAT_HISTORY_MAX} сообщений"
        )
    messages: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = item.get("content")
        if role not in {"system", "user", "assistant"} or not isinstance(content, str):
            continue
        if not content.strip():
            continue
        if len(content) > config.CHAT_MESSAGE_MAX_CHARS:
            raise ValueError("Сообщение слишком длинное")
        messages.append({"role": role, "content": content})
    if not messages:
        raise ValueError("В истории нет корректных сообщений")
    return messages


def chat_stats(event: dict[str, Any]) -> dict[str, Any]:
    """Считает статистику генерации из финального события `/api/chat`."""
    eval_count = int(event.get("eval_count") or 0)
    eval_ns = int(event.get("eval_duration") or 0)
    prompt_count = int(event.get("prompt_eval_count") or 0)
    prompt_ns = int(event.get("prompt_eval_duration") or 0)
    return {
        "eval_count": eval_count,
        "prompt_eval_count": prompt_count,
        "eval_seconds": round(eval_ns / 1e9, 2),
        "total_seconds": round(int(event.get("total_duration") or 0) / 1e9, 2),
        "load_seconds": round(int(event.get("load_duration") or 0) / 1e9, 2),
        "tokens_per_second": round(eval_count / (eval_ns / 1e9), 1) if eval_ns else 0.0,
        "prompt_tokens_per_second": (
            round(prompt_count / (prompt_ns / 1e9), 1) if prompt_ns else 0.0
        ),
        "done_reason": event.get("done_reason"),
    }


# ----------------------------------------------------------------------
# обработчики ошибок -> всегда JSON
# ----------------------------------------------------------------------
@app.errorhandler(ollama_api.OllamaError)
def handle_ollama_error(exc: ollama_api.OllamaError):
    log.warning("Ошибка Ollama API: %s", exc)
    return jsonify({"error": str(exc)}), 502


@app.errorhandler(ollama_service.ServiceError)
def handle_service_error(exc: ollama_service.ServiceError):
    log.warning("Ошибка чтения состояния Ollama или её журнала: %s", exc)
    return jsonify({"error": str(exc)}), 502


@app.errorhandler(huggingface.HuggingFaceRequestError)
def handle_huggingface_request_error(exc: huggingface.HuggingFaceRequestError):
    log.info("Некорректный запрос к Hugging Face: %s", exc)
    return jsonify({"error": str(exc)}), 400


@app.errorhandler(huggingface.HuggingFaceNotFound)
def handle_huggingface_not_found(exc: huggingface.HuggingFaceNotFound):
    log.info("Репозиторий Hugging Face не найден: %s", exc)
    return jsonify({"error": str(exc)}), 404


@app.errorhandler(huggingface.HuggingFaceError)
def handle_huggingface_error(exc: huggingface.HuggingFaceError):
    log.warning("Ошибка Hugging Face: %s", exc)
    return jsonify({"error": str(exc)}), 502


@app.errorhandler(404)
def handle_not_found(_exc):
    return jsonify({"error": "Запрошенный ресурс не найден"}), 404


@app.errorhandler(500)
def handle_server_error(exc):
    log.exception("Внутренняя ошибка: %s", exc)
    return jsonify({"error": "Внутренняя ошибка панели, смотрите вывод сервера"}), 500


# ----------------------------------------------------------------------
# страница панели
# ----------------------------------------------------------------------
@app.get("/")
def index():
    """Отдаёт единственную HTML-страницу панели.

    Параметр `chat` (или `model`) открывает модальное окно чата сразу после
    загрузки страницы — так работает адрес `/chat?model=…`.
    """
    chat_model = (request.args.get("chat") or request.args.get("model") or "").strip()
    return render_template(
        "index.html",
        ollama_host=config.OLLAMA_HOST,
        platform_name=ollama_service.platform_name(),
        platform_label=ollama_service.platform_label(),
        service_backend=ollama_service.backend(),
        service_kind=ollama_service.service_kind(),
        service_title=ollama_service.service_title(),
        service_name=ollama_service.service_name(),
        service_hint=ollama_service.service_hint(),
        logs_title=ollama_service.logs_title(),
        logs_source=ollama_service.logs_source(),
        logs_hint=ollama_service.logs_hint(),
        logs_available=ollama_service.logs_available(),
        default_lines=config.JOURNAL_LINES_DEFAULT,
        max_lines=config.JOURNAL_LINES_MAX,
        hf_limit_default=config.HF_SEARCH_LIMIT_DEFAULT,
        hf_limit_max=config.HF_SEARCH_LIMIT_MAX,
        preload_keep_alive=config.PRELOAD_KEEP_ALIVE,
        chat_keep_alive=config.CHAT_KEEP_ALIVE,
        chat_think_default=config.CHAT_THINK_DEFAULT,
        chat_model=chat_model,
        current_user=getpass.getuser(),
    )


@app.get("/chat")
def chat_page():
    """Совместимость: старый адрес окна чата открывает модальное окно панели."""
    model = (request.args.get("model") or "").strip()
    return redirect(url_for("index", chat=model or None))


@app.get("/api/overview")
def api_overview():
    """Сводка для шапки: версия Ollama, состояние службы, количество моделей."""
    overview: dict[str, Any] = {
        "ollama_host": config.OLLAMA_HOST,
        "platform": ollama_service.platform_name(),
        "platform_label": ollama_service.platform_label(),
        "backend": ollama_service.backend(),
        "service_kind": ollama_service.service_kind(),
        "service_name": ollama_service.service_name(),
        "service": None,
        "version": None,
        "models_count": None,
        "running_count": None,
        "errors": [],
    }

    try:
        overview["service"] = ollama_service.unit_status()
    except ollama_service.ServiceError as exc:
        overview["errors"].append(str(exc))

    try:
        overview["version"] = client.version()
        overview["models_count"] = len(client.list_models())
        overview["running_count"] = len(client.list_running())
    except ollama_api.OllamaError as exc:
        overview["errors"].append(str(exc))

    return jsonify(overview)


# ----------------------------------------------------------------------
# модели
# ----------------------------------------------------------------------
@app.get("/api/models")
def api_models():
    """Список установленных моделей."""
    models = client.list_models()
    total = sum(m.get("size") or 0 for m in models)
    return jsonify(
        {"models": models, "count": len(models), "total_size_human": human_size(total)}
    )


@app.get("/api/ps")
def api_ps():
    """Модели, загруженные в память (аналог `ollama ps`)."""
    models = client.list_running()
    return jsonify({"models": models, "count": len(models)})


@app.get("/api/models/details")
def api_model_details():
    """Подробная информация о модели."""
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Не указано имя модели"}), 400
    return jsonify(client.show(name))


@app.post("/api/models/delete")
def api_model_delete():
    """Удаляет установленную модель."""
    name = str(json_payload().get("name") or "").strip()
    if not name:
        return jsonify({"error": "Не указано имя модели"}), 400
    client.delete(name)
    log.info("Модель удалена: %s", name)
    return jsonify({"ok": True, "message": f"Модель «{name}» удалена"})


@app.post("/api/models/unload")
def api_model_unload():
    """Выгружает модель из памяти Ollama."""
    name = str(json_payload().get("name") or "").strip()
    if not name:
        return jsonify({"error": "Не указано имя модели"}), 400
    client.unload(name)
    log.info("Модель выгружена из памяти: %s", name)
    return jsonify({"ok": True, "message": f"Модель «{name}» выгружена из памяти"})


@app.post("/api/models/load")
def api_model_load():
    """Загружает модель в память, не выполняя генерацию.

    Полный аналог того, что делает `ollama run` перед первым ответом: веса
    читаются в память и остаются там на время `keep_alive`.
    """
    body = json_payload()
    name = str(body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Не указано имя модели"}), 400
    try:
        keep_alive = ollama_api.clean_keep_alive(
            body.get("keep_alive"), config.PRELOAD_KEEP_ALIVE
        )
    except ollama_api.OllamaError as exc:
        return jsonify({"error": str(exc)}), 400

    result = client.load(name, keep_alive)
    result["ok"] = True

    # Дополняем ответ данными из `ollama ps`: сколько памяти занято и когда выгрузится.
    try:
        running = next((item for item in client.list_running() if item["name"] == name), None)
    except ollama_api.OllamaError:
        running = None
    if running:
        result["memory"] = running

    log.info("Модель загружена в память: %s (keep_alive=%s)", name, keep_alive)
    message = (
        f"Модель «{name}» в памяти (загрузка {result['load_seconds']} с, "
        f"удержание {keep_alive})"
    )
    if running:
        message += f", VRAM: {running['size_vram_human']} ({running['vram_percent']}%)"
    result["message"] = message
    return jsonify(result)


@app.post("/api/models/pull")
def api_model_pull():
    """Скачивает модель и стримит прогресс через Server-Sent Events."""
    body = json_payload()
    name = str(body.get("name") or "").strip()
    insecure = bool(body.get("insecure"))
    if not name:
        return jsonify({"error": "Не указано имя модели"}), 400
    log.info("Запущено скачивание модели: %s", name)

    def generate() -> Iterator[str]:
        try:
            yield sse_event({"type": "start", "model": name})
            for event in client.pull(name, insecure=insecure):
                if event.get("error"):
                    yield sse_event({"type": "error", "message": str(event["error"])})
                    return
                yield sse_event({"type": "progress", **event})
            yield sse_event({"type": "done", "model": name})
            log.info("Скачивание модели завершено: %s", name)
        except ollama_api.OllamaError as exc:
            log.warning("Ошибка скачивания модели %s: %s", name, exc)
            yield sse_event({"type": "error", "message": str(exc)})

    return sse_response(generate())


# ----------------------------------------------------------------------
# поиск моделей на Hugging Face
# ----------------------------------------------------------------------
def installed_names() -> set[str]:
    """Имена установленных моделей (пустое множество, если Ollama недоступна)."""
    try:
        return {str(model.get("name")) for model in client.list_models()}
    except ollama_api.OllamaError:
        return set()


@app.get("/api/hf/search")
def api_hf_search():
    """Ищет GGUF-модели на Hugging Face (с токеном видны закрытые репозитории)."""
    query = request.args.get("q") or ""
    sort = (request.args.get("sort") or "downloads").strip()
    results = huggingface.search(query, limit=request.args.get("limit"), sort=sort)

    installed = installed_names()
    for item in results:
        base = item["pull_name"]
        item["installed"] = any(
            name == base or name.startswith(f"{base}:") for name in installed
        )

    log.info("Поиск на Hugging Face: «%s» — найдено %s", query.strip(), len(results))
    return jsonify(
        {
            "results": results,
            "count": len(results),
            "query": query.strip(),
            "sort": sort,
            "token": huggingface.token_state(),
        }
    )


@app.get("/api/hf/quants")
def api_hf_quants():
    """Список GGUF-файлов (квантов) в репозитории Hugging Face."""
    repo = request.args.get("repo") or ""
    data = huggingface.quants(repo)
    installed = installed_names()
    for item in data["files"]:
        item["installed"] = item["pull_name"] in installed
    return jsonify(data)


# ----------------------------------------------------------------------
# настройки панели: токен Hugging Face
# ----------------------------------------------------------------------
@app.get("/api/settings")
def api_settings():
    """Состояние настроек панели (сам токен никогда не отдаётся)."""
    return jsonify({"hf_token": huggingface.token_state()})


@app.post("/api/settings/hf-token")
def api_settings_hf_token():
    """Сохраняет токен Hugging Face (пустой токен — удаляет) и проверяет его."""
    raw = json_payload().get("token")
    try:
        token = settings.set_hf_token(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not token:
        log.info("Токен Hugging Face удалён из настроек панели")
        return jsonify(
            {
                "ok": True,
                "set": False,
                "verified": False,
                "message": "Токен удалён: поиск снова работает анонимно",
                "hf_token": huggingface.token_state(),
            }
        )

    check = huggingface.verify_token(token)
    log.info("Токен Hugging Face сохранён (проверка: %s)", "успешно" if check["ok"] else "не пройдена")
    message = check["message"]
    if not check["ok"]:
        message += (
            ". Токен сохранён, но поиск закрытых репозиториев может не работать — "
            "проверьте токен на huggingface.co/settings/tokens (нужны права read)."
        )
    return jsonify(
        {
            "ok": True,
            "set": True,
            "verified": check["ok"],
            "user": check["user"],
            "type": check["type"],
            "message": message,
            "hf_token": huggingface.token_state(),
        }
    )


# ----------------------------------------------------------------------
# чат с моделью (поток через SSE, как в `ollama run`)
# ----------------------------------------------------------------------
@app.post("/api/chat")
def api_chat():
    """Потоковый ответ модели на историю сообщений."""
    body = json_payload()
    name = str(body.get("model") or body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Не указана модель"}), 400

    try:
        messages = chat_messages(body.get("messages"))
        options = chat_options(body.get("options"))
        keep_alive = ollama_api.clean_keep_alive(
            body.get("keep_alive"), config.CHAT_KEEP_ALIVE
        )
        think = chat_think(body.get("think"))
    except (ValueError, ollama_api.OllamaError) as exc:
        return jsonify({"error": str(exc)}), 400

    log.info(
        "Чат: модель %s, сообщений %s, размышления %s",
        name,
        len(messages),
        {None: "по умолчанию", True: "включены", False: "выключены"}[think],
    )

    def generate() -> Iterator[str]:
        yield sse_event(
            {
                "type": "start",
                "model": name,
                "keep_alive": keep_alive,
                "messages": len(messages),
                "think": think,
            }
        )
        try:
            for event in client.chat_stream(
                name, messages, options=options, keep_alive=keep_alive, think=think
            ):
                if event.get("error"):
                    yield sse_event({"type": "error", "message": str(event["error"])})
                    return
                message = event.get("message") or {}
                # Модели с «размышлениями» (qwen3, deepseek-r1 и т. п.) отдают
                # рассуждения отдельным полем thinking — показываем их тоже.
                thinking = message.get("thinking")
                if thinking:
                    yield sse_event({"type": "thinking", "content": thinking})
                chunk = message.get("content")
                if chunk:
                    yield sse_event({"type": "chunk", "content": chunk})
                if event.get("done"):
                    yield sse_event({"type": "done", "stats": chat_stats(event)})
                    return
            yield sse_event({"type": "done", "stats": {}})
        except ollama_api.OllamaError as exc:
            log.warning("Ошибка чата (%s): %s", name, exc)
            yield sse_event({"type": "error", "message": str(exc)})

    return sse_response(generate())


# ----------------------------------------------------------------------
# состояние Ollama (юнит systemd или процесс)
# ----------------------------------------------------------------------
@app.get("/api/service/status")
def api_service_status():
    """Текущее состояние Ollama: юнит systemd или процесс (Windows/macOS)."""
    return jsonify(ollama_service.unit_status())


# ----------------------------------------------------------------------
# журнал Ollama (journalctl или файл журнала)
# ----------------------------------------------------------------------
@app.get("/api/logs")
def api_logs():
    """Последние строки журнала Ollama (без потоковой передачи)."""
    lines = ollama_service.log_lines(requested_lines())
    return jsonify(
        {
            "lines": lines,
            "count": len(lines),
            "service": ollama_service.service_name(),
            "source": ollama_service.logs_source(),
        }
    )


@app.get("/api/logs/stream")
def api_logs_stream():
    """Поток журнала Ollama в реальном времени (journalctl -f или файл) через SSE."""
    lines = requested_lines()
    try:
        process = ollama_service.start_log_follow(lines)
    except ollama_service.ServiceError as exc:
        return jsonify({"error": str(exc)}), 502

    source = ollama_service.logs_source()
    log.info("Открыт поток журнала (%s, последние %s строк)", source, lines)

    def generate() -> Iterator[str]:
        try:
            yield sse_event({"type": "started", "message": source})
            for line in ollama_service.iter_process_lines(process):
                yield sse_event({"type": "line", "line": line})
            yield sse_event(
                {"type": "closed", "returncode": process.returncode or 0}
            )
        finally:
            ollama_service.stop_process(process)

    return sse_response(generate())


if __name__ == "__main__":
    log.info("Панель управления Ollama: http://%s:%s", config.PANEL_HOST, config.PANEL_PORT)
    log.info(
        "ОС: %s | API Ollama: %s | %s: %s | журнал: %s (%s)",
        ollama_service.platform_label(),
        config.OLLAMA_HOST,
        ollama_service.service_kind(),
        ollama_service.service_name(),
        ollama_service.logs_source(),
        ollama_service.backend_label(),
    )
    app.run(
        host=config.PANEL_HOST,
        port=config.PANEL_PORT,
        debug=config.PANEL_DEBUG,
        threaded=True,
    )

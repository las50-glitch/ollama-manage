"""«Хвост» текстового файла журнала: снимок и слежение (аналог `tail -f`).

Модуль намеренно не зависит от остальных файлов проекта: его запускают
отдельным процессом, чтобы слежение за файлом можно было прервать так же, как
прерывается `journalctl -f`.

    python services/logtail.py /путь/server.log -n 200 -f

Панель использует это на Windows и macOS (а также если Ollama запущена вручную
без systemd): журнал там пишется в файл — `%LOCALAPPDATA%\\Ollama\\server.log`
или `~/.ollama/logs/server.log`. Каждая строка печатается сразу (`flush`),
иначе поток Server-Sent Events ждал бы заполнения буфера.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Iterator

# Как часто проверять файл на новые строки (секунды).
POLL_INTERVAL = 0.5
# Начальный размер блока при чтении файла с конца и максимальный размер блока.
CHUNK_START = 64 * 1024
CHUNK_MAX = 8 * 1024 * 1024
# Кодировка журналов Ollama и замена нечитаемых байтов (в журнале бывает мусор
# от терминала Windows вроде escape-последовательностей).
ENCODING = "utf-8"
ERRORS = "replace"


def tail_lines(
    path: str,
    count: int,
    encoding: str = ENCODING,
    errors: str = ERRORS,
) -> list[str]:
    """Возвращает последние `count` строк файла.

    Файл читается блоками с конца: целиком в память попадают только нужные
    строки, поэтому журнал на гигабайты не съест RAM.
    """
    if count <= 0:
        return []
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        block = CHUNK_START
        data = b""
        newlines = 0
        while size > 0 and newlines <= count:
            step = min(block, size)
            size -= step
            handle.seek(size)
            data = handle.read(step) + data
            newlines = data.count(b"\n")
            block = min(block * 2, CHUNK_MAX)
    text = data.decode(encoding, errors)
    return text.splitlines()[-count:]


def _clean(line: str) -> str:
    """Убирает завершающий `\\r` (журнал Windows пишется с CRLF)."""
    return line[:-1] if line.endswith("\r") else line


def _size(path: str) -> int | None:
    """Размер файла или None, если файла нет."""
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def follow(
    path: str,
    count: int = 200,
    poll: float = POLL_INTERVAL,
    encoding: str = ENCODING,
    errors: str = ERRORS,
) -> Iterator[str]:
    """Отдаёт последние `count` строк файла, затем новые по мере появления.

    Если файла ещё нет, слежение начинается с его появления (Ollama создаёт
    журнал при запуске). Если файл усечён или заменён (ротация журнала),
    чтение продолжается с начала нового файла.
    """
    try:
        snapshot = tail_lines(path, count, encoding, errors)
    except OSError:
        snapshot = []
    for line in snapshot:
        yield line

    position = _size(path)
    pending = ""
    while True:
        size = _size(path)
        if size is None:
            # Файла нет (или журнал переехал) — ждём появления.
            position = None
            pending = ""
            time.sleep(poll)
            continue
        if position is None or size < position:
            # Файл появился или был усечён: читаем с начала.
            position = 0
            pending = ""
        if size == position:
            time.sleep(poll)
            continue
        with open(path, "rb") as handle:
            handle.seek(position)
            chunk = handle.read(size - position)
            position = handle.tell()
        lines = (pending + chunk.decode(encoding, errors)).split("\n")
        # Последний элемент — неполная строка: она может дописаться позже.
        pending = lines.pop()
        for line in lines:
            yield _clean(line)


def main(argv: list[str] | None = None) -> int:
    """Точка входа отдельного процесса: печатает строки журнала в stdout."""
    parser = argparse.ArgumentParser(
        prog="logtail", description="Чтение файла журнала Ollama (аналог tail -f)"
    )
    parser.add_argument("path", help="путь к файлу журнала")
    parser.add_argument("-n", "--lines", type=int, default=200, help="сколько строк показать")
    parser.add_argument("-f", "--follow", action="store_true", help="следить за новыми строками")
    parser.add_argument("--encoding", default=ENCODING, help="кодировка файла")
    args = parser.parse_args(argv)

    try:
        source: Iterator[str] = (
            follow(args.path, args.lines, encoding=args.encoding)
            if args.follow
            else iter(tail_lines(args.path, args.lines, encoding=args.encoding))
        )
        for line in source:
            print(line, flush=True)
    except OSError as exc:
        print(f"Не удалось прочитать журнал {args.path}: {exc}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Небольшие вспомогательные функции форматирования."""

import re

# «2026-10-16 15:25:21» внутри строки вида «Fri 2026-10-16 15:25:21 +05».
_TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})")


def human_size(num_bytes: int | float | None) -> str:
    """Преобразует размер в байтах в человекочитаемую строку."""
    if num_bytes is None:
        return "—"
    try:
        value = float(num_bytes)
    except (TypeError, ValueError):
        return "—"
    if value < 0:
        return "—"
    units = ("Б", "КиБ", "МиБ", "ГиБ", "ТиБ", "ПиБ")
    index = 0
    while value >= 1024 and index < len(units) - 1:
        value /= 1024.0
        index += 1
    if index == 0:
        return f"{int(value)} {units[index]}"
    return f"{value:.2f} {units[index]}"


def human_duration(seconds: int | float | None) -> str:
    """Преобразует количество секунд в строку вида «1 ч 5 мин 3 с»."""
    if seconds is None:
        return "—"
    try:
        total = int(float(seconds))
    except (TypeError, ValueError):
        return "—"
    if total < 0:
        return "—"
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days} д")
    if hours:
        parts.append(f"{hours} ч")
    if minutes:
        parts.append(f"{minutes} мин")
    if secs or not parts:
        parts.append(f"{secs} с")
    return " ".join(parts)


def pretty_timestamp(value: str | None) -> str:
    """Приводит таймстамп systemd к виду «16.10.2026 15:25:21».

    systemd отдаёт строки вида «Fri 2026-10-16 15:25:21 +05» или ISO-8601,
    поэтому дату и время вытаскиваем регулярным выражением.
    """
    if not value:
        return "—"
    text = value.strip()
    if not text or text in {"n/a", "0"}:
        return "—"

    match = _TIMESTAMP_RE.search(text)
    if not match:
        return text

    year, month, day = match.group(1).split("-")
    return f"{day}.{month}.{year} {match.group(2)}"

"""Сервисный слой панели управления Ollama."""

from . import (
    huggingface,
    logtail,
    ollama_api,
    ollama_logfile,
    ollama_service,
    settings,
    systemd,
)

__all__ = [
    "huggingface",
    "logtail",
    "ollama_api",
    "ollama_logfile",
    "ollama_service",
    "settings",
    "systemd",
]

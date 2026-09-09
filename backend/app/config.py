from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float, *, minimum: float = 0.1) -> float:
    try:
        return max(minimum, float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_csv(name: str, default: tuple[str, ...] = ()) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    api_token: str
    cors_origins: tuple[str, ...]
    max_upload_bytes: int
    max_image_pixels: int
    max_ws_base64_chars: int
    max_rtsp_streams: int
    max_rtsp_fps: float
    max_tracker_contexts: int
    allowed_rtsp_hosts: tuple[str, ...]
    allow_private_webhooks: bool


settings = Settings(
    api_token=os.environ.get("ULTRA_API_TOKEN", "").strip(),
    cors_origins=_env_csv(
        "ULTRA_CORS_ORIGINS",
        (
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8001",
            "http://localhost:8001",
        ),
    ),
    max_upload_bytes=_env_int("ULTRA_MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
    max_image_pixels=_env_int("ULTRA_MAX_IMAGE_PIXELS", 25_000_000),
    max_ws_base64_chars=_env_int("ULTRA_MAX_WS_BASE64_CHARS", 16 * 1024 * 1024),
    max_rtsp_streams=_env_int("ULTRA_MAX_RTSP_STREAMS", 9),
    max_rtsp_fps=_env_float("ULTRA_MAX_RTSP_FPS", 30.0),
    max_tracker_contexts=_env_int("ULTRA_MAX_TRACKER_CONTEXTS", 10),
    allowed_rtsp_hosts=_env_csv("ULTRA_ALLOWED_RTSP_HOSTS"),
    allow_private_webhooks=_env_bool("ULTRA_ALLOW_PRIVATE_WEBHOOKS"),
)

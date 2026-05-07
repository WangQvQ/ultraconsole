from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from pydantic import BaseModel, Field


WebhookFormat = Literal["generic", "dingtalk", "wecom", "feishu", "slack"]
NotifyKind = Literal["alert", "line.cross", "zone.enter", "zone.leave", "test"]
LevelType = Literal["INFO", "WARN", "ERROR"]
_LEVEL_RANK: dict[str, int] = {"INFO": 0, "WARN": 1, "ERROR": 2}


class WebhookConfig(BaseModel):
    enabled: bool = False
    url: str = ""
    format: WebhookFormat = "generic"
    minLevel: LevelType = "WARN"
    cooldownSec: float = 30.0  # 同 (kind, ref) 在窗口内不重发
    includeKinds: list[NotifyKind] = Field(
        default_factory=lambda: ["alert", "line.cross", "zone.enter"]
    )
    timeoutSec: float = 5.0


class NotifyRequest(BaseModel):
    kind: NotifyKind
    level: LevelType = "WARN"
    title: str
    msg: str
    ref: Optional[str] = None  # line/zone id 或 alert key；用于 cooldown 去重
    fields: dict[str, Any] = Field(default_factory=dict)


class NotifyResult(BaseModel):
    ok: bool
    skipped: bool = False
    reason: Optional[str] = None
    httpStatus: Optional[int] = None


_CONFIG_PATH = Path(os.environ.get("ULTRA_WEBHOOK_FILE", str(Path(__file__).resolve().parent.parent / ".webhook.json")))


class WebhookManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cfg = WebhookConfig()
        self._last_sent: dict[str, float] = {}  # cooldown 表
        self._load()

    # ---- 持久化 ----
    def _load(self) -> None:
        try:
            if _CONFIG_PATH.exists():
                data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
                self._cfg = WebhookConfig(**data)
        except Exception:
            self._cfg = WebhookConfig()

    def _save(self) -> None:
        try:
            _CONFIG_PATH.write_text(json.dumps(self._cfg.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def get(self) -> WebhookConfig:
        with self._lock:
            return self._cfg.model_copy()

    def set(self, cfg: WebhookConfig) -> WebhookConfig:
        with self._lock:
            self._cfg = cfg
            self._save()
            return self._cfg.model_copy()

    # ---- 派发 ----
    def _should_skip(self, cfg: WebhookConfig, req: NotifyRequest) -> Optional[str]:
        if not cfg.enabled:
            return "disabled"
        if not cfg.url:
            return "no_url"
        if _LEVEL_RANK.get(req.level, 0) < _LEVEL_RANK.get(cfg.minLevel, 0):
            return "below_min_level"
        if req.kind not in cfg.includeKinds and req.kind != "test":
            return "kind_excluded"
        if req.kind != "test" and cfg.cooldownSec > 0:
            key = f"{req.kind}:{req.ref or ''}"
            now = time.time()
            last = self._last_sent.get(key, 0.0)
            if now - last < cfg.cooldownSec:
                return f"cooldown({cfg.cooldownSec}s)"
        return None

    def _mark_sent(self, req: NotifyRequest) -> None:
        if req.kind == "test":
            return
        key = f"{req.kind}:{req.ref or ''}"
        self._last_sent[key] = time.time()

    def dispatch(self, req: NotifyRequest) -> NotifyResult:
        with self._lock:
            cfg = self._cfg.model_copy()
        skip = self._should_skip(cfg, req)
        if skip:
            return NotifyResult(ok=False, skipped=True, reason=skip)

        payload = _format_payload(cfg.format, req)
        try:
            with httpx.Client(timeout=cfg.timeoutSec, follow_redirects=True) as client:
                resp = client.post(cfg.url, json=payload, headers={"Content-Type": "application/json"})
            ok = 200 <= resp.status_code < 300
            if ok:
                with self._lock:
                    self._mark_sent(req)
            return NotifyResult(ok=ok, httpStatus=resp.status_code, reason=None if ok else resp.text[:200])
        except Exception as e:
            return NotifyResult(ok=False, reason=f"{type(e).__name__}: {e}")


# ---- 各家 webhook 报文格式 ----

def _emoji_for(level: str) -> str:
    return {"INFO": "ℹ️", "WARN": "⚠️", "ERROR": "🚨"}.get(level, "•")


def _summary_lines(req: NotifyRequest) -> list[str]:
    lines = [
        f"{_emoji_for(req.level)} [{req.level}] {req.title}",
        req.msg,
    ]
    if req.ref:
        lines.append(f"ref: {req.ref}")
    if req.fields:
        for k, v in req.fields.items():
            lines.append(f"- {k}: {v}")
    lines.append(f"ts: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    return lines


def _format_payload(fmt: WebhookFormat, req: NotifyRequest) -> dict[str, Any]:
    text = "\n".join(_summary_lines(req))
    if fmt == "dingtalk":
        return {"msgtype": "text", "text": {"content": text}}
    if fmt == "wecom":
        return {"msgtype": "text", "text": {"content": text}}
    if fmt == "feishu":
        return {"msg_type": "text", "content": {"text": text}}
    if fmt == "slack":
        return {"text": text}
    # generic
    return {
        "kind": req.kind,
        "level": req.level,
        "title": req.title,
        "msg": req.msg,
        "ref": req.ref,
        "fields": req.fields,
        "text": text,
        "ts": time.time(),
    }


_manager = WebhookManager()


def manager() -> WebhookManager:
    return _manager

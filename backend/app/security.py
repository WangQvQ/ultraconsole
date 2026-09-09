from __future__ import annotations

import base64
import hmac
import ipaddress
import socket
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, WebSocket

from .config import settings


def _token_matches(value: str | None) -> bool:
    if not settings.api_token:
        return True
    if not value:
        return False
    token = value.removeprefix("Bearer ").strip()
    return hmac.compare_digest(token, settings.api_token)


def require_http_auth(request: Request) -> None:
    if not _token_matches(request.headers.get("authorization") or request.headers.get("x-api-token")):
        raise HTTPException(status_code=401, detail="Invalid or missing API token")


def _websocket_protocol_token(ws: WebSocket) -> tuple[str | None, str | None]:
    for protocol in ws.headers.get("sec-websocket-protocol", "").split(","):
        protocol = protocol.strip()
        if not protocol.startswith("ultra-token."):
            continue
        encoded = protocol.removeprefix("ultra-token.")
        try:
            padding = "=" * (-len(encoded) % 4)
            token = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
            return token, protocol
        except (ValueError, UnicodeDecodeError):
            return None, None
    return None, None


async def require_ws_auth(ws: WebSocket) -> tuple[bool, str | None]:
    protocol_token, selected_protocol = _websocket_protocol_token(ws)
    token = protocol_token or ws.query_params.get("token") or ws.headers.get("x-api-token")
    if _token_matches(token):
        return True, selected_protocol
    await ws.close(code=1008, reason="Invalid or missing API token")
    return False, None


def validate_rtsp_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"rtsp", "rtsps"} or not parsed.hostname:
        raise ValueError("RTSP URL must use rtsp:// or rtsps:// and include a host")
    if settings.allowed_rtsp_hosts and parsed.hostname not in settings.allowed_rtsp_hosts:
        raise ValueError("RTSP host is not in ULTRA_ALLOWED_RTSP_HOSTS")
    return url


def _is_private_address(host: str) -> bool:
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ValueError(f"Webhook host cannot be resolved: {host}") from exc
        addresses = {ipaddress.ip_address(info[4][0]) for info in infos}
    return any(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        for ip in addresses
    )


def validate_webhook_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Webhook URL must use http:// or https:// and include a host")
    if not settings.allow_private_webhooks and _is_private_address(parsed.hostname):
        raise ValueError("Private, loopback and link-local webhook targets are disabled")
    return url

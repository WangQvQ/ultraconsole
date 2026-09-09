from dataclasses import replace

import app.main as main
import app.security as security
import pytest
from app.security import validate_rtsp_url, validate_webhook_url
from fastapi.testclient import TestClient


def test_rtsp_protocol_is_restricted() -> None:
    assert validate_rtsp_url("rtsp://camera.local/live") == "rtsp://camera.local/live"
    with pytest.raises(ValueError):
        validate_rtsp_url("file:///etc/passwd")


@pytest.mark.parametrize("url", ["http://127.0.0.1/hook", "http://169.254.169.254/latest", "http://[::1]/hook"])
def test_private_webhook_targets_are_rejected(url: str) -> None:
    with pytest.raises(ValueError):
        validate_webhook_url(url)


def test_api_token_middleware(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(security, "settings", replace(security.settings, api_token="test-secret"))
    client = TestClient(main.app)

    assert client.get("/api/models").status_code == 401
    assert client.get("/api/models", headers={"authorization": "Bearer test-secret"}).status_code == 200
    assert client.get("/api/health").status_code == 200

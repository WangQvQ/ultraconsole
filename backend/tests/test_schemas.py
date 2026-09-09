import pytest
from app.schemas import Params
from app.webhook import WebhookConfig
from pydantic import ValidationError


def test_params_bounds() -> None:
    assert Params(conf=0.4, iou=0.5).conf == 0.4
    with pytest.raises(ValidationError):
        Params(conf=1.1, iou=0.5)


def test_webhook_timeout_and_cooldown_bounds() -> None:
    with pytest.raises(ValidationError):
        WebhookConfig(timeoutSec=0.1)
    with pytest.raises(ValidationError):
        WebhookConfig(cooldownSec=-1)

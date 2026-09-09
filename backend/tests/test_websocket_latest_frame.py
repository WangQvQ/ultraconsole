import base64
import threading
import time
from concurrent.futures import CancelledError
from contextlib import suppress

import app.main as main
from app.schemas import PredResponse, Telemetry
from fastapi.testclient import TestClient
from PIL import Image


def test_webcam_inference_drops_intermediate_frames(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    calls = 0

    monkeypatch.setattr(main.runtime, "current", lambda: object())
    monkeypatch.setattr(main, "_decode_image", lambda raw: Image.new("RGB", (2, 2)))

    def fake_infer(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            assert release.wait(timeout=2)
        return PredResponse(ts=time.time(), width=2, height=2, taskType="detect", telemetry=Telemetry())

    monkeypatch.setattr(main, "_run_infer", fake_infer)
    payload = base64.b64encode(b"jpeg").decode()
    client = TestClient(main.app)

    # Starlette's TestClient may cancel its portal future while closing a WebSocket
    # on Python 3.13; the observable frame-order assertions remain authoritative.
    with suppress(CancelledError):
        with client.websocket_connect("/ws/infer") as ws:
            ws.send_json({"type": "frame", "frameId": "1", "imageJpegBase64": payload})
            assert started.wait(timeout=2)
            ws.send_json({"type": "frame", "frameId": "2", "imageJpegBase64": payload})
            ws.send_json({"type": "frame", "frameId": "3", "imageJpegBase64": payload})
            release.set()

            assert ws.receive_json()["frameId"] == "1"
            assert ws.receive_json()["frameId"] == "3"

    assert calls == 2

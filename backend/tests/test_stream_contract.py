import json
import struct
from concurrent.futures import CancelledError
from contextlib import suppress
from types import SimpleNamespace

import app.main as main
import numpy as np
from app.schemas import PredResponse
from fastapi.testclient import TestClient


def test_rtsp_sends_paired_frames_and_uses_distinct_keys_across_connections(monkeypatch):
    keys = []

    class Capture:
        def __init__(self):
            self.reads = 0

        def set(self, *args):
            pass

        def open(self, url):
            pass

        def isOpened(self):
            return True

        def read(self):
            self.reads += 1
            return (True, np.zeros((8, 12, 3), dtype=np.uint8)) if self.reads == 1 else (False, None)

        def release(self):
            pass

    def infer(**kwargs):
        keys.append(kwargs["tracker_key"])
        return PredResponse(ts=1, width=12, height=8, taskType="detect")

    monkeypatch.setattr(main.cv2, "VideoCapture", Capture)
    monkeypatch.setattr(main, "validate_rtsp_url", lambda url: None)
    monkeypatch.setattr(
        main, "runtime", SimpleNamespace(current=lambda: object(), infer_image=infer, release_tracker=lambda key: None)
    )
    for _ in range(2):
        with suppress(CancelledError), TestClient(main.app).websocket_connect("/ws/stream") as ws:
            ws.send_json({"type": "rtsp.start", "streamId": "main", "url": "rtsp://fixture", "fps": 10, "track": True})
            while True:
                message = ws.receive()
                if "bytes" in message:
                    packet = message["bytes"]
                    size = struct.unpack("!I", packet[:4])[0]
                    header = json.loads(packet[4 : 4 + size])
                    assert header["streamId"] == "main"
                    assert packet[4 + size :][:2] == b"\xff\xd8"  # JPEG SOI
                    pred = ws.receive_json()  # A frame's next message must be its own prediction.
                    assert pred["type"] == "pred"
                    assert pred["frameId"] == header["frameId"]
                    assert pred["streamId"] == header["streamId"]
                    break
    assert len(keys) == 2
    assert keys[0] != keys[1]

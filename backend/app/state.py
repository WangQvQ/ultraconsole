from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Optional

from .logging_store import LogStore
from .schemas import DeviceType, Params


@dataclass
class EngineState:
    device: DeviceType = "cpu"
    warming: bool = False


class AppState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.params = Params()
        self.engine = EngineState(device="cuda" if os.environ.get("ULTRA_DEVICE") == "cuda" else "cpu")
        self.model_id: Optional[str] = None
        self.logs = LogStore(maxlen=10_000)


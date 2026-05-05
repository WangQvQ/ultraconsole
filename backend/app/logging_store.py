from __future__ import annotations

import csv
import io
import json
import threading
import time
from collections import deque
from typing import Any, Deque, Iterable, Literal

from .schemas import LogEntry

Level = Literal["INFO", "WARN", "ERROR"]


class LogStore:
    def __init__(self, maxlen: int = 10_000) -> None:
        self._lock = threading.Lock()
        self._buf: Deque[LogEntry] = deque(maxlen=maxlen)

    def append(
        self,
        *,
        level: Level,
        event: str,
        msg: str,
        fields: dict[str, Any] | None = None,
        ts: float | None = None,
    ) -> LogEntry:
        entry = LogEntry(
            ts=time.time() if ts is None else ts,
            level=level,
            event=event,
            msg=msg,
            fields=fields or {},
        )
        with self._lock:
            self._buf.append(entry)
        return entry

    def tail(self, n: int = 200) -> list[LogEntry]:
        with self._lock:
            return list(self._buf)[-n:]

    def iter_all(self) -> Iterable[LogEntry]:
        with self._lock:
            return list(self._buf)

    def export_csv(self) -> str:
        rows = self.iter_all()
        f = io.StringIO()
        writer = csv.writer(f)
        writer.writerow(["ts", "level", "event", "msg", "fields_json"])
        for r in rows:
            writer.writerow([r.ts, r.level, r.event, r.msg, json.dumps(r.fields, ensure_ascii=False, separators=(",", ":"))])
        return f.getvalue()


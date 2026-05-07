from __future__ import annotations

import threading
import time
from collections import deque
from typing import Deque, Optional

from .schemas import GpuStat, LatencyStats, SystemStats


# ---- psutil（可选）----
try:
    import psutil  # type: ignore
    _HAS_PSUTIL = True
except Exception:
    psutil = None  # type: ignore
    _HAS_PSUTIL = False

# ---- pynvml（可选）----
try:
    import pynvml  # type: ignore
    pynvml.nvmlInit()
    _HAS_NVML = True
except Exception:
    pynvml = None  # type: ignore
    _HAS_NVML = False


class LatencyTracker:
    """记录最近 N 次推理耗时，给出分位统计。"""

    def __init__(self, maxlen: int = 600) -> None:
        self._lock = threading.Lock()
        self._buf: Deque[float] = deque(maxlen=maxlen)

    def record(self, ms: float) -> None:
        with self._lock:
            self._buf.append(float(ms))

    def snapshot(self, recent_n: int = 60) -> LatencyStats:
        with self._lock:
            data = list(self._buf)
        n = len(data)
        if n == 0:
            return LatencyStats(count=0)
        sorted_data = sorted(data)

        def pct(p: float) -> float:
            if n == 1:
                return sorted_data[0]
            k = max(0, min(n - 1, int(round((p / 100.0) * (n - 1)))))
            return sorted_data[k]

        return LatencyStats(
            count=n,
            p50Ms=round(pct(50), 2),
            p95Ms=round(pct(95), 2),
            p99Ms=round(pct(99), 2),
            avgMs=round(sum(data) / n, 2),
            recentMs=[round(x, 2) for x in data[-recent_n:]],
        )


_latency_tracker = LatencyTracker(maxlen=600)


def record_latency(ms: float) -> None:
    _latency_tracker.record(ms)


def latency_snapshot(recent_n: int = 60) -> LatencyStats:
    return _latency_tracker.snapshot(recent_n=recent_n)


# psutil.cpu_percent 第一次返回 0，需要预热
if _HAS_PSUTIL:
    try:
        psutil.cpu_percent(interval=None)
    except Exception:
        pass


def _gpu_stats() -> list[GpuStat]:
    if not _HAS_NVML:
        return []
    out: list[GpuStat] = []
    try:
        count = pynvml.nvmlDeviceGetCount()
    except Exception:
        return []
    for i in range(count):
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name_raw = pynvml.nvmlDeviceGetName(handle)
            name = name_raw.decode("utf-8") if isinstance(name_raw, (bytes, bytearray)) else str(name_raw)
            try:
                util = float(pynvml.nvmlDeviceGetUtilizationRates(handle).gpu)
            except Exception:
                util = None
            try:
                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                mem_used = mem.used / (1024 * 1024)
                mem_total = mem.total / (1024 * 1024)
            except Exception:
                mem_used = None
                mem_total = None
            try:
                temp = float(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
            except Exception:
                temp = None
            try:
                power = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except Exception:
                power = None
            out.append(
                GpuStat(
                    index=i,
                    name=name,
                    utilPct=util,
                    memUsedMb=round(mem_used, 1) if mem_used is not None else None,
                    memTotalMb=round(mem_total, 1) if mem_total is not None else None,
                    tempC=temp,
                    powerW=round(power, 1) if power is not None else None,
                )
            )
        except Exception:
            continue
    return out


def system_stats() -> SystemStats:
    cpu_pct: Optional[float] = None
    cpu_count: Optional[int] = None
    mem_used: Optional[float] = None
    mem_total: Optional[float] = None
    mem_pct: Optional[float] = None
    if _HAS_PSUTIL:
        try:
            cpu_pct = float(psutil.cpu_percent(interval=None))
            cpu_count = int(psutil.cpu_count(logical=True) or 0) or None
            vm = psutil.virtual_memory()
            mem_used = round(vm.used / (1024 * 1024), 1)
            mem_total = round(vm.total / (1024 * 1024), 1)
            mem_pct = float(vm.percent)
        except Exception:
            pass

    return SystemStats(
        ts=time.time(),
        cpuPct=cpu_pct,
        cpuCount=cpu_count,
        memUsedMb=mem_used,
        memTotalMb=mem_total,
        memPct=mem_pct,
        gpus=_gpu_stats(),
        inferLatency=latency_snapshot(),
    )

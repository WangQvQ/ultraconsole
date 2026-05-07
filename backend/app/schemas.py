from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


DeviceType = Literal["cpu", "cuda"]
TaskType = Literal["detect", "segment", "pose"]


class ModelInfo(BaseModel):
    id: str
    filename: str
    taskType: TaskType
    names: dict[str, str]


class Params(BaseModel):
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    classFilter: list[str] = Field(default_factory=list)
    track: bool = False  # 是否启用 ByteTrack 跟踪


class SelectModelRequest(BaseModel):
    modelId: str


class SelectEngineRequest(BaseModel):
    device: DeviceType


class UpdateParamsRequest(Params):
    pass


class LogEntry(BaseModel):
    ts: float
    level: Literal["INFO", "WARN", "ERROR"]
    event: str
    msg: str
    fields: dict[str, Any] = Field(default_factory=dict)


class Telemetry(BaseModel):
    fps: Optional[float] = None
    preprocessMs: Optional[float] = None
    inferenceMs: Optional[float] = None
    postprocessMs: Optional[float] = None
    vramUtil: Optional[float] = None


class PredBBox(BaseModel):
    cls: str
    conf: float
    x1: float
    y1: float
    x2: float
    y2: float
    label: Optional[str] = None
    trackId: Optional[int] = None


class PredMask(BaseModel):
    """实例分割：单个 mask 用归一化前的源图坐标多边形表达。"""
    cls: str
    trackId: Optional[int] = None
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]


class PredKeypoint(BaseModel):
    x: float
    y: float
    conf: Optional[float] = None


class PredInstanceKeypoints(BaseModel):
    cls: str
    trackId: Optional[int] = None
    points: list[PredKeypoint] = Field(default_factory=list)


class PredResponse(BaseModel):
    frameId: Optional[str] = None
    ts: float
    width: int
    height: int
    taskType: TaskType
    bboxes: list[PredBBox] = Field(default_factory=list)
    masks: list[PredMask] = Field(default_factory=list)
    keypoints: list[PredInstanceKeypoints] = Field(default_factory=list)
    telemetry: Telemetry = Field(default_factory=Telemetry)


class LatencyStats(BaseModel):
    count: int
    p50Ms: Optional[float] = None
    p95Ms: Optional[float] = None
    p99Ms: Optional[float] = None
    avgMs: Optional[float] = None
    recentMs: list[float] = Field(default_factory=list)  # 最近 N 帧推理耗时（绘 sparkline 用）


class GpuStat(BaseModel):
    index: int
    name: str
    utilPct: Optional[float] = None
    memUsedMb: Optional[float] = None
    memTotalMb: Optional[float] = None
    tempC: Optional[float] = None
    powerW: Optional[float] = None


class SystemStats(BaseModel):
    ts: float
    cpuPct: Optional[float] = None
    cpuCount: Optional[int] = None
    memUsedMb: Optional[float] = None
    memTotalMb: Optional[float] = None
    memPct: Optional[float] = None
    gpus: list[GpuStat] = Field(default_factory=list)
    inferLatency: LatencyStats = Field(default_factory=lambda: LatencyStats(count=0))


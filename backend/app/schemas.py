from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

DeviceType = Literal["cpu", "cuda"]
TaskType = Literal["detect", "segment", "pose", "classify", "obb", "semantic", "depth"]


class ModelCapabilities(BaseModel):
    boxes: bool = False
    tracking: bool = False
    masks: bool = False
    keypoints: bool = False
    classification: bool = False
    semantic: bool = False
    depth: bool = False
    nms: bool = False
    nmsFree: bool = False


class ModelInfo(BaseModel):
    id: str
    filename: str
    taskType: TaskType | None = None  # Unloaded models have not been inspected.
    names: dict[str, str]
    capabilities: ModelCapabilities | None = None


class Params(BaseModel):
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    classFilter: list[str] = Field(default_factory=list)
    track: bool = False  # 是否启用 ByteTrack 跟踪
    imgsz: int = Field(default=640, ge=64, le=2048)
    maxDet: int = Field(default=300, ge=1, le=3000)
    nms: Literal["auto", "free"] = "auto"
    depthMin: float = Field(default=0.1, ge=0.0, le=1000.0)
    depthMax: float = Field(default=20.0, gt=0.0, le=1000.0)

    @field_validator("imgsz")
    @classmethod
    def stride_aligned(cls, value: int) -> int:
        if value % 32:
            raise ValueError("imgsz must be a multiple of 32")
        return value

    @model_validator(mode="after")
    def depth_range(self) -> Params:
        if self.depthMax <= self.depthMin:
            raise ValueError("depthMax must be greater than depthMin")
        return self


class SelectModelRequest(BaseModel):
    modelId: str


class SelectDepthModelRequest(BaseModel):
    modelId: str | None = None


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
    fps: float | None = None
    preprocessMs: float | None = None
    inferenceMs: float | None = None
    postprocessMs: float | None = None
    vramUtil: float | None = None


class PredBBox(BaseModel):
    cls: str
    conf: float
    x1: float
    y1: float
    x2: float
    y2: float
    label: str | None = None
    trackId: int | None = None
    corners: list[list[float]] | None = None  # OBB corners in original-image pixels.
    depthMeters: float | None = None
    depthMethod: Literal["mask-median", "box-center-median"] | None = None
    depthValidFraction: float | None = None


class PredClassification(BaseModel):
    cls: str
    conf: float


class PredDenseMap(BaseModel):
    """Bounded nearest-sampled map, at most 256 pixels on its longest side.

    Depth is little-endian float32 meters; semantic maps are little-endian uint16 class IDs.
    PNG is a display preview only. Sample values retain their original scale, including invalid depth pixels.
    """

    width: int
    height: int
    dtype: Literal["float32", "uint16"]
    dataBase64: str
    pngBase64: str
    unit: Literal["m", "class-id"]
    modelId: str
    min: float | None = None
    max: float | None = None
    median: float | None = None
    validFraction: float | None = None
    colorMin: float | None = None
    colorMax: float | None = None
    classes: dict[str, str] = Field(default_factory=dict)


class PredMask(BaseModel):
    """实例分割：单个 mask 用归一化前的源图坐标多边形表达。"""

    cls: str
    trackId: int | None = None
    points: list[list[float]] = Field(default_factory=list)  # [[x,y], ...]


class PredKeypoint(BaseModel):
    x: float
    y: float
    conf: float | None = None


class PredInstanceKeypoints(BaseModel):
    cls: str
    trackId: int | None = None
    points: list[PredKeypoint] = Field(default_factory=list)


class PredResponse(BaseModel):
    schemaVersion: int = 2
    modelId: str | None = None
    frameId: str | None = None
    ts: float
    width: int
    height: int
    taskType: TaskType
    bboxes: list[PredBBox] = Field(default_factory=list)
    masks: list[PredMask] = Field(default_factory=list)
    keypoints: list[PredInstanceKeypoints] = Field(default_factory=list)
    classifications: list[PredClassification] = Field(default_factory=list)
    depth: PredDenseMap | None = None
    semantic: PredDenseMap | None = None
    telemetry: Telemetry = Field(default_factory=Telemetry)


class LatencyStats(BaseModel):
    count: int
    p50Ms: float | None = None
    p95Ms: float | None = None
    p99Ms: float | None = None
    avgMs: float | None = None
    recentMs: list[float] = Field(default_factory=list)  # 最近 N 帧推理耗时（绘 sparkline 用）


class GpuStat(BaseModel):
    index: int
    name: str
    utilPct: float | None = None
    memUsedMb: float | None = None
    memTotalMb: float | None = None
    tempC: float | None = None
    powerW: float | None = None


class SystemStats(BaseModel):
    ts: float
    cpuPct: float | None = None
    cpuCount: int | None = None
    memUsedMb: float | None = None
    memTotalMb: float | None = None
    memPct: float | None = None
    gpus: list[GpuStat] = Field(default_factory=list)
    inferLatency: LatencyStats = Field(default_factory=lambda: LatencyStats(count=0))

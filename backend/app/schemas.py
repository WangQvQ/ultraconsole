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


class PredResponse(BaseModel):
    frameId: Optional[str] = None
    ts: float
    width: int
    height: int
    taskType: TaskType
    bboxes: list[PredBBox] = Field(default_factory=list)
    telemetry: Telemetry = Field(default_factory=Telemetry)


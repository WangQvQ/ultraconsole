from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image
from ultralytics import YOLO

from .schemas import PredBBox, PredResponse, TaskType, Telemetry


@dataclass(frozen=True)
class LoadedModel:
    id: str
    filename: str
    task_type: TaskType
    names: dict[str, str]
    yolo: YOLO


def _guess_task_type(yolo: YOLO) -> TaskType:
    task = getattr(yolo, "task", None)
    if task in ("segment", "pose", "detect"):
        return task
    return "detect"


class UltralyticsRuntime:
    def __init__(self, models_dir: str) -> None:
        self._models_dir = models_dir
        self._loaded: Optional[LoadedModel] = None
        self._lock = threading.RLock()

    def list_models(self) -> list[tuple[str, str]]:
        if not os.path.isdir(self._models_dir):
            return []
        out: list[tuple[str, str]] = []
        for fn in sorted(os.listdir(self._models_dir)):
            if fn.endswith((".pt", ".engine", ".onnx")):
                model_id = fn
                out.append((model_id, os.path.join(self._models_dir, fn)))
        return out

    def load(self, model_id: str, device: str) -> LoadedModel:
        path = os.path.join(self._models_dir, model_id)
        yolo = YOLO(path)
        # ultralytics 支持传入 device 到 predict；这里先不做全局绑定
        names = {str(k): str(v) for k, v in getattr(yolo.model, "names", getattr(yolo, "names", {})).items()}
        task_type = _guess_task_type(yolo)
        loaded = LoadedModel(id=model_id, filename=model_id, task_type=task_type, names=names, yolo=yolo)
        # 轻量 warmup：做一次空推理（如果有 device）
        try:
            _ = self._warmup(loaded=loaded, device=device)
        except Exception:
            # warmup 失败不阻断
            pass
        with self._lock:
            self._loaded = loaded
        return loaded

    def current(self) -> Optional[LoadedModel]:
        with self._lock:
            return self._loaded

    def _warmup(self, *, loaded: LoadedModel, device: str) -> None:
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        _ = loaded.yolo.predict(dummy, verbose=False, device=device, conf=0.25, iou=0.7)

    def infer_image(
        self,
        *,
        image: Image.Image,
        device: str,
        conf: float,
        iou: float,
        class_filter: list[str],
    ) -> PredResponse:
        with self._lock:
            loaded = self._loaded
        if loaded is None:
            raise RuntimeError("No model loaded")

        t0 = time.perf_counter()
        rgb = image.convert("RGB")
        np_img = np.array(rgb)
        t1 = time.perf_counter()
        results = loaded.yolo.predict(
            np_img,
            verbose=False,
            device=device,
            conf=conf,
            iou=iou,
        )
        t2 = time.perf_counter()

        r0 = results[0]
        h, w = np_img.shape[:2]
        bboxes: list[PredBBox] = []

        if getattr(r0, "boxes", None) is not None and r0.boxes is not None:
            boxes = r0.boxes
            xyxy = boxes.xyxy.cpu().numpy() if hasattr(boxes.xyxy, "cpu") else np.asarray(boxes.xyxy)
            confs = boxes.conf.cpu().numpy() if hasattr(boxes.conf, "cpu") else np.asarray(boxes.conf)
            clss = boxes.cls.cpu().numpy() if hasattr(boxes.cls, "cpu") else np.asarray(boxes.cls)
            for (x1, y1, x2, y2), c, cls_id in zip(xyxy, confs, clss):
                cls_key = str(int(cls_id))
                cls_name = loaded.names.get(cls_key, cls_key)
                if class_filter and cls_name not in class_filter:
                    continue
                bboxes.append(
                    PredBBox(
                        cls=cls_name,
                        conf=float(c),
                        x1=float(x1),
                        y1=float(y1),
                        x2=float(x2),
                        y2=float(y2),
                        label=f"{cls_name} {float(c):.2f}",
                    )
                )

        t3 = time.perf_counter()
        tel = Telemetry(
            preprocessMs=(t1 - t0) * 1000.0,
            inferenceMs=(t2 - t1) * 1000.0,
            postprocessMs=(t3 - t2) * 1000.0,
        )

        return PredResponse(
            ts=time.time(),
            width=w,
            height=h,
            taskType=loaded.task_type,
            bboxes=bboxes,
            telemetry=tel,
        )


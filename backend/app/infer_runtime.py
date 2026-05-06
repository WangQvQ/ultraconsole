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
        # YOLO.predict 不保证线程安全：用 predict_lock 串行化推理
        self._predict_lock = threading.Lock()

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
        # 已经加载过且同一文件：直接复用，避免重读权重
        with self._lock:
            cur = self._loaded
        if cur is not None and cur.id == model_id:
            try:
                self._warmup(loaded=cur, device=device)
            except Exception:
                pass
            return cur

        path = os.path.join(self._models_dir, model_id)
        yolo = YOLO(path)
        names = {str(k): str(v) for k, v in getattr(yolo.model, "names", getattr(yolo, "names", {})).items()}
        task_type = _guess_task_type(yolo)
        loaded = LoadedModel(id=model_id, filename=model_id, task_type=task_type, names=names, yolo=yolo)
        # warmup 失败不阻断 load，但忠实落库当前模型
        try:
            self._warmup(loaded=loaded, device=device)
        except Exception:
            pass
        with self._lock:
            self._loaded = loaded
        return loaded

    def warmup_current(self, device: str) -> None:
        """切换 device 时仅做一次空推理预热，不重新读权重。"""
        with self._lock:
            loaded = self._loaded
        if loaded is None:
            return
        self._warmup(loaded=loaded, device=device)

    def current(self) -> Optional[LoadedModel]:
        with self._lock:
            return self._loaded

    def _warmup(self, *, loaded: LoadedModel, device: str) -> None:
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        with self._predict_lock:
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
        with self._predict_lock:
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


from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image
from ultralytics import YOLO

from .schemas import ModelInfo, Params, PredResponse, TaskType, Telemetry
from .system_stats import record_latency
from .task_adapters import SUPPORTED_TASKS, TRACKABLE_TASKS, adapt_result, capabilities, dense_map, fuse_depth, to_numpy


@dataclass(frozen=True)
class LoadedModel:
    id: str
    filename: str
    task_type: TaskType
    names: dict[str, str]
    path: str
    yolo: YOLO

    def info(self) -> ModelInfo:
        caps = capabilities(self.task_type)
        modules = getattr(getattr(self.yolo, "model", None), "model", None)
        head = modules[-1] if modules is not None else None
        # Availability is the retained branch, not the currently selected (usually NMS) head.
        caps.nmsFree = self.path.endswith(".pt") and getattr(head, "one2one_cv2", None) is not None
        return ModelInfo(
            id=self.id, filename=self.filename, taskType=self.task_type, names=self.names, capabilities=caps
        )


def _guess_task_type(yolo: YOLO) -> TaskType:
    task = getattr(yolo, "task", None)
    if task not in SUPPORTED_TASKS:
        raise ValueError(f"Unsupported model task: {task!r}. Supported: {', '.join(sorted(SUPPORTED_TASKS))}")
    return task


class UltralyticsRuntime:
    def __init__(self, models_dir: str, *, max_tracker_contexts: int = 10) -> None:
        self._models_dir = models_dir
        self._loaded: LoadedModel | None = None
        self._depth: LoadedModel | None = None
        self._device: str | None = None
        self._lock = threading.RLock()
        # Serialize model creation, warmup, inference AND result conversion. Ultralytics
        # predictors and trackers are mutable; result conversion must retain the same snapshot.
        self._predict_lock = threading.RLock()
        self._tracking_models: dict[str, YOLO] = {}
        self._max_tracker_contexts = max_tracker_contexts

    def list_models(self) -> list[tuple[str, str]]:
        if not os.path.isdir(self._models_dir):
            return []
        return [
            (fn, os.path.join(self._models_dir, fn))
            for fn in sorted(os.listdir(self._models_dir))
            if fn.endswith((".pt", ".engine", ".onnx")) and os.path.isfile(os.path.join(self._models_dir, fn))
        ]

    def _create(self, model_id: str, device: str) -> LoadedModel:
        path = os.path.join(self._models_dir, model_id)
        if not os.path.isfile(path):
            raise ValueError(f"Model file does not exist: {model_id}")
        yolo = YOLO(path)
        task = _guess_task_type(yolo)
        # Exported artifacts initialize their backend on predict; warm up before reading names.
        yolo.predict(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False, device=device)
        raw_names = yolo.names
        names = {
            str(k): str(v) for k, v in (raw_names.items() if isinstance(raw_names, dict) else enumerate(raw_names))
        }
        return LoadedModel(id=model_id, filename=model_id, task_type=task, names=names, path=path, yolo=yolo)

    def load(self, model_id: str, device: str) -> LoadedModel:
        with self._predict_lock:
            current = self.current()
            if current is not None and current.id == model_id:
                self.warmup_current(device)
                return current
            loaded = self._create(model_id, device)
            with self._lock:
                self._loaded = loaded
                self._device = device
                self._tracking_models.clear()
            return loaded

    def set_depth_model(self, model_id: str | None, device: str) -> LoadedModel | None:
        with self._predict_lock:
            loaded = self._create(model_id, device) if model_id else None
            if loaded is not None and loaded.task_type != "depth":
                raise ValueError("The auxiliary model must have task=depth")
            with self._lock:
                self._depth = loaded
            return loaded

    def depth_model(self) -> LoadedModel | None:
        with self._lock:
            return self._depth

    def warmup_current(self, device: str) -> None:
        with self._predict_lock:
            for loaded in (self.current(), self.depth_model()):
                if loaded is not None:
                    self._warmup(loaded=loaded, device=device)
            with self._lock:
                self._device = device
                self._tracking_models.clear()

    def current(self) -> LoadedModel | None:
        with self._lock:
            return self._loaded

    def release_tracker(self, tracker_key: str) -> None:
        with self._predict_lock, self._lock:
            self._tracking_models.pop(tracker_key, None)

    def _tracking_model(self, loaded: LoadedModel, tracker_key: str) -> YOLO:
        with self._predict_lock, self._lock:
            if self._loaded is not loaded:
                raise RuntimeError("Model changed while creating tracking context")
            existing = self._tracking_models.get(tracker_key)
            if existing is not None:
                return existing
            if len(self._tracking_models) >= self._max_tracker_contexts:
                raise RuntimeError(f"Too many tracking contexts (max={self._max_tracker_contexts})")
            model = YOLO(loaded.path)
            self._tracking_models[tracker_key] = model
            return model

    def _warmup(self, *, loaded: LoadedModel, device: str) -> None:
        with self._predict_lock:
            loaded.yolo.predict(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False, device=device)

    def infer_image(
        self,
        *,
        image: Image.Image,
        device: str,
        conf: float,
        iou: float,
        class_filter: list[str],
        track: bool = False,
        tracker_key: str | None = None,
        params: Params | None = None,
    ) -> PredResponse:
        # PIL is RGB; NumPy input to Ultralytics is BGR. Keep this boundary explicit.
        bgr = np.asarray(image.convert("RGB"))[..., ::-1].copy()
        options = params or Params(conf=conf, iou=iou, classFilter=class_filter, track=track)
        with self._predict_lock:
            loaded = self.current()
            if loaded is None:
                raise RuntimeError("No model loaded")
            device = self._device or device
            track = track and loaded.task_type in TRACKABLE_TASKS
            model = loaded.yolo
            if track:
                if not tracker_key:
                    raise ValueError("tracker_key is required when tracking is enabled")
                model = self._tracking_model(loaded, tracker_key)
            kwargs = dict(verbose=False, device=device, conf=conf, iou=iou, imgsz=options.imgsz, max_det=options.maxDet)
            if options.nms == "free" and loaded.task_type in TRACKABLE_TASKS and not loaded.info().capabilities.nmsFree:
                raise ValueError("This model cannot switch to an NMS-free head; select auto mode")
            # Always pass None when returning to auto, so an old nms=False does not persist.
            kwargs["nms"] = False if options.nms == "free" and loaded.task_type in TRACKABLE_TASKS else None
            selected_ids = [int(key) for key, name in loaded.names.items() if name in class_filter]
            # Semantic filtering is pixel-level; all other filtering happens in the adapter.
            if loaded.task_type == "semantic":
                kwargs["classes"] = selected_ids if class_filter else None
            fusion = self.depth_model() if loaded.task_type in TRACKABLE_TASKS else None
            if loaded.task_type == "segment":
                kwargs["retina_masks"] = fusion is not None
            t1 = time.perf_counter()
            if track:
                result = model.track(bgr, persist=True, tracker="bytetrack.yaml", **kwargs)[0]
            else:
                result = model.predict(bgr, **kwargs)[0]
            depth_result = None
            if fusion is not None:
                depth_result = fusion.yolo.predict(bgr, verbose=False, device=device, imgsz=options.imgsz)[0]
                if depth_result.depth is None:
                    raise RuntimeError("Auxiliary depth predictor returned no depth map")
            t2 = time.perf_counter()
            height, width = bgr.shape[:2]
            pred, kept = adapt_result(
                result,
                task=loaded.task_type,
                model_id=loaded.id,
                names=loaded.names,
                width=width,
                height=height,
                class_filter=class_filter,
                depth_min=options.depthMin,
                depth_max=options.depthMax,
            )
            if depth_result is not None:
                depth = to_numpy(depth_result.depth.data)
                pred.depth = dense_map(
                    depth,
                    task="depth",
                    model_id=fusion.id,
                    names={},
                    depth_min=options.depthMin,
                    depth_max=options.depthMax,
                )
                fuse_depth(pred, result, kept, depth)
            t3 = time.perf_counter()
            record_latency((t2 - t1) * 1000)
            speed = result.speed or {}
            pred.telemetry = Telemetry(
                preprocessMs=speed.get("preprocess"), inferenceMs=(t2 - t1) * 1000, postprocessMs=(t3 - t2) * 1000
            )
            return pred

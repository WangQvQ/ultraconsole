from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image
from ultralytics import YOLO

from .schemas import (
    PredBBox,
    PredInstanceKeypoints,
    PredKeypoint,
    PredMask,
    PredResponse,
    TaskType,
    Telemetry,
)
from .system_stats import record_latency


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


def _to_numpy(t):
    if t is None:
        return None
    if hasattr(t, "cpu"):
        return t.cpu().numpy()
    return np.asarray(t)


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
        try:
            self._warmup(loaded=loaded, device=device)
        except Exception:
            pass
        with self._lock:
            self._loaded = loaded
        return loaded

    def warmup_current(self, device: str) -> None:
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
        track: bool = False,
        tracker_key: Optional[str] = None,
    ) -> PredResponse:
        """
        单帧推理。
        - track=True 时改用 model.track(persist=True) 启用 ByteTrack。
        - tracker_key：每条流（webcam/rtsp1/rtsp2…）需要独立 tracker 状态时用。
          Ultralytics 的 persist 机制对单 model 实例做全局缓存，多路流共享会串号；
          这里我们走串行 predict_lock，所以不同流之间默认按调用次序累计 id。
          如需严格分离，可在外层维持多份模型副本——v1 暂不实现。
        """
        with self._lock:
            loaded = self._loaded
        if loaded is None:
            raise RuntimeError("No model loaded")

        t0 = time.perf_counter()
        rgb = image.convert("RGB")
        np_img = np.array(rgb)
        t1 = time.perf_counter()
        with self._predict_lock:
            if track:
                results = loaded.yolo.track(
                    np_img,
                    verbose=False,
                    device=device,
                    conf=conf,
                    iou=iou,
                    persist=True,
                    tracker="bytetrack.yaml",
                )
            else:
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
        masks_out: list[PredMask] = []
        kpts_out: list[PredInstanceKeypoints] = []

        # ---- boxes + tracking id ----
        kept_indices: list[int] = []
        kept_classes: list[str] = []
        kept_track_ids: list[Optional[int]] = []
        if getattr(r0, "boxes", None) is not None and r0.boxes is not None:
            boxes = r0.boxes
            xyxy = _to_numpy(boxes.xyxy)
            confs = _to_numpy(boxes.conf)
            clss = _to_numpy(boxes.cls)
            ids = _to_numpy(getattr(boxes, "id", None)) if track else None
            if xyxy is not None and confs is not None and clss is not None:
                for i in range(len(xyxy)):
                    x1, y1, x2, y2 = xyxy[i]
                    c = float(confs[i])
                    cls_id = int(clss[i])
                    cls_key = str(cls_id)
                    cls_name = loaded.names.get(cls_key, cls_key)
                    if class_filter and cls_name not in class_filter:
                        continue
                    tid: Optional[int] = None
                    if ids is not None and i < len(ids):
                        try:
                            tid = int(ids[i])
                        except Exception:
                            tid = None
                    label = f"{cls_name} {c:.2f}" + (f" #{tid}" if tid is not None else "")
                    bboxes.append(
                        PredBBox(
                            cls=cls_name,
                            conf=c,
                            x1=float(x1),
                            y1=float(y1),
                            x2=float(x2),
                            y2=float(y2),
                            label=label,
                            trackId=tid,
                        )
                    )
                    kept_indices.append(i)
                    kept_classes.append(cls_name)
                    kept_track_ids.append(tid)

        # ---- masks (segment) ----
        if loaded.task_type == "segment" and getattr(r0, "masks", None) is not None and r0.masks is not None:
            try:
                # masks.xy 是每个实例的源图像素坐标多边形 (list of (N,2) arrays)
                xy_polys = r0.masks.xy
                for k, idx in enumerate(kept_indices):
                    if idx >= len(xy_polys):
                        continue
                    poly = xy_polys[idx]
                    poly_np = np.asarray(poly)
                    if poly_np.ndim != 2 or poly_np.shape[0] < 3:
                        continue
                    # 简单降采样：>200 点抽稀，传输/绘制更轻
                    if poly_np.shape[0] > 200:
                        step = max(1, poly_np.shape[0] // 200)
                        poly_np = poly_np[::step]
                    points = [[float(p[0]), float(p[1])] for p in poly_np]
                    masks_out.append(
                        PredMask(
                            cls=kept_classes[k],
                            trackId=kept_track_ids[k],
                            points=points,
                        )
                    )
            except Exception:
                pass

        # ---- keypoints (pose) ----
        if loaded.task_type == "pose" and getattr(r0, "keypoints", None) is not None and r0.keypoints is not None:
            try:
                kp = r0.keypoints
                # kp.xy: (N, K, 2); kp.conf: (N, K) or None
                xy = _to_numpy(kp.xy)
                kp_conf = _to_numpy(getattr(kp, "conf", None))
                if xy is not None:
                    for k, idx in enumerate(kept_indices):
                        if idx >= len(xy):
                            continue
                        joints = xy[idx]
                        confs_j = kp_conf[idx] if kp_conf is not None and idx < len(kp_conf) else None
                        pts: list[PredKeypoint] = []
                        for j, (jx, jy) in enumerate(joints):
                            jc = float(confs_j[j]) if confs_j is not None and j < len(confs_j) else None
                            pts.append(PredKeypoint(x=float(jx), y=float(jy), conf=jc))
                        kpts_out.append(
                            PredInstanceKeypoints(
                                cls=kept_classes[k],
                                trackId=kept_track_ids[k],
                                points=pts,
                            )
                        )
            except Exception:
                pass

        t3 = time.perf_counter()
        infer_ms = (t2 - t1) * 1000.0
        record_latency(infer_ms)
        tel = Telemetry(
            preprocessMs=(t1 - t0) * 1000.0,
            inferenceMs=infer_ms,
            postprocessMs=(t3 - t2) * 1000.0,
        )

        return PredResponse(
            ts=time.time(),
            width=w,
            height=h,
            taskType=loaded.task_type,
            bboxes=bboxes,
            masks=masks_out,
            keypoints=kpts_out,
            telemetry=tel,
        )

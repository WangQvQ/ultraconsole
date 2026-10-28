"""Translate Ultralytics Results into the public console contract.

Keep task-specific outputs here, independent of HTTP, WebSocket and model lifecycle.
"""

from __future__ import annotations

import base64
import time
from typing import Any

import cv2
import numpy as np

from .schemas import (
    ModelCapabilities,
    PredBBox,
    PredClassification,
    PredDenseMap,
    PredInstanceKeypoints,
    PredKeypoint,
    PredMask,
    PredResponse,
    TaskType,
)

TRACKABLE_TASKS = frozenset({"detect", "segment", "pose", "obb"})
SUPPORTED_TASKS = TRACKABLE_TASKS | {"classify", "semantic", "depth"}


def capabilities(task: TaskType) -> ModelCapabilities:
    return ModelCapabilities(
        boxes=task in TRACKABLE_TASKS,
        tracking=task in TRACKABLE_TASKS,
        masks=task == "segment",
        keypoints=task == "pose",
        classification=task == "classify",
        semantic=task == "semantic",
        depth=task == "depth",
        nms=task in TRACKABLE_TASKS,
    )


def to_numpy(value: Any) -> np.ndarray:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu().numpy()
    return np.asarray(value)


def dense_map(
    values: Any, *, task: str, model_id: str, names: dict[str, str], depth_min: float, depth_max: float
) -> PredDenseMap:
    array = to_numpy(values)
    if array.ndim != 2 or not array.size:
        raise ValueError(f"Expected a nonempty 2D {task} map, got {array.shape}")
    height, width = array.shape
    scale = min(1.0, 256 / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    stats: dict[str, Any] = {}
    if task == "depth":
        array = array.astype(np.float32)
        valid = np.isfinite(array) & (array > 0)
        selected = array[valid]
        stats = {"validFraction": float(valid.mean()), "colorMin": depth_min, "colorMax": depth_max}
        if selected.size:
            stats.update(min=float(selected.min()), max=float(selected.max()), median=float(np.median(selected)))
        sampled = cv2.resize(array, size, interpolation=cv2.INTER_NEAREST).astype("<f4")
        sample_valid = np.isfinite(sampled) & (sampled > 0)
        normalized = np.zeros_like(sampled)
        normalized[sample_valid] = np.clip((sampled[sample_valid] - depth_min) / (depth_max - depth_min), 0, 1)
        color = cv2.applyColorMap(((1 - normalized) * 255).astype(np.uint8), cv2.COLORMAP_VIRIDIS)
        rgba = cv2.cvtColor(color, cv2.COLOR_BGR2BGRA)
        rgba[..., 3] = sample_valid.astype(np.uint8) * 255
        dtype, unit = "float32", "m"
    else:
        if np.any(array < 0) or np.any(array > 65535):
            raise ValueError("Semantic class IDs must fit uint16")
        sampled = cv2.resize(array.astype(np.float32), size, interpolation=cv2.INTER_NEAREST).astype("<u2")
        # Deterministic colors. 255 is the upstream ignore label.
        ids = sampled.astype(np.uint32)
        rgba = np.stack(
            [
                (ids * 67 + 43) % 200 + 55,
                (ids * 97 + 89) % 200 + 55,
                (ids * 137 + 131) % 200 + 55,
                np.where(ids == 255, 0, 255),
            ],
            axis=-1,
        ).astype(np.uint8)
        dtype, unit = "uint16", "class-id"
    ok, encoded = cv2.imencode(".png", rgba)
    if not ok:
        raise RuntimeError(f"Cannot encode {task} preview")
    return PredDenseMap(
        width=size[0],
        height=size[1],
        dtype=dtype,
        unit=unit,
        modelId=model_id,
        dataBase64=base64.b64encode(sampled.tobytes()).decode("ascii"),
        pngBase64=base64.b64encode(encoded.tobytes()).decode("ascii"),
        classes=names if task == "semantic" else {},
        **stats,
    )


def adapt_result(
    result: Any,
    *,
    task: TaskType,
    model_id: str,
    names: dict[str, str],
    width: int,
    height: int,
    class_filter: list[str],
    depth_min: float,
    depth_max: float,
) -> tuple[PredResponse, list[int]]:
    pred = PredResponse(ts=time.time(), width=width, height=height, taskType=task, modelId=model_id)
    kept: list[int] = []
    boxes = result.obb if task == "obb" else result.boxes
    if boxes is not None:
        xyxy, confs, classes = to_numpy(boxes.xyxy), to_numpy(boxes.conf), to_numpy(boxes.cls)
        track_ids = to_numpy(boxes.id) if boxes.id is not None else None
        corners = to_numpy(boxes.xyxyxyxy) if task == "obb" else None
        for i, (rect, confidence, class_id) in enumerate(zip(xyxy, confs, classes, strict=False)):
            name = names.get(str(int(class_id)), str(int(class_id)))
            if class_filter and name not in class_filter:
                continue
            track_id = int(track_ids[i]) if track_ids is not None else None
            pred.bboxes.append(
                PredBBox(
                    cls=name,
                    conf=float(confidence),
                    x1=float(rect[0]),
                    y1=float(rect[1]),
                    x2=float(rect[2]),
                    y2=float(rect[3]),
                    trackId=track_id,
                    label=f"{name} {confidence:.2f}" + (f" #{track_id}" if track_id is not None else ""),
                    corners=corners[i].tolist() if corners is not None else None,
                )
            )
            kept.append(i)
    if task == "segment" and result.masks is not None:
        for box, i in zip(pred.bboxes, kept, strict=False):
            polygon = np.asarray(result.masks.xy[i])
            if len(polygon) < 3:
                continue
            step = max(1, int(np.ceil(len(polygon) / 200)))
            pred.masks.append(PredMask(cls=box.cls, trackId=box.trackId, points=polygon[::step].tolist()))
    if task == "pose" and result.keypoints is not None:
        xy = to_numpy(result.keypoints.xy)
        conf = to_numpy(result.keypoints.conf) if result.keypoints.conf is not None else None
        for box, i in zip(pred.bboxes, kept, strict=False):
            points = [
                PredKeypoint(x=float(p[0]), y=float(p[1]), conf=float(conf[i, j]) if conf is not None else None)
                for j, p in enumerate(xy[i])
            ]
            pred.keypoints.append(PredInstanceKeypoints(cls=box.cls, trackId=box.trackId, points=points))
    if task == "classify" and result.probs is not None:
        scores = to_numpy(result.probs.data)
        for i in np.argsort(-scores):
            name = names.get(str(int(i)), str(int(i)))
            if not class_filter or name in class_filter:
                pred.classifications.append(PredClassification(cls=name, conf=float(scores[i])))
                if len(pred.classifications) == 5:
                    break
    if task in {"depth", "semantic"}:
        output = result.depth if task == "depth" else result.semantic_mask
        if output is None:
            raise RuntimeError(f"The {task} predictor returned no dense map")
        value = dense_map(
            output.data, task=task, model_id=model_id, names=names, depth_min=depth_min, depth_max=depth_max
        )
        setattr(pred, task, value)
    return pred, kept


def fuse_depth(pred: PredResponse, result: Any, kept: list[int], depth: np.ndarray) -> None:
    """Use source-resolution masks when available; label the box fallback explicitly."""
    if depth.shape != (pred.height, pred.width):
        raise ValueError("Depth and detection results must share original-image coordinates")
    valid = np.isfinite(depth) & (depth > 0)
    masks = (
        to_numpy(result.masks.data).astype(bool) if pred.taskType == "segment" and result.masks is not None else None
    )
    for box, i in zip(pred.bboxes, kept, strict=False):
        if masks is not None:
            mask = masks[i]
            if mask.shape != depth.shape:
                raise ValueError("Fusion requires retina_masks=True at original-image resolution")
            values = depth[mask & valid]
            count = int(mask.sum())
            method = "mask-median"
        else:
            # Center half of the box reduces, but cannot remove, background contamination.
            x1, x2 = np.clip([box.x1, box.x2], 0, pred.width)
            y1, y2 = np.clip([box.y1, box.y2], 0, pred.height)
            left, right = int(x1 + (x2 - x1) * 0.25), int(np.ceil(x2 - (x2 - x1) * 0.25))
            top, bottom = int(y1 + (y2 - y1) * 0.25), int(np.ceil(y2 - (y2 - y1) * 0.25))
            patch, patch_valid = depth[top:bottom, left:right], valid[top:bottom, left:right]
            values, count, method = patch[patch_valid], patch.size, "box-center-median"
        box.depthValidFraction = float(values.size / count) if count else 0.0
        box.depthMethod = method
        if values.size:
            box.depthMeters = float(np.median(values))
            box.label = f"{box.label} · ~{box.depthMeters:.2f} m"

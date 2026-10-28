"""Opt-in real-weight smoke test. No model downloads occur unless --download is supplied."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.infer_runtime import UltralyticsRuntime  # noqa: E402
from app.schemas import Params  # noqa: E402
from PIL import Image  # noqa: E402
from ultralytics.utils import ASSETS  # noqa: E402
from ultralytics.utils.downloads import attempt_download_asset  # noqa: E402

MODELS = {
    "yolov8n.pt": "detect",
    "yolo11n.pt": "detect",
    "yolo26n.pt": "detect",
    "yolo26n-seg.pt": "segment",
    "yolo26n-pose.pt": "pose",
    "yolo26n-cls.pt": "classify",
    "yolo26n-obb.pt": "obb",
    "yolo26n-sem.pt": "semantic",
    "yolo26n-depth.pt": "depth",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", type=Path, default=Path(__file__).resolve().parents[1] / "models")
    parser.add_argument("--models", nargs="+", choices=MODELS, default=list(MODELS))
    parser.add_argument("--image", type=Path, default=ASSETS / "bus.jpg")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--imgsz", type=int, default=320)
    parser.add_argument("--download", action="store_true")
    parser.add_argument(
        "--export-onnx", action="store_true", help="Export and verify ONNX instead of native checkpoints"
    )
    parser.add_argument("--tracking", action="store_true", help="Also verify two tracked frames on box-producing tasks")
    args = parser.parse_args()
    args.models_dir.mkdir(parents=True, exist_ok=True)
    image = Image.open(args.image).convert("RGB")
    runtime = UltralyticsRuntime(str(args.models_dir))
    params = Params(imgsz=args.imgsz)
    for name in args.models:
        path = args.models_dir / name
        if not path.is_file() and args.download:
            attempt_download_asset(path)
        if not path.is_file():
            parser.error(f"Missing {path}; supply the file or explicitly pass --download")
        artifact = name
        if args.export_onnx:
            from ultralytics import YOLO

            artifact = Path(
                YOLO(path).export(format="onnx", imgsz=args.imgsz, simplify=False, opset=17, dynamic=False)
            ).name
        loaded = runtime.load(artifact, args.device)
        if loaded.task_type != MODELS[name]:
            raise AssertionError(f"{name}: expected {MODELS[name]}, got {loaded.task_type}")
        pred = runtime.infer_image(image=image, device=args.device, conf=0.25, iou=0.7, class_filter=[], params=params)
        if pred.taskType == "classify" and not pred.classifications:
            raise AssertionError("No classification result")
        if pred.taskType == "depth" and (pred.depth is None or not pred.depth.validFraction):
            raise AssertionError("No valid depth result")
        if pred.taskType == "semantic" and pred.semantic is None:
            raise AssertionError("No semantic map")
        print(
            json.dumps(
                {
                    "model": artifact,
                    "task": pred.taskType,
                    "boxes": len(pred.bboxes),
                    "masks": len(pred.masks),
                    "poses": len(pred.keypoints),
                    "topK": len(pred.classifications),
                    "depth": pred.depth is not None,
                    "semantic": pred.semantic is not None,
                    "status": "passed",
                }
            ),
            flush=True,
        )
        if args.tracking and loaded.info().capabilities.tracking:
            for _ in range(2):
                tracked = runtime.infer_image(
                    image=image,
                    device=args.device,
                    conf=0.25,
                    iou=0.7,
                    class_filter=[],
                    params=params,
                    track=True,
                    tracker_key="smoke",
                )
                if any(box.trackId is None for box in tracked.bboxes):
                    raise AssertionError("Tracked boxes lost their IDs")
            runtime.release_tracker("smoke")
            print(json.dumps({"model": artifact, "tracking": "passed", "boxes": len(tracked.bboxes)}), flush=True)
    if {"yolo26n-seg.pt", "yolo26n-depth.pt"} <= set(args.models):
        extension = "onnx" if args.export_onnx else "pt"
        runtime.load(f"yolo26n-seg.{extension}", args.device)
        runtime.set_depth_model(f"yolo26n-depth.{extension}", args.device)
        pred = runtime.infer_image(image=image, device=args.device, conf=0.25, iou=0.7, class_filter=[], params=params)
        if not pred.bboxes or not all(
            b.depthMeters is not None and b.depthMethod == "mask-median" for b in pred.bboxes
        ):
            raise AssertionError("Fusion did not produce per-instance mask depth on the sample image")
        print(json.dumps({"fusion": "segment+depth", "objects": len(pred.bboxes), "status": "passed"}), flush=True)


if __name__ == "__main__":
    main()

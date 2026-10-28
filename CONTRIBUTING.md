# Contributing to UltraConsole

欢迎提交问题、复现样例、模型适配和文档改进。Please include enough information for another contributor to reproduce your result.

## Local checks

Use Python 3.10+ in a dedicated virtual environment and Node.js 22.12+.

```bash
python -m pip install -r backend/requirements-dev.txt
python -m ruff check backend/app backend/tests backend/scripts
python -m pytest
cd frontend
npm ci
npm run lint
npm test
npm run build
```

Tests run without downloading model weights. Do not commit weights, camera credentials, real monitoring footage or webhook URLs. Prefer an anonymized BadCase ZIP; it includes the input, prediction, parameters and runtime/model metadata.

To export or run ONNX artifacts, install the optional dependencies with `python -m pip install -r backend/requirements-onnx.txt`. Native CPU/PyTorch use does not require them. ByteTrack's `lap` dependency is included in the base installation.

After placing the corresponding checkpoints in `backend/models/`, import `examples/depth-config.json` or `examples/fusion-config.json` in the console to try standalone depth or segmentation/depth fusion. Example configurations do not enable webhooks or alerts.

## Adding or adapting a task

1. Confirm the public upstream task name and `Results` fields for the pinned Ultralytics release. Use model metadata, not filenames, to determine the loaded task.
2. Extend `backend/app/schemas.py` and `frontend/src/api/contracts.ts` together. Preserve `schemaVersion` compatibility or document a breaking change.
3. Register the task in `SUPPORTED_TASKS` and add result conversion in `backend/app/task_adapters.py`; keep inference/model lifecycle in `infer_runtime.py`. Missing or unsupported outputs must not silently become empty detections.
4. Declare capabilities. Only detect/segment/pose/obb support tracking. Update the controls and both image/video overlays; add Chinese and English strings.
5. Include a focused test using actual Ultralytics `Results` containers, then verify a real checkpoint with the smoke script. Dense data must have bounded transport size, explicit shape/dtype/units and original-image alignment.
6. Document model names, expected outputs and the hardware/formats you actually tested in `docs/compatibility.md`.

## Real model verification (opt-in download)

```bash
python backend/scripts/smoke_models.py --download --device cpu
```

This explicitly downloads nine official nano checkpoints to `backend/models/`, checks YOLOv8/YOLO11 detection and all seven YOLO26 tasks, and checks segmentation + depth fusion. Use `--models yolo26n-depth.pt --imgsz 640` for a narrower check. Without `--download`, missing weights cause a clear error. You may use `--models-dir /path/to/weights` and `--image /path/to/test.jpg`.

Add `--tracking` to check two tracked frames for box-producing tasks. With the ONNX requirements installed, use `--export-onnx --models yolo26n.pt yolo26n-depth.pt yolo26n-sem.pt` to reproduce export/inference checks. These exports use fixed shapes, opset 17 and no simplification; they do not cover every export combination.

CPU results do not establish CUDA, TensorRT or ONNX compatibility. For an export issue include its export command, input dimensions, precision, metadata and runtime version. For a numerical issue include an expected result or a small labeled sample; a screenshot alone does not establish accuracy.

## Pull requests

Describe the concrete problem, resulting behavior and checks you ran. Small PRs focused on one task or one defect are easier to review. Feature ideas can start as an Issue describing the use case and expected inputs/outputs; a complete implementation is not required to contribute.

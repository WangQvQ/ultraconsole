# 模型适配与优化结论 / Model compatibility and depth integration

中文结论：可以保留现有输入、流控和 Canvas 框架，通过统一任务协议补齐七种任务。当前代码已适配官方 8.4.191，并加入独立深度估计与同帧目标深度融合；新增任务的主要扩展入口是 `task_adapters.py`、前后端协议和绘制器。

本轮同时修复 RGB/BGR 边界、未知任务被当作检测、视频强制跟踪、预热失败被吞掉、设备切换失败状态及 RTSP 跨连接跟踪隔离。提供贡献指南、模型验证脚本、配置样例与 Issue/PR 模板，便于社区复现和继续改进。

验证范围：独立环境安装及依赖检查通过；后端 38 项、前端 16 项测试通过；九个官方 nano 权重、三种 ONNX 导出、五个目标的掩膜深度融合及八帧深度视频分析已验证。深度导出与鼠标查询使用采样图；CUDA/TensorRT 和远程 CI 尚未实机执行。以下列出协议、实现边界和可复现证据。

Baseline: **Ultralytics 8.4.191**, checked against the upstream release on **2026-10-28**. Upstream main at `bb3e1550dbb819bd9846d4c99f368aebe8792a0e` was one documentation-only commit ahead.

Sources: [release](https://github.com/ultralytics/ultralytics/releases/tag/v8.4.191), [YOLO26](https://docs.ultralytics.com/models/yolo26), [depth](https://docs.ultralytics.com/tasks/depth), [semantic](https://docs.ultralytics.com/tasks/semantic).

## Supported result contracts

| Task | Example checkpoint | Output | Tracking |
|---|---|---|---|
| detect | yolov8n.pt / yolo11n.pt / yolo26n.pt | boxes, confidence, optional track IDs | Yes |
| segment | yolo26n-seg.pt | boxes and instance polygons | Yes |
| pose | yolo26n-pose.pt | boxes and keypoints | Yes |
| classify | yolo26n-cls.pt | Top-5 classes; class filtering before ranking | No |
| obb | yolo26n-obb.pt | rotated corners plus enclosing boxes for counters | Yes |
| semantic | yolo26n-sem.pt | pixel class map and palette preview | No |
| depth | yolo26n-depth.pt | estimated depth map in meters and fixed-range preview | No |

All five input modes use the same adapters. Video enables tracking only for tasks that carry boxes. Existing pose drawing uses the COCO-17 skeleton; custom keypoint layouts need their own skeleton configuration. Semantic models have their own class IDs, not the detector's COCO labels.

Model listing reports `taskType: null` until inspection. Selecting a model loads it, warms its backend and returns actual task metadata and capabilities. Loading and device changes fail explicitly and preserve the previously selected state. Classification, depth and semantic models never fall back to detection.

The model allowlist remains `.pt`, `.onnx`, `.engine`. Task support does not imply that every task/export/device combination has been verified. Exported models need correct task metadata; fixed input dimensions and export-time postprocessing cannot be changed arbitrarily. The console does not support every model that the upstream package can load (for example SAM prompting is a separate workflow).

## Inference and NMS

`imgsz` is a multiple of 32 between 64 and 2048. `maxDet` is between 1 and 3000. `nms=auto` preserves the upstream default; it does not force NMS-free inference. `nms=free` maps to upstream `nms=False` and is offered for supported native end-to-end checkpoints. Exported artifacts use their exported head. IoU does not tune an NMS-free head.

The pinned NumPy versions have platform markers because current Ultralytics excludes NumPy 2.0–2.2 and early 2.3 versions on macOS. Python 3.10/macOS uses 1.26.4; Python 3.11+/macOS uses 2.3.5; other platforms retain 2.1.1.

## Depth maps and fusion

Select a depth checkpoint as the primary model to inspect a scene, or select it in **Auxiliary depth model** while using a box-producing primary model. Disabling the auxiliary model releases its reference. Depth fusion is a second model invocation on the **same decoded frame**, using the same original-image coordinates; it adds compute and memory cost.

- Segmentation uses original-resolution masks (`retina_masks=True`), excludes nonfinite/nonpositive depth and reports the median inside each instance mask.
- Detection/pose/OBB use the center half of each enclosing box. This is a background-sensitive approximation, explicitly labeled `box-center-median`; it is not a segmentation result.
- Each box includes `depthMeters`, `depthMethod` and `depthValidFraction`. Empty valid regions have `depthMeters: null`.
- Values describe estimated visible-surface depth along the camera axis, not ground-truth distance or an object's 3D center. Released depth checkpoints carry upstream calibration; camera/domain-specific absolute scale still needs validation or calibration.

Dense outputs are nearest-sampled to **at most 256 pixels on the longest side**. `dataBase64` contains row-major little-endian float32 meters or uint16 class IDs; semantic ID 255 is upstream's ignore label. Shape and dtype are explicit. PNG is a display preview. Depth statistics and object fusion use the full-resolution model output, while hover and downloaded **NPY are sampled data**, not the original full-resolution map. Invalid depth values remain in the binary array and are transparent in the preview. The fixed color range clips colors only, never numeric values. Configuration 1.1 preserves model, auxiliary depth model, inference and display options; 1.0 configurations remain importable.

Import [standalone depth](../examples/depth-config.json) or [fusion](../examples/fusion-config.json) after obtaining the named weights. Both examples select CPU and disable alerts; no webhook configuration is included.

## Changes motivated by the audit

The previous code pinned 8.3.162, mapped unknown tasks to detection, discarded four result types, passed RGB arrays through a BGR input interface, forced all video tasks into tracking and swallowed warmup errors. The compatibility update addresses these issues and isolates RTSP tracker keys by connection and worker instance. RTSP image/prediction pairs share one queue item, so queue pressure cannot discard one half of a pair.

## Reproduce verification

Run the checks and optional real-weight smoke command in [CONTRIBUTING.md](../CONTRIBUTING.md). Always report the actual package path/version; an editable local Ultralytics checkout can otherwise mask the pinned dependency. Use a fresh virtual environment for reproducible installation. Hardware-specific results should be documented separately from CPU results.

### Local evidence, 2026-10-28

- Fresh macOS arm64 virtual environment: Python 3.13.11, Ultralytics 8.4.191, torch 2.14.1, torchvision 0.29.1, NumPy 2.3.5, OpenCV 4.11.0.86, FastAPI 0.115.14, Pydantic 2.11.7 and lap 0.5.13. Installation and `pip check` passed.
- Backend: 38 tests passed, including all seven actual `Results` containers, REST selection/inference, numeric transport, filtering alignment, fusion, RTSP frame/prediction pairing and connection isolation, and state-preserving failures. Ruff passed. An upstream Starlette/AnyIO deprecation warning remains in the test environment.
- Frontend: 16 tests, ESLint and production build passed. NPY header/values and preserving non-tracking video requests are covered.
- Native checkpoints: nine nano weights listed above passed CPU inference. Two tracked frames passed for box tasks. The street-scene sample produced no OBB detections, so its OBB smoke run verifies the executable path, not positive rotated-object tracking accuracy; rotated result geometry is covered by a positive result-container fixture.
- Segmentation/depth fusion produced five mask-median object estimates on the bundled `bus.jpg` sample. This verifies integration and alignment, not depth accuracy against ground truth.
- ONNX: YOLO26n detection, depth and semantic exports passed CPU inference at fixed 320 × 320, opset 17, no simplification. This check used torch 2.12.0, ONNX 1.23.2 and ONNX Runtime 1.23.2.
- Browser depth overlay, sampled hover and NPY download were exercised; the downloaded map was loaded independently with NumPy as float32 with shape 256 × 192.
- A one-second local video completed eight sequential depth samples through the browser/WebSocket path, with tracking disabled and no counting events. Switching a native YOLO26 detector from NMS-free back to auto also passed real inference (six and five detections respectively on the sample).
- Both example configurations were imported through the browser (eight settings groups applied each); primary model, auxiliary model and inference parameters were checked against the backend session state.

CUDA, TensorRT engines, other export combinations and the remote CI matrix have **not** been executed locally. CI is configured for Linux/Python 3.10 and 3.12, and macOS/Python 3.12; that configuration is not a claim of a completed remote run.

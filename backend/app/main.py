from __future__ import annotations

import asyncio
import base64
import os
import threading
import time
from typing import Any, Optional, Dict

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from PIL import Image

from .infer_runtime import UltralyticsRuntime
from .schemas import (
    ModelInfo,
    Params,
    PredResponse,
    SelectEngineRequest,
    SelectModelRequest,
    UpdateParamsRequest,
)
from .state import AppState


MODELS_DIR = os.environ.get("ULTRA_MODELS_DIR", os.path.join(os.getcwd(), "models"))

app = FastAPI(title="Ultralytics Infer Console API", version="0.1.0")
state = AppState()
runtime = UltralyticsRuntime(models_dir=MODELS_DIR)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _device_str(device: str) -> str:
    return "cuda" if device == "cuda" else "cpu"


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "ts": time.time()}


@app.get("/api/models", response_model=list[ModelInfo])
def list_models() -> list[ModelInfo]:
    items = runtime.list_models()
    out: list[ModelInfo] = []
    for model_id, _path in items:
        out.append(
            ModelInfo(
                id=model_id,
                filename=model_id,
                taskType="detect",
                names={},
            )
        )

    # 如果当前已加载，则回填真实信息
    cur = runtime.current()
    if cur is not None:
        for i in range(len(out)):
            if out[i].id == cur.id:
                out[i] = ModelInfo(id=cur.id, filename=cur.filename, taskType=cur.task_type, names=cur.names)
                break
        else:
            out.insert(0, ModelInfo(id=cur.id, filename=cur.filename, taskType=cur.task_type, names=cur.names))
    return out


@app.post("/api/models/select", response_model=ModelInfo)
def select_model(req: SelectModelRequest) -> ModelInfo:
    with state.lock:
        state.logs.append(level="INFO", event="model.select", msg=f"Selecting model: {req.modelId}")
        try:
            loaded = runtime.load(req.modelId, device=_device_str(state.engine.device))
            state.model_id = loaded.id
            state.logs.append(level="INFO", event="model.loaded", msg=f"Loaded model: {loaded.id}", fields={"task": loaded.task_type})
            return ModelInfo(id=loaded.id, filename=loaded.filename, taskType=loaded.task_type, names=loaded.names)
        except Exception as e:
            state.logs.append(level="ERROR", event="model.load_failed", msg=str(e), fields={"modelId": req.modelId})
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/engine/select")
def select_engine(req: SelectEngineRequest) -> dict[str, Any]:
    with state.lock:
        state.engine.device = req.device
        state.engine.warming = True
        state.logs.append(level="INFO", event="engine.select", msg=f"Switching engine: {req.device}")

        # 轻量 warmup：如有模型则触发一次 warmup
        cur = runtime.current()
        if cur is not None:
            try:
                runtime.load(cur.id, device=_device_str(req.device))
            except Exception as e:
                state.logs.append(level="WARN", event="engine.warmup_failed", msg=str(e))

        state.engine.warming = False
    return {"ok": True, "device": req.device, "warming": False}


@app.get("/api/params", response_model=Params)
def get_params() -> Params:
    return state.params


@app.post("/api/params", response_model=Params)
def update_params(req: UpdateParamsRequest) -> Params:
    with state.lock:
        state.params = Params(conf=req.conf, iou=req.iou, classFilter=req.classFilter)
        state.logs.append(level="INFO", event="params.update", msg="Updated params", fields=state.params.model_dump())
        return state.params


@app.post("/api/infer/image", response_model=PredResponse)
async def infer_image(file: UploadFile = File(...)) -> PredResponse:
    cur = runtime.current()
    if cur is None:
        raise HTTPException(status_code=400, detail="No model loaded. Put weights into backend/models and select a model.")

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"Unsupported content-type: {file.content_type}")

    raw = await file.read()
    try:
        img = Image.open(io_bytes(raw))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    p = state.params
    t0 = time.time()
    try:
        pred = runtime.infer_image(
            image=img,
            device=_device_str(state.engine.device),
            conf=p.conf,
            iou=p.iou,
            class_filter=p.classFilter,
        )
        state.logs.append(level="INFO", event="infer.image", msg="Image inferred", fields={"dtMs": int((time.time() - t0) * 1000)})
        return pred
    except Exception as e:
        state.logs.append(level="ERROR", event="infer.image_failed", msg=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/infer/frame", response_model=PredResponse)
async def infer_frame(file: UploadFile = File(...)) -> PredResponse:
    """
    Video 抽帧推理专用：允许 image/jpeg（以及其它 image/*），返回 PredResponse。
    """
    return await infer_image(file=file)


@app.get("/api/logs/export.csv")
def export_logs_csv() -> PlainTextResponse:
    csv_text = state.logs.export_csv()
    return PlainTextResponse(csv_text, media_type="text/csv")


def io_bytes(b: bytes):
    import io

    return io.BytesIO(b)


@app.websocket("/ws/infer")
async def ws_infer(ws: WebSocket):
    await ws.accept()
    state.logs.append(level="INFO", event="ws.connect", msg="Client connected")

    latest_frame: Optional[Dict[str, Any]] = None
    processing = False
    last_pred_perf: Optional[float] = None

    async def send_log(level: str, event: str, msg: str, fields: Optional[Dict[str, Any]] = None):
        entry = state.logs.append(level=level, event=event, msg=msg, fields=fields or {})
        await ws.send_json({"type": "log", **entry.model_dump()})

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "params":
                # V1：仅记录，不强制覆盖全局 params（避免多人连接互相覆盖）
                await send_log("INFO", "ws.params", "Received params override")
                continue

            if mtype != "frame":
                continue

            latest_frame = msg
            if processing:
                continue

            processing = True
            while latest_frame is not None:
                frame = latest_frame
                latest_frame = None

                cur = runtime.current()
                if cur is None:
                    await send_log("ERROR", "infer.no_model", "No model loaded")
                    continue

                frame_id = str(frame.get("frameId", ""))
                ts = float(frame.get("ts", time.time()))
                b64 = frame.get("imageJpegBase64")
                if not b64:
                    continue

                try:
                    raw = base64.b64decode(b64)
                    img = Image.open(io_bytes(raw))
                    p = state.params
                    pred = runtime.infer_image(
                        image=img,
                        device=_device_str(state.engine.device),
                        conf=float(frame.get("conf", p.conf)),
                        iou=float(frame.get("iou", p.iou)),
                        class_filter=list(frame.get("classFilter", p.classFilter)),
                    )
                    now_perf = time.perf_counter()
                    if last_pred_perf is not None:
                        dt = max(1e-6, now_perf - last_pred_perf)
                        pred.telemetry.fps = 1.0 / dt
                    last_pred_perf = now_perf
                    pred.frameId = frame_id
                    pred.ts = ts
                    await ws.send_json({"type": "pred", **pred.model_dump()})
                except Exception as e:
                    await send_log("ERROR", "infer.ws_failed", str(e), {"frameId": frame_id})

            processing = False
    except WebSocketDisconnect:
        state.logs.append(level="INFO", event="ws.disconnect", msg="Client disconnected")
    except Exception as e:
        state.logs.append(level="ERROR", event="ws.crash", msg=str(e))


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """
    RTSP 推流通道：前端发送 rtsp.start/rtsp.stop，服务端推送 frame+pred+log。
    """
    await ws.accept()
    loop = asyncio.get_running_loop()

    stop_event = threading.Event()
    worker: Optional[threading.Thread] = None

    async def send_log(level: str, event: str, msg: str, fields: Optional[Dict[str, Any]] = None):
        entry = state.logs.append(level=level, event=event, msg=msg, fields=fields or {})
        await ws.send_json({"type": "log", **entry.model_dump()})

    def start_rtsp_worker(url: str, fps: float, conf: float, iou: float, class_filter: list[str]):
        nonlocal worker

        def run():
            def safe_submit(coro):
                fut = asyncio.run_coroutine_threadsafe(coro, loop)
                # swallow exceptions (e.g. ws closed)
                fut.add_done_callback(lambda f: f.exception())

            cap = cv2.VideoCapture(url)
            if not cap.isOpened():
                safe_submit(send_log("ERROR", "rtsp.open_failed", "Failed to open RTSP", {"url": url}))
                return

            safe_submit(send_log("INFO", "rtsp.opened", "RTSP opened", {"url": url}))

            min_interval = 1.0 / max(1.0, float(fps))
            last_sent = 0.0
            frame_seq = 0
            last_pred_perf: Optional[float] = None

            while not stop_event.is_set():
                ok, frame = cap.read()
                if not ok or frame is None:
                    asyncio.run_coroutine_threadsafe(
                        send_log("ERROR", "rtsp.read_failed", "RTSP read failed", {"url": url}),
                        loop,
                    )
                    break

                now = time.time()
                if now - last_sent < min_interval:
                    continue
                last_sent = now

                h, w = frame.shape[:2]
                # JPEG encode (BGR)
                ok2, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok2:
                    continue
                jpeg_bytes = buf.tobytes()
                jpeg_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
                frame_id = str(frame_seq)
                frame_seq += 1

                # send frame first
                safe_submit(
                    ws.send_json(
                        {
                            "type": "frame",
                            "frameId": frame_id,
                            "ts": now,
                            "imageJpegBase64": jpeg_b64,
                            "width": int(w),
                            "height": int(h),
                        }
                    ),
                )

                cur = runtime.current()
                if cur is None:
                    safe_submit(send_log("ERROR", "infer.no_model", "No model loaded"))
                    continue

                try:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    img = Image.fromarray(np.asarray(rgb))
                    pred = runtime.infer_image(
                        image=img,
                        device=_device_str(state.engine.device),
                        conf=conf,
                        iou=iou,
                        class_filter=class_filter,
                    )
                    now_perf = time.perf_counter()
                    if last_pred_perf is not None:
                        dt = max(1e-6, now_perf - last_pred_perf)
                        pred.telemetry.fps = 1.0 / dt
                    last_pred_perf = now_perf
                    pred.frameId = frame_id
                    pred.ts = now
                    safe_submit(ws.send_json({"type": "pred", **pred.model_dump()}))
                except Exception as e:
                    safe_submit(send_log("ERROR", "infer.rtsp_failed", str(e), {"frameId": frame_id}))

            cap.release()
            safe_submit(send_log("INFO", "rtsp.stopped", "RTSP stopped"))

        # stop previous
        if worker is not None and worker.is_alive():
            stop_event.set()
            worker.join(timeout=2)
            stop_event.clear()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "rtsp.start":
                url = str(msg.get("url", "")).strip()
                if not url:
                    await send_log("ERROR", "rtsp.invalid", "Empty url")
                    continue

                p = state.params
                fps = float(msg.get("fps", 10))
                conf = float(msg.get("conf", p.conf))
                iou = float(msg.get("iou", p.iou))
                class_filter = list(msg.get("classFilter", p.classFilter))
                start_rtsp_worker(url=url, fps=fps, conf=conf, iou=iou, class_filter=class_filter)
                continue

            if mtype == "rtsp.stop":
                stop_event.set()
                if worker is not None:
                    worker.join(timeout=2)
                stop_event.clear()
                await send_log("INFO", "rtsp.stop", "Stopped by client")
                continue

    except WebSocketDisconnect:
        stop_event.set()
        if worker is not None:
            worker.join(timeout=2)
        state.logs.append(level="INFO", event="ws.stream.disconnect", msg="Client disconnected")
    except Exception as e:
        stop_event.set()
        if worker is not None:
            worker.join(timeout=2)
        state.logs.append(level="ERROR", event="ws.stream.crash", msg=str(e))

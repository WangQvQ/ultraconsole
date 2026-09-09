from __future__ import annotations

import asyncio
import base64
import io
import json
import math
import os
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from PIL import Image

from .config import settings
from .infer_runtime import UltralyticsRuntime
from .schemas import (
    ModelInfo,
    Params,
    PredResponse,
    SelectEngineRequest,
    SelectModelRequest,
    SystemStats,
    UpdateParamsRequest,
)
from .security import require_http_auth, require_ws_auth, validate_rtsp_url
from .state import AppState
from .system_stats import system_stats
from .webhook import NotifyRequest, NotifyResult, WebhookConfig
from .webhook import manager as webhook_manager

_DEFAULT_MODELS_DIR = str(Path(__file__).resolve().parent.parent / "models")
MODELS_DIR = os.environ.get("ULTRA_MODELS_DIR", _DEFAULT_MODELS_DIR)
_MODELS_DIR_REAL = os.path.realpath(MODELS_DIR)
_VALID_MODEL_EXTS = (".pt", ".onnx", ".engine")


def _validated_model_id(model_id: str) -> str:
    """防路径穿越：只允许 models 目录直接子文件，且后缀合法。"""
    fn = os.path.basename(model_id or "")
    if not fn or fn != model_id:
        raise ValueError(f"Invalid modelId: {model_id!r}")
    if not fn.endswith(_VALID_MODEL_EXTS):
        raise ValueError(f"Unsupported model extension: {fn}")
    full = os.path.realpath(os.path.join(_MODELS_DIR_REAL, fn))
    if os.path.dirname(full) != _MODELS_DIR_REAL:
        raise ValueError(f"Model path escapes models dir: {model_id!r}")
    return fn

app = FastAPI(title="Ultralytics Infer Console API", version="0.1.0")
state = AppState()
runtime = UltralyticsRuntime(models_dir=MODELS_DIR, max_tracker_contexts=settings.max_tracker_contexts)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=bool(settings.api_token),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path != "/api/health" and request.method != "OPTIONS":
        try:
            require_http_auth(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


def _device_str(device: str) -> str:
    return "cuda" if device == "cuda" else "cpu"


def _redacted_stream_url(url: str) -> str:
    """日志中保留协议/主机/端口，移除 RTSP 用户名、密码、路径和查询参数。"""
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, "", "", ""))


def _pack_stream_frame(*, stream_id: str, frame_id: str, ts: float, width: int, height: int, jpeg: bytes) -> bytes:
    header = json.dumps(
        {"type": "frame", "streamId": stream_id, "frameId": frame_id, "ts": ts, "width": width, "height": height},
        separators=(",", ":"),
    ).encode("utf-8")
    return struct.pack("!I", len(header)) + header + jpeg


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

    # 如果当前已加载，则回填真实信息（taskType / names）
    cur = runtime.current()
    if cur is not None:
        for i, m in enumerate(out):
            if m.id == cur.id:
                out[i] = ModelInfo(id=cur.id, filename=cur.filename, taskType=cur.task_type, names=cur.names)
                break
    return out


@app.post("/api/models/select", response_model=ModelInfo)
async def select_model(req: SelectModelRequest) -> ModelInfo:
    state.logs.append(level="INFO", event="model.select", msg=f"Selecting model: {req.modelId}")
    try:
        model_id = _validated_model_id(req.modelId)
    except ValueError as e:
        state.logs.append(level="ERROR", event="model.invalid", msg=str(e), fields={"modelId": req.modelId})
        raise HTTPException(status_code=400, detail=str(e)) from e

    device = _device_str(state.engine.device)
    try:
        loaded = await asyncio.to_thread(runtime.load, model_id, device)
    except Exception as e:
        state.logs.append(level="ERROR", event="model.load_failed", msg=str(e), fields={"modelId": model_id})
        raise HTTPException(status_code=400, detail=str(e)) from e

    with state.lock:
        state.model_id = loaded.id
    state.logs.append(level="INFO", event="model.loaded", msg=f"Loaded model: {loaded.id}", fields={"task": loaded.task_type})
    return ModelInfo(id=loaded.id, filename=loaded.filename, taskType=loaded.task_type, names=loaded.names)


@app.post("/api/engine/select")
async def select_engine(req: SelectEngineRequest) -> dict[str, Any]:
    with state.lock:
        same = state.engine.device == req.device
        state.engine.device = req.device
        state.engine.warming = not same
    state.logs.append(level="INFO", event="engine.select", msg=f"Switching engine: {req.device}")

    if not same:
        cur = runtime.current()
        if cur is not None:
            try:
                # 仅 warmup（不重 load 权重）：用目标 device 跑一次空推理
                await asyncio.to_thread(runtime.warmup_current, _device_str(req.device))
            except Exception as e:
                state.logs.append(level="WARN", event="engine.warmup_failed", msg=str(e))
        with state.lock:
            state.engine.warming = False

    return {"ok": True, "device": req.device, "warming": False}


@app.get("/api/params", response_model=Params)
def get_params() -> Params:
    return state.params


@app.post("/api/params", response_model=Params)
def update_params(req: UpdateParamsRequest) -> Params:
    with state.lock:
        state.params = Params(conf=req.conf, iou=req.iou, classFilter=req.classFilter, track=req.track)
        state.logs.append(level="INFO", event="params.update", msg="Updated params", fields=state.params.model_dump())
        return state.params


@app.get("/api/system/stats", response_model=SystemStats)
def api_system_stats() -> SystemStats:
    return system_stats()


# ---- Webhook 配置 + 派发 ----

@app.get("/api/webhook", response_model=WebhookConfig)
def api_webhook_get() -> WebhookConfig:
    return webhook_manager().get()


@app.post("/api/webhook", response_model=WebhookConfig)
def api_webhook_set(cfg: WebhookConfig) -> WebhookConfig:
    saved = webhook_manager().set(cfg)
    state.logs.append(level="INFO", event="webhook.config", msg="Webhook config updated", fields=saved.model_dump())
    return saved


@app.post("/api/webhook/test", response_model=NotifyResult)
async def api_webhook_test() -> NotifyResult:
    req = NotifyRequest(
        kind="test",
        level="INFO",
        title="Webhook 测试",
        msg="UltraConsole webhook 联通性测试。",
        fields={"source": "ultraconsole"},
    )
    res = await asyncio.to_thread(webhook_manager().dispatch, req)
    state.logs.append(
        level="INFO" if res.ok else "WARN",
        event="webhook.test",
        msg=f"test ok={res.ok}",
        fields=res.model_dump(),
    )
    return res


@app.post("/api/notify", response_model=NotifyResult)
async def api_notify(req: NotifyRequest) -> NotifyResult:
    res = await asyncio.to_thread(webhook_manager().dispatch, req)
    if res.ok:
        state.logs.append(
            level="INFO",
            event="notify.sent",
            msg=f"{req.kind} -> webhook",
            fields={"kind": req.kind, "level": req.level, "ref": req.ref, "httpStatus": res.httpStatus},
        )
    elif not res.skipped:
        state.logs.append(
            level="WARN",
            event="notify.failed",
            msg=res.reason or "unknown",
            fields={"kind": req.kind, "level": req.level, "ref": req.ref},
        )
    return res


def _decode_image(raw: bytes) -> Image.Image:
    if len(raw) > settings.max_upload_bytes:
        raise ValueError(f"Image exceeds {settings.max_upload_bytes} bytes")
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    img = Image.open(io.BytesIO(raw))
    if img.width <= 0 or img.height <= 0 or img.width * img.height > settings.max_image_pixels:
        raise ValueError(f"Image exceeds {settings.max_image_pixels} pixels")
    img.load()
    return img


async def _read_upload_limited(file: UploadFile) -> bytes:
    content_length = file.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.max_upload_bytes:
                raise HTTPException(status_code=413, detail="Image upload is too large")
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="Image upload is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _run_infer(
    image: Image.Image,
    conf: float,
    iou: float,
    class_filter: list[str],
    track: bool = False,
    tracker_key: str | None = None,
) -> PredResponse:
    return runtime.infer_image(
        image=image,
        device=_device_str(state.engine.device),
        conf=conf,
        iou=iou,
        class_filter=class_filter,
        track=track,
        tracker_key=tracker_key,
    )


@app.post("/api/infer/image", response_model=PredResponse)
async def infer_image(file: Annotated[UploadFile, File()]) -> PredResponse:
    cur = runtime.current()
    if cur is None:
        raise HTTPException(status_code=400, detail="No model loaded. Put weights into backend/models and select a model.")

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"Unsupported content-type: {file.content_type}")

    raw = await _read_upload_limited(file)
    try:
        img = await asyncio.to_thread(_decode_image, raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}") from e

    p = state.params
    t0 = time.time()
    try:
        pred = await asyncio.to_thread(_run_infer, img, p.conf, p.iou, list(p.classFilter), p.track, "rest-frame")
        state.logs.append(level="INFO", event="infer.image", msg="Image inferred", fields={"dtMs": int((time.time() - t0) * 1000)})
        return pred
    except Exception as e:
        state.logs.append(level="ERROR", event="infer.image_failed", msg=str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/infer/frame", response_model=PredResponse)
async def infer_frame(file: Annotated[UploadFile, File()]) -> PredResponse:
    """Video 抽帧推理专用：允许 image/jpeg（以及其它 image/*），返回 PredResponse。"""
    return await infer_image(file=file)


@app.get("/api/logs/export.csv")
def export_logs_csv() -> PlainTextResponse:
    csv_text = state.logs.export_csv()
    return PlainTextResponse(csv_text, media_type="text/csv")


@app.websocket("/ws/infer")
async def ws_infer(ws: WebSocket):
    authorized, subprotocol = await require_ws_auth(ws)
    if not authorized:
        return
    await ws.accept(subprotocol=subprotocol)
    state.logs.append(level="INFO", event="ws.connect", msg="Client connected")
    tracker_key = f"ws-infer:{uuid.uuid4().hex}"
    latest_frame: dict[str, Any] | None = None
    frame_ready = asyncio.Event()
    outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=8)
    last_pred_perf: float | None = None
    no_model_logged = False

    def enqueue(payload: dict[str, Any]) -> None:
        if outbound.full():
            try:
                outbound.get_nowait()
            except asyncio.QueueEmpty:
                pass
        outbound.put_nowait(payload)

    def send_log(level: str, event: str, msg: str, fields: dict[str, Any] | None = None) -> None:
        entry = state.logs.append(level=level, event=event, msg=msg, fields=fields or {})
        enqueue({"type": "log", **entry.model_dump()})

    async def reader() -> None:
        nonlocal latest_frame
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "ping":
                enqueue({"type": "pong", "ts": time.time()})
                continue
            if mtype == "params":
                continue
            if mtype != "frame":
                continue
            b64 = msg.get("imageJpegBase64")
            if not isinstance(b64, str) or not b64:
                send_log("WARN", "infer.invalid_frame", "Missing JPEG payload")
                continue
            if len(b64) > settings.max_ws_base64_chars:
                send_log("WARN", "infer.frame_too_large", "WebSocket frame rejected")
                continue
            # Queue size 1：新帧直接覆盖尚未处理的旧帧。
            latest_frame = msg
            frame_ready.set()

    async def infer_worker() -> None:
        nonlocal latest_frame, last_pred_perf, no_model_logged
        while True:
            await frame_ready.wait()
            while latest_frame is not None:
                frame = latest_frame
                latest_frame = None
                frame_ready.clear()

                cur = runtime.current()
                if cur is None:
                    if not no_model_logged:
                        send_log("ERROR", "infer.no_model", "No model loaded")
                        no_model_logged = True
                    continue
                no_model_logged = False

                frame_id = str(frame.get("frameId", ""))
                ts = float(frame.get("ts", time.time()))
                b64 = str(frame["imageJpegBase64"])

                try:
                    raw = base64.b64decode(b64, validate=True)
                    img = await asyncio.to_thread(_decode_image, raw)
                    p = state.params
                    frame_params = Params(
                        conf=frame.get("conf", p.conf),
                        iou=frame.get("iou", p.iou),
                        classFilter=frame.get("classFilter", p.classFilter),
                        track=frame.get("track", p.track),
                    )
                    pred = await asyncio.to_thread(
                        _run_infer,
                        img,
                        frame_params.conf,
                        frame_params.iou,
                        list(frame_params.classFilter),
                        frame_params.track,
                        tracker_key,
                    )
                    now_perf = time.perf_counter()
                    if last_pred_perf is not None:
                        dt = max(1e-6, now_perf - last_pred_perf)
                        pred.telemetry.fps = 1.0 / dt
                    last_pred_perf = now_perf
                    pred.frameId = frame_id
                    pred.ts = ts
                    enqueue({"type": "pred", **pred.model_dump()})
                except Exception as e:
                    send_log("ERROR", "infer.ws_failed", str(e), {"frameId": frame_id})

    async def sender() -> None:
        while True:
            await ws.send_json(await outbound.get())

    tasks = [asyncio.create_task(reader()), asyncio.create_task(infer_worker()), asyncio.create_task(sender())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        state.logs.append(level="INFO", event="ws.disconnect", msg="Client disconnected")
    except Exception as e:
        state.logs.append(level="ERROR", event="ws.crash", msg=str(e))
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        runtime.release_tracker(tracker_key)


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """
    RTSP 推流通道（多路）：
    - 前端发 {type: 'rtsp.start', streamId, url, fps, conf, iou, classFilter, track}
    - 服务端为每个 streamId 起独立 worker，frame/pred/log 消息都带 streamId
    - {type: 'rtsp.stop', streamId} 单路停止；{type: 'rtsp.stopAll'} 全停。
    - 不带 streamId 的旧客户端按 '__default__' 兼容。
    """
    authorized, subprotocol = await require_ws_auth(ws)
    if not authorized:
        return
    await ws.accept(subprotocol=subprotocol)
    loop = asyncio.get_running_loop()

    streams: dict[str, dict[str, Any]] = {}  # streamId -> {"thread": Thread, "stop": Event}
    streams_lock = threading.Lock()
    outbound: asyncio.Queue[dict[str, Any] | bytes] = asyncio.Queue(maxsize=settings.max_rtsp_streams * 2 + 16)

    def enqueue(payload: dict[str, Any] | bytes) -> None:
        if outbound.full():
            try:
                outbound.get_nowait()
            except asyncio.QueueEmpty:
                pass
        outbound.put_nowait(payload)

    def submit(payload: dict[str, Any] | bytes) -> None:
        try:
            loop.call_soon_threadsafe(enqueue, payload)
        except RuntimeError:
            pass

    def send_log(level: str, event: str, msg: str, stream_id: str | None = None, fields: dict[str, Any] | None = None) -> None:
        entry = state.logs.append(level=level, event=event, msg=msg, fields=fields or {})
        payload = {"type": "log", **entry.model_dump()}
        if stream_id is not None:
            payload["streamId"] = stream_id
        submit(payload)

    async def sender() -> None:
        while True:
            payload = await outbound.get()
            if isinstance(payload, bytes):
                await ws.send_bytes(payload)
            else:
                await ws.send_json(payload)

    def stop_stream(stream_id: str, *, join_timeout: float = 2.0) -> None:
        with streams_lock:
            entry = streams.pop(stream_id, None)
        if not entry:
            return
        ev: threading.Event = entry["stop"]
        th: threading.Thread = entry["thread"]
        ev.set()
        if th.is_alive():
            th.join(timeout=join_timeout)
        runtime.release_tracker(f"rtsp:{stream_id}")

    def stop_all_streams() -> None:
        with streams_lock:
            ids = list(streams.keys())
        for sid in ids:
            stop_stream(sid)

    def start_rtsp_worker(
        stream_id: str,
        url: str,
        fps: float,
        conf: float,
        iou: float,
        class_filter: list[str],
        track: bool,
    ):
        stop_ev = threading.Event()

        def run():
            safe_url = _redacted_stream_url(url)
            cap = cv2.VideoCapture()
            if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5_000)
            if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5_000)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            cap.open(url)
            if not cap.isOpened():
                send_log("ERROR", "rtsp.open_failed", "Failed to open RTSP", stream_id, {"url": safe_url})
                return

            send_log("INFO", "rtsp.opened", "RTSP opened", stream_id, {"url": safe_url})

            min_interval = 1.0 / max(1.0, float(fps))
            last_sent = 0.0
            frame_seq = 0
            last_pred_perf: float | None = None

            try:
                while not stop_ev.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        send_log("ERROR", "rtsp.read_failed", "RTSP read failed", stream_id, {"url": safe_url})
                        break

                    now = time.time()
                    if now - last_sent < min_interval:
                        continue
                    last_sent = now

                    h, w = frame.shape[:2]
                    ok2, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                    if not ok2:
                        continue
                    jpeg_bytes = buf.tobytes()
                    frame_id = str(frame_seq)
                    frame_seq += 1

                    submit(
                        _pack_stream_frame(
                            stream_id=stream_id,
                            frame_id=frame_id,
                            ts=now,
                            width=int(w),
                            height=int(h),
                            jpeg=jpeg_bytes,
                        )
                    )

                    cur = runtime.current()
                    if cur is None:
                        send_log("ERROR", "infer.no_model", "No model loaded; stopping RTSP", stream_id)
                        break

                    try:
                        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        img = Image.fromarray(np.asarray(rgb))
                        pred = runtime.infer_image(
                            image=img,
                            device=_device_str(state.engine.device),
                            conf=conf,
                            iou=iou,
                            class_filter=class_filter,
                            track=track,
                            tracker_key=f"rtsp:{stream_id}",
                        )
                        now_perf = time.perf_counter()
                        if last_pred_perf is not None:
                            dt = max(1e-6, now_perf - last_pred_perf)
                            pred.telemetry.fps = 1.0 / dt
                        last_pred_perf = now_perf
                        pred.frameId = frame_id
                        pred.ts = now
                        payload = {"type": "pred", "streamId": stream_id, **pred.model_dump()}
                        submit(payload)
                    except Exception as e:
                        send_log("ERROR", "infer.rtsp_failed", str(e), stream_id, {"frameId": frame_id})
            finally:
                cap.release()
                runtime.release_tracker(f"rtsp:{stream_id}")
                send_log("INFO", "rtsp.stopped", "RTSP stopped", stream_id)
                with streams_lock:
                    cur_entry = streams.get(stream_id)
                    if cur_entry is not None and cur_entry.get("stop") is stop_ev:
                        streams.pop(stream_id, None)

        thread = threading.Thread(target=run, daemon=True)
        with streams_lock:
            streams[stream_id] = {"thread": thread, "stop": stop_ev}
        thread.start()

    sender_task = asyncio.create_task(sender())
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "ping":
                enqueue({"type": "pong", "ts": time.time()})
                continue
            if mtype == "rtsp.start":
                url = str(msg.get("url", "")).strip()
                stream_id = str(msg.get("streamId") or "__default__")
                if len(stream_id) > 64 or not stream_id.replace("_", "").replace("-", "").isalnum():
                    send_log("ERROR", "rtsp.invalid", "Invalid streamId")
                    continue
                try:
                    validate_rtsp_url(url)
                    p = state.params
                    fps = float(msg.get("fps", 10))
                    if not math.isfinite(fps) or fps < 1 or fps > settings.max_rtsp_fps:
                        raise ValueError(f"fps must be between 1 and {settings.max_rtsp_fps}")
                    stream_params = Params(
                        conf=msg.get("conf", p.conf),
                        iou=msg.get("iou", p.iou),
                        classFilter=msg.get("classFilter", p.classFilter),
                        track=msg.get("track", p.track),
                    )
                except Exception as exc:
                    send_log("ERROR", "rtsp.invalid", str(exc), stream_id)
                    continue
                with streams_lock:
                    is_new = stream_id not in streams
                    at_capacity = is_new and len(streams) >= settings.max_rtsp_streams
                if at_capacity:
                    send_log("ERROR", "rtsp.limit", f"Maximum {settings.max_rtsp_streams} streams", stream_id)
                    continue
                await asyncio.to_thread(stop_stream, stream_id)
                start_rtsp_worker(
                    stream_id=stream_id,
                    url=url,
                    fps=fps,
                    conf=stream_params.conf,
                    iou=stream_params.iou,
                    class_filter=list(stream_params.classFilter), track=stream_params.track,
                )
                continue

            if mtype == "rtsp.stop":
                stream_id = str(msg.get("streamId") or "__default__")
                await asyncio.to_thread(stop_stream, stream_id)
                send_log("INFO", "rtsp.stop", "Stopped by client", stream_id)
                continue

            if mtype == "rtsp.stopAll":
                await asyncio.to_thread(stop_all_streams)
                send_log("INFO", "rtsp.stopAll", "All streams stopped")
                continue

    except WebSocketDisconnect:
        await asyncio.to_thread(stop_all_streams)
        state.logs.append(level="INFO", event="ws.stream.disconnect", msg="Client disconnected")
    except Exception as e:
        await asyncio.to_thread(stop_all_streams)
        state.logs.append(level="ERROR", event="ws.stream.crash", msg=str(e))
    finally:
        sender_task.cancel()
        await asyncio.gather(sender_task, return_exceptions=True)

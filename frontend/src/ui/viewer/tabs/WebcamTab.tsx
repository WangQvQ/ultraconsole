import { useEffect, useMemo, useRef, useState } from 'react'
import { wsInferUrl, type WsLogMessage, type WsPredMessage } from '../../../api/client'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { downloadBadCaseZip } from '../../../utils/badcase'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { TelemetryHUD } from '../widgets/TelemetryHUD'
import { VideoCanvasOverlay } from '../widgets/VideoCanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import styles from './WebcamTab.module.css'

type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export function WebcamTab() {
  const params = useConsoleStore((s) => s.params)
  const osd = useConsoleStore((s) => s.osd)
  const setOSD = useConsoleStore((s) => s.setOSD)
  const setLastPred = useConsoleStore((s) => s.setLastPred)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alertActive = useConsoleStore((s) => s.alert.active)
  const alertConfig = useConsoleStore((s) => s.alertConfig)
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)
  const modelId = useConsoleStore((s) => s.currentModelId)
  const device = useConsoleStore((s) => s.engine.device)
  const pushLog = useConsoleStore((s) => s.pushLog)
  const setConnections = useConsoleStore((s) => s.setConnections)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const inferRunningRef = useRef(false)
  const paramsRef = useRef(params)
  const targetFpsRef = useRef(10)

  const [wsState, setWsState] = useState<WsState>('idle')
  const [previewing, setPreviewing] = useState(false)
  const [inferring, setInferring] = useState(false)
  const [targetFps, setTargetFps] = useState(10)

  const filteredPred = useMemo(() => {
    if (!lastPred) return undefined
    const classFiltered =
      params.classFilter.length > 0 ? lastPred.bboxes.filter((b) => params.classFilter.includes(b.cls)) : lastPred.bboxes

    const roiFiltered =
      roi.applyFilter && roi.polygon.length >= 3
        ? filterBBoxesByRoiNormalized({
            bboxes: classFiltered,
            roiPoly: roi.polygon,
            width: lastPred.width,
            height: lastPred.height,
          })
        : classFiltered

    return { ...lastPred, bboxes: roiFiltered }
  }, [lastPred, params.classFilter, roi.applyFilter, roi.polygon])
  const bboxes = useMemo(() => filteredPred?.bboxes ?? [], [filteredPred])

  useEffect(() => {
    paramsRef.current = params
  }, [params])

  useEffect(() => {
    targetFpsRef.current = targetFps
  }, [targetFps])

  useEffect(() => {
    return () => {
      void stopAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startPreview() {
    if (previewing) return
    setLastPred(undefined)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      const video = videoRef.current
      if (!video) throw new Error('video element missing')
      video.srcObject = stream
      await video.play()
      setPreviewing(true)
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'webcam.preview', msg: 'preview started', fields: {} })
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'webcam.preview_failed', msg: String(e), fields: {} })
    }
  }

  async function startInfer() {
    if (inferring) return
    if (!previewing) await startPreview()
    setInferring(true)
    inferRunningRef.current = true

    setWsState('connecting')
    setConnections({ inferWs: 'connecting' })
    const ws = new WebSocket(wsInferUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setWsState('open')
      setConnections({ inferWs: 'open' })
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'ws.open', msg: 'connected', fields: {} })
    }
    ws.onclose = () => {
      setWsState('closed')
      setConnections({ inferWs: 'closed' })
      pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'ws.close', msg: 'closed', fields: {} })
    }
    ws.onerror = () => {
      setWsState('error')
      setConnections({ inferWs: 'error' })
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'ws.error', msg: 'websocket error', fields: {} })
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsPredMessage | WsLogMessage
        if (msg.type === 'pred') {
          setLastPred(msg)
        } else if (msg.type === 'log') {
          pushLog(msg)
        }
      } catch {
        // ignore
      }
    }

    loopSendFrames()
  }

  async function stopInfer() {
    setInferring(false)
    inferRunningRef.current = false
    const ws = wsRef.current
    wsRef.current = null
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    setWsState('idle')
    setConnections({ inferWs: 'idle' })
  }

  async function stopAll() {
    await stopInfer()
    setPreviewing(false)
    const video = videoRef.current
    const stream = video?.srcObject as MediaStream | null
    if (stream) {
      for (const t of stream.getTracks()) t.stop()
    }
    if (video) video.srcObject = null
  }

  function loopSendFrames() {
    const ws = wsRef.current
    const video = videoRef.current
    if (!ws || !video) return

    let lastSent = 0
    let frameSeq = 0

    const tick = () => {
      if (!inferRunningRef.current) return
      const now = performance.now()
      const minInterval = 1000 / Math.max(1, targetFpsRef.current)
      if (ws.readyState === WebSocket.OPEN && video.readyState >= 2 && now - lastSent >= minInterval) {
        lastSent = now
        const w = video.videoWidth || 640
        const h = video.videoHeight || 480
        const c = (captureCanvasRef.current ??= document.createElement('canvas'))
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h)
          const dataUrl = c.toDataURL('image/jpeg', 0.75)
          const b64 = dataUrl.split(',')[1] || ''
          const p = paramsRef.current
          ws.send(
            JSON.stringify({
              type: 'frame',
              frameId: String(frameSeq++),
              ts: Date.now() / 1000,
              imageJpegBase64: b64,
              width: w,
              height: h,
              conf: p.conf,
              iou: p.iou,
              classFilter: p.classFilter,
            }),
          )
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        {!previewing ? (
          <NeoButton onClick={() => void startPreview()}>启动预览</NeoButton>
        ) : (
          <NeoButton tone="danger" onClick={() => void stopAll()}>
            停止预览
          </NeoButton>
        )}

        {!inferring ? (
          <NeoButton onClick={() => void startInfer()} disabled={!previewing}>
            开始推理
          </NeoButton>
        ) : (
          <NeoButton tone="danger" onClick={() => void stopInfer()}>
            停止推理
          </NeoButton>
        )}

        <div className={styles.status}>
          WS: <span className={styles[wsState]}>{wsState}</span>
        </div>

        <div className={styles.divider} />

        <NeoButton
          onClick={async () => {
            const video = videoRef.current
            if (!video || video.readyState < 2) return
            const w = video.videoWidth || 640
            const h = video.videoHeight || 480
            const c = (captureCanvasRef.current ??= document.createElement('canvas'))
            c.width = w
            c.height = h
            const ctx = c.getContext('2d')
            if (!ctx) return
            ctx.drawImage(video, 0, 0, w, h)
            const jpeg: Blob | null = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.9))
            if (!jpeg) return
            try {
              await downloadBadCaseZip({
                jpeg,
                config: {
                  ts: Date.now() / 1000,
                  modelId,
                  device,
                  params: useConsoleStore.getState().params,
                  osd: useConsoleStore.getState().osd,
                  alertConfig,
                },
                pred: useConsoleStore.getState().lastPred,
              })
              pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'badcase.saved', msg: 'webcam zip downloaded', fields: {} })
            } catch (e) {
              pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'badcase.failed', msg: String(e), fields: {} })
            }
          }}
          disabled={!previewing}
        >
          📷 BadCase
        </NeoButton>

        <NeoButton onClick={() => setRoi({ enabled: !roi.enabled })} disabled={!previewing}>
          ROI
        </NeoButton>
        <NeoButton onClick={() => setRoi({ polygon: [], closed: false })} disabled={!roi.enabled || roi.polygon.length === 0}>
          清除 ROI
        </NeoButton>
        <NeoButton onClick={() => setRoi({ closed: false })} disabled={!roi.enabled || !roi.closed}>
          继续编辑
        </NeoButton>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={roi.applyFilter}
            onChange={(e) => setRoi({ applyFilter: e.target.checked })}
            disabled={!roi.enabled}
          />
          仅显示 ROI 内
        </label>

        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={() => setOSD({ bbox: !osd.bbox })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={osd.labels}
            onChange={() => setOSD({ labels: !osd.labels })}
          />
          Labels
        </label>

        <div className={styles.divider} />

        <label className={styles.toggle}>
          FPS
          <input
            className={styles.fps}
            type="number"
            min={1}
            max={30}
            value={targetFps}
            onChange={(e) => setTargetFps(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
          />
        </label>

        <div className={styles.spacer} />
        <div className={styles.meta}>bbox={bboxes.length}</div>
      </div>

      <div className={[styles.stage, alertActive ? styles.alertOn : ''].join(' ')}>
        <video ref={videoRef} className={styles.video} muted playsInline />
        <VideoCanvasOverlay videoRef={videoRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} />
        <RoiOverlay anchorRef={videoRef} />
        <TelemetryHUD telemetry={filteredPred?.telemetry} />
      </div>
    </div>
  )
}



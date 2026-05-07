import { useEffect, useMemo, useRef, useState } from 'react'
import { wsInferUrl, type WsLogMessage, type WsPredMessage } from '../../../api/client'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { downloadBadCaseZip } from '../../../utils/badcase'
import { createReconnectingWs, type ReconnectingWs, type WsState as RWsState } from '../../../utils/reconnectWs'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { TelemetryHUD } from '../widgets/TelemetryHUD'
import { VideoCanvasOverlay } from '../widgets/VideoCanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import { EventEditOverlay } from '../widgets/EventEditOverlay'
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
  const wsRef = useRef<ReconnectingWs | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const inferRunningRef = useRef(false)
  const paramsRef = useRef(params)
  const targetFpsRef = useRef(10)

  const [wsState, setWsState] = useState<WsState>('idle')
  const [previewing, setPreviewing] = useState(false)
  const [inferring, setInferring] = useState(false)
  const [targetFps, setTargetFps] = useState(10)
  const [editTool, setEditTool] = useState<'none' | 'line' | 'zone'>('none')

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
      inferRunningRef.current = false
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
      const video = videoRef.current
      const stream = (video?.srcObject ?? null) as MediaStream | null
      if (stream) for (const t of stream.getTracks()) t.stop()
      if (video) video.srcObject = null
    }
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
    const handleState = (s: RWsState, info?: { attempt?: number; reason?: string }) => {
      const map: Record<RWsState, WsState> = {
        idle: 'idle', connecting: 'connecting', open: 'open',
        closed: 'closed', error: 'error', reconnecting: 'connecting',
      }
      setWsState(map[s])
      setConnections({ inferWs: map[s] })
      if (s === 'open') {
        pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'ws.open', msg: 'connected', fields: {} })
      } else if (s === 'reconnecting') {
        pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'ws.reconnect', msg: `attempt ${info?.attempt}`, fields: {} })
      } else if (s === 'closed' && info?.reason && info.reason !== 'client_close') {
        pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'ws.close', msg: info.reason, fields: {} })
      }
    }

    const ws = createReconnectingWs({
      url: wsInferUrl(),
      onState: handleState,
      onMessage: (data) => {
        const msg = data as WsPredMessage | WsLogMessage
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'pred') setLastPred(msg)
        else if (msg.type === 'log') pushLog(msg)
      },
    })
    wsRef.current = ws

    loopSendFrames()
  }

  async function stopInfer() {
    setInferring(false)
    inferRunningRef.current = false
    const ws = wsRef.current
    wsRef.current = null
    ws?.close()
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
    const video = videoRef.current
    if (!video) return

    let lastSent = 0
    let frameSeq = 0
    let encoding = false
    const MAX_BUFFERED = 1_000_000 // 背压：>1MB 已缓冲就丢这帧

    const blobToBase64 = (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => {
          const r = String(fr.result || '')
          resolve(r.split(',')[1] || '')
        }
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })

    const tick = () => {
      if (!inferRunningRef.current) return
      const ws = wsRef.current
      const now = performance.now()
      const minInterval = 1000 / Math.max(1, targetFpsRef.current)
      const ready =
        ws !== null &&
        ws.state() === 'open' &&
        video.readyState >= 2 &&
        now - lastSent >= minInterval &&
        !encoding &&
        ws.bufferedAmount() < MAX_BUFFERED
      if (ready) {
        lastSent = now
        const w = video.videoWidth || 640
        const h = video.videoHeight || 480
        const c = (captureCanvasRef.current ??= document.createElement('canvas'))
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h)
          encoding = true
          c.toBlob(
            (blob) => {
              const wsNow = wsRef.current
              if (!blob || !inferRunningRef.current || !wsNow || wsNow.state() !== 'open') {
                encoding = false
                return
              }
              blobToBase64(blob)
                .then((b64) => {
                  const wsSend = wsRef.current
                  if (!inferRunningRef.current || !wsSend || wsSend.state() !== 'open') return
                  const p = paramsRef.current
                  wsSend.send(
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
                      track: p.track,
                    }),
                  )
                })
                .catch(() => {})
                .finally(() => {
                  encoding = false
                })
            },
            'image/jpeg',
            0.75,
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

        <NeoButton
          onClick={() => setEditTool(editTool === 'line' ? 'none' : 'line')}
          disabled={!previewing}
          tone={editTool === 'line' ? 'danger' : 'default'}
        >
          + Line
        </NeoButton>
        <NeoButton
          onClick={() => setEditTool(editTool === 'zone' ? 'none' : 'zone')}
          disabled={!previewing}
          tone={editTool === 'zone' ? 'danger' : 'default'}
        >
          + Zone
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
        <EventEditOverlay
          anchorRef={videoRef}
          enabled={editTool !== 'none'}
          mode={editTool === 'line' ? 'line' : 'zone'}
        />
        <TelemetryHUD telemetry={filteredPred?.telemetry} />
      </div>
    </div>
  )
}



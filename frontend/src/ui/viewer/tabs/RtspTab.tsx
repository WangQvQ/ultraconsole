import { useEffect, useMemo, useRef, useState } from 'react'
import { wsStreamUrl } from '../../../api/client'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { CanvasOverlay } from '../widgets/CanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import { TelemetryHUD } from '../widgets/TelemetryHUD'
import styles from './RtspTab.module.css'

type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

function b64ToBlobUrl(b64: string) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  return URL.createObjectURL(blob)
}

export function RtspTab() {
  const params = useConsoleStore((s) => s.params)
  const osd = useConsoleStore((s) => s.osd)
  const setOSD = useConsoleStore((s) => s.setOSD)
  const setLastPred = useConsoleStore((s) => s.setLastPred)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alertActive = useConsoleStore((s) => s.alert.active)
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)
  const pushLog = useConsoleStore((s) => s.pushLog)
  const setConnections = useConsoleStore((s) => s.setConnections)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const frameUrlRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  const [url, setUrl] = useState('rtsp://')
  const [wsState, setWsState] = useState<WsState>('idle')
  const [fps, setFps] = useState(10)
  const [running, setRunning] = useState(false)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)

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
    return () => {
      // 卸载清理：仅触碰 ref / 关闭 ws / 释放 blob URL，不再 setState
      runningRef.current = false
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.send(JSON.stringify({ type: 'rtsp.stop' }))
      } catch {
        // ignore
      }
      try {
        ws?.close()
      } catch {
        // ignore
      }
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
      frameUrlRef.current = null
    }
  }, [])

  function cleanup() {
    runningRef.current = false
    setRunning(false)
    setLastPred(undefined)

    const ws = wsRef.current
    wsRef.current = null
    try {
      ws?.close()
    } catch {
      // ignore
    }

    if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
    frameUrlRef.current = null
    setFrameUrl(null)
  }

  function stop() {
    const ws = wsRef.current
    try {
      ws?.send(JSON.stringify({ type: 'rtsp.stop' }))
    } catch {
      // ignore
    }
    setWsState('idle')
    setConnections({ rtspWs: 'idle' })
    cleanup()
  }

  function start() {
    if (running) return
    setRunning(true)
    runningRef.current = true
    setWsState('connecting')
    setConnections({ rtspWs: 'connecting' })
    setLastPred(undefined)

    const ws = new WebSocket(wsStreamUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setWsState('open')
      setConnections({ rtspWs: 'open' })
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'rtsp.ws.open', msg: 'connected', fields: {} })
      ws.send(
        JSON.stringify({
          type: 'rtsp.start',
          url,
          fps,
          conf: params.conf,
          iou: params.iou,
          classFilter: params.classFilter,
        }),
      )
    }
    ws.onclose = () => {
      if (!runningRef.current) return
      setWsState('closed')
      setConnections({ rtspWs: 'closed' })
      pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'rtsp.ws.close', msg: 'closed', fields: {} })
      cleanup()
    }
    ws.onerror = () => {
      if (!runningRef.current) return
      setWsState('error')
      setConnections({ rtspWs: 'error' })
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'rtsp.ws.error', msg: 'websocket error', fields: {} })
      cleanup()
    }
    ws.onmessage = (ev) => {
      if (!runningRef.current) return
      try {
        const msg = JSON.parse(ev.data) as any
        if (msg.type === 'frame' && msg.imageJpegBase64) {
          const next = b64ToBlobUrl(msg.imageJpegBase64)
          if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
          frameUrlRef.current = next
          setFrameUrl(next)
          return
        }
        if (msg.type === 'pred') {
          setLastPred(msg)
          return
        }
        if (msg.type === 'log') {
          pushLog(msg)
        }
      } catch {
        // ignore
      }
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <input className={styles.input} value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} />

        {!running ? (
          <NeoButton onClick={start}>开始</NeoButton>
        ) : (
          <NeoButton tone="danger" onClick={stop}>
            停止
          </NeoButton>
        )}

        <div className={styles.status}>
          WS: <span className={styles[wsState]}>{wsState}</span>
        </div>

        <div className={styles.divider} />

        <label className={styles.toggle}>
          FPS
          <input
            className={styles.num}
            type="number"
            min={1}
            max={30}
            value={fps}
            onChange={(e) => setFps(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
            disabled={running}
          />
        </label>

        <div className={styles.divider} />

        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={() => setOSD({ bbox: !osd.bbox })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.labels} onChange={() => setOSD({ labels: !osd.labels })} />
          Labels
        </label>

        <div className={styles.divider} />

        <NeoButton onClick={() => setRoi({ enabled: !roi.enabled })} disabled={!frameUrl}>
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

        <div className={styles.spacer} />
        <div className={styles.meta}>bbox={bboxes.length}</div>
      </div>

      <div className={[styles.stage, alertActive ? styles.alertOn : ''].join(' ')}>
        {frameUrl ? (
          <>
            <img ref={imgRef} className={styles.img} src={frameUrl} alt="" />
            <CanvasOverlay imgRef={imgRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} />
            <RoiOverlay anchorRef={imgRef} />
            <TelemetryHUD telemetry={filteredPred?.telemetry} />
          </>
        ) : (
          <div className={styles.empty}>填入 RTSP 地址后点击“开始”。</div>
        )}
      </div>
    </div>
  )
}


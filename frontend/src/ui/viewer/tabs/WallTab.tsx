import { useEffect, useMemo, useRef, useState } from 'react'
import { wsStreamUrl } from '../../../api/client'
import {
  useConsoleStore,
  type PredResponse,
} from '../../../store/useConsoleStore'
import { createReconnectingWs, type ReconnectingWs } from '../../../utils/reconnectWs'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { CanvasOverlay } from '../widgets/CanvasOverlay'
import styles from './WallTab.module.css'

type Cell = { id: string; url: string; running: boolean; frameUrl: string | null; pred?: PredResponse }
type GridSize = 1 | 2 | 4 | 6 | 9

function gridFor(n: GridSize) {
  if (n === 1) return { cols: 1, rows: 1 }
  if (n === 2) return { cols: 2, rows: 1 }
  if (n === 4) return { cols: 2, rows: 2 }
  if (n === 6) return { cols: 3, rows: 2 }
  return { cols: 3, rows: 3 }
}

function b64ToBlobUrl(b64: string) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
}

export function WallTab() {
  const params = useConsoleStore((s) => s.params)
  const osd = useConsoleStore((s) => s.osd)
  const setOSD = useConsoleStore((s) => s.setOSD)
  const roi = useConsoleStore((s) => s.roi)
  const pushLog = useConsoleStore((s) => s.pushLog)
  const setLastPred = useConsoleStore((s) => s.setLastPred)

  const wsRef = useRef<ReconnectingWs | null>(null)
  const cellsRef = useRef<Map<string, { frameUrl: string | null }>>(new Map())
  // 每个 streamId 的 rtsp.start 报文，重连后重新派发
  const startMsgsRef = useRef<Map<string, string>>(new Map())

  const [size, setSize] = useState<GridSize>(4)
  const [fps, setFps] = useState(8)
  const [cells, setCells] = useState<Cell[]>(() => buildCells(4))

  function buildCells(n: GridSize): Cell[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `cell_${i + 1}`,
      url: '',
      running: false,
      frameUrl: null,
      pred: undefined,
    }))
  }

  useEffect(() => {
    setCells((prev) => {
      const next = buildCells(size)
      // 保留同位置 url
      for (let i = 0; i < next.length; i++) {
        const old = prev[i]
        if (old) next[i] = { ...next[i], url: old.url }
      }
      return next
    })
  }, [size])

  useEffect(() => {
    return () => {
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.send(JSON.stringify({ type: 'rtsp.stopAll' }))
      } catch {
        // ignore
      }
      ws?.close()
      for (const v of cellsRef.current.values()) {
        if (v.frameUrl) URL.revokeObjectURL(v.frameUrl)
      }
      cellsRef.current.clear()
      startMsgsRef.current.clear()
    }
  }, [])

  function ensureWs(): ReconnectingWs {
    if (wsRef.current) return wsRef.current
    const ws = createReconnectingWs({
      url: wsStreamUrl(),
      onState: (s, info) => {
        if (s === 'open') {
          pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'wall.ws.open', msg: 'connected', fields: {} })
        } else if (s === 'reconnecting') {
          pushLog({
            ts: Date.now() / 1000,
            level: 'WARN',
            event: 'wall.ws.reconnect',
            msg: `attempt ${info?.attempt}`,
            fields: {},
          })
        } else if (s === 'closed' && info?.reason && info.reason !== 'client_close') {
          pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'wall.ws.close', msg: info.reason, fields: {} })
        }
      },
      onOpen: () => {
        // 重连后重发所有 streamId 的 rtsp.start
        for (const m of startMsgsRef.current.values()) {
          wsRef.current?.send(m)
        }
      },
      onMessage: (data) => {
        const msg = data as Record<string, unknown>
        if (!msg || typeof msg !== 'object') return
        const sid = String((msg as { streamId?: unknown }).streamId ?? '')
        if (!sid) return
        if (msg.type === 'frame' && typeof msg.imageJpegBase64 === 'string') {
          const next = b64ToBlobUrl(msg.imageJpegBase64)
          const old = cellsRef.current.get(sid)
          if (old?.frameUrl) URL.revokeObjectURL(old.frameUrl)
          cellsRef.current.set(sid, { frameUrl: next })
          setCells((prev) => prev.map((c) => (c.id === sid ? { ...c, frameUrl: next } : c)))
          return
        }
        if (msg.type === 'pred') {
          const pred = msg as unknown as PredResponse
          setCells((prev) => prev.map((c) => (c.id === sid ? { ...c, pred } : c)))
          if (sid === 'cell_1') setLastPred(pred)
          return
        }
        if (msg.type === 'log') {
          pushLog({
            ts: Number(msg.ts) || Date.now() / 1000,
            level: (msg.level as 'INFO' | 'WARN' | 'ERROR') || 'INFO',
            event: String(msg.event || ''),
            msg: String(msg.msg || ''),
            fields: (msg.fields as Record<string, unknown>) || {},
          })
        }
      },
    })
    wsRef.current = ws
    return ws
  }

  function startCell(id: string, url: string) {
    if (!url) return
    const ws = ensureWs()
    const startMsg = JSON.stringify({
      type: 'rtsp.start',
      streamId: id,
      url,
      fps,
      conf: params.conf,
      iou: params.iou,
      classFilter: params.classFilter,
      track: params.track,
    })
    startMsgsRef.current.set(id, startMsg)
    if (ws.state() === 'open') ws.send(startMsg)
    // 否则等 onOpen 自动重发
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, running: true } : c)))
  }

  function stopCell(id: string) {
    startMsgsRef.current.delete(id)
    const ws = wsRef.current
    if (ws && ws.state() === 'open') {
      ws.send(JSON.stringify({ type: 'rtsp.stop', streamId: id }))
    }
    const old = cellsRef.current.get(id)
    if (old?.frameUrl) URL.revokeObjectURL(old.frameUrl)
    cellsRef.current.delete(id)
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, running: false, frameUrl: null, pred: undefined } : c)))
  }

  function startAll() {
    for (const c of cells) if (c.url) startCell(c.id, c.url)
  }
  function stopAll() {
    startMsgsRef.current.clear()
    const ws = wsRef.current
    if (ws && ws.state() === 'open') {
      ws.send(JSON.stringify({ type: 'rtsp.stopAll' }))
    }
    for (const v of cellsRef.current.values()) if (v.frameUrl) URL.revokeObjectURL(v.frameUrl)
    cellsRef.current.clear()
    setCells((prev) => prev.map((c) => ({ ...c, running: false, frameUrl: null, pred: undefined })))
  }

  const grid = gridFor(size)

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <label className={styles.toggle}>
          网格
          <select
            className={styles.select}
            value={size}
            onChange={(e) => setSize(Number(e.target.value) as GridSize)}
          >
            <option value={1}>1×1</option>
            <option value={2}>2×1</option>
            <option value={4}>2×2</option>
            <option value={6}>3×2</option>
            <option value={9}>3×3</option>
          </select>
        </label>
        <label className={styles.toggle}>
          FPS
          <input
            className={styles.num}
            type="number"
            min={1}
            max={30}
            value={fps}
            onChange={(e) => setFps(Math.max(1, Math.min(30, Number(e.target.value) || 8)))}
          />
        </label>
        <NeoButton onClick={startAll}>全部开始</NeoButton>
        <NeoButton tone="danger" onClick={stopAll}>
          全部停止
        </NeoButton>
        <div className={styles.spacer} />
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={() => setOSD({ bbox: !osd.bbox })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.labels} onChange={() => setOSD({ labels: !osd.labels })} />
          Labels
        </label>
        <div className={styles.meta}>
          {params.track ? <span className={styles.tagOn}>tracking on</span> : <span>tracking off</span>}
        </div>
      </div>

      <div
        className={styles.grid}
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
          gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
        }}
      >
        {cells.map((c) => (
          <WallCell
            key={c.id}
            cell={c}
            roiPolygon={roi.applyFilter ? roi.polygon : []}
            classFilter={params.classFilter}
            showBBox={osd.bbox}
            showLabels={osd.labels}
            onUrlChange={(url) => setCells((prev) => prev.map((x) => (x.id === c.id ? { ...x, url } : x)))}
            onStart={() => startCell(c.id, c.url)}
            onStop={() => stopCell(c.id)}
          />
        ))}
      </div>
    </div>
  )
}

function WallCell(props: {
  cell: Cell
  roiPolygon: { x: number; y: number }[]
  classFilter: string[]
  showBBox: boolean
  showLabels: boolean
  onUrlChange: (url: string) => void
  onStart: () => void
  onStop: () => void
}) {
  const imgRef = useRef<HTMLImageElement | null>(null)

  const filtered = useMemo(() => {
    const pred = props.cell.pred
    if (!pred) return undefined
    const cls =
      props.classFilter.length > 0 ? pred.bboxes.filter((b) => props.classFilter.includes(b.cls)) : pred.bboxes
    const roiF =
      props.roiPolygon.length >= 3
        ? filterBBoxesByRoiNormalized({ bboxes: cls, roiPoly: props.roiPolygon, width: pred.width, height: pred.height })
        : cls
    return { ...pred, bboxes: roiF }
  }, [props.cell.pred, props.classFilter, props.roiPolygon])

  return (
    <div className={styles.cell}>
      <div className={styles.cellHeader}>
        <span className={styles.cellId}>{props.cell.id}</span>
        <input
          className={styles.cellInput}
          placeholder="rtsp://..."
          value={props.cell.url}
          onChange={(e) => props.onUrlChange(e.target.value)}
          disabled={props.cell.running}
        />
        {!props.cell.running ? (
          <NeoButton onClick={props.onStart} style={{ padding: '6px 10px', fontSize: 11 }}>
            开始
          </NeoButton>
        ) : (
          <NeoButton tone="danger" onClick={props.onStop} style={{ padding: '6px 10px', fontSize: 11 }}>
            停止
          </NeoButton>
        )}
      </div>
      <div className={styles.cellStage}>
        {props.cell.frameUrl ? (
          <>
            <img ref={imgRef} className={styles.cellImg} src={props.cell.frameUrl} alt="" />
            <CanvasOverlay
              imgRef={imgRef}
              pred={filtered}
              showBBox={props.showBBox}
              showLabels={props.showLabels}
              drawEvents={false}
            />
            {filtered && (
              <div className={styles.cellHud}>
                bbox={filtered.bboxes.length}
                {filtered.telemetry?.fps !== undefined ? ` · ${filtered.telemetry.fps.toFixed(1)} fps` : ''}
              </div>
            )}
          </>
        ) : (
          <div className={styles.cellEmpty}>{props.cell.running ? '连接中…' : '填 RTSP 地址后点开始'}</div>
        )}
      </div>
    </div>
  )
}

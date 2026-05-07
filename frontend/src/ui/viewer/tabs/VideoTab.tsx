import { useEffect, useMemo, useRef, useState } from 'react'
import { apiInferFrame } from '../../../api/client'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { TelemetryHUD } from '../widgets/TelemetryHUD'
import { VideoCanvasOverlay } from '../widgets/VideoCanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import styles from './VideoTab.module.css'

export function VideoTab() {
  const params = useConsoleStore((s) => s.params)
  const osd = useConsoleStore((s) => s.osd)
  const setOSD = useConsoleStore((s) => s.setOSD)
  const setLastPred = useConsoleStore((s) => s.setLastPred)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alertActive = useConsoleStore((s) => s.alert.active)
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)
  const pushLog = useConsoleStore((s) => s.pushLog)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const runningRef = useRef(false)
  const inflightRef = useRef(false)
  const pendingRef = useRef(false)
  const urlRef = useRef<string | null>(null)

  const [running, setRunning] = useState(false)
  const [targetFps, setTargetFps] = useState(8)
  const [dragOver, setDragOver] = useState(false)
  const targetFpsRef = useRef(targetFps)
  useEffect(() => void (targetFpsRef.current = targetFps), [targetFps])

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
      runningRef.current = false
      setRunning(false)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  function loop() {
    const video = videoRef.current
    if (!video) return

    const minInterval = 1000 / Math.max(1, targetFpsRef.current)
    let lastSent = 0

    const tick = () => {
      if (!runningRef.current) return
      const now = performance.now()
      if (video.readyState >= 2 && !video.paused && now - lastSent >= minInterval) {
        lastSent = now
        if (inflightRef.current) {
          pendingRef.current = true
        } else {
          void sendOne()
        }
      }
      requestAnimationFrame(tick)
    }

    const sendOne = async () => {
      const v = videoRef.current
      if (!v) return
      const w = v.videoWidth || 640
      const h = v.videoHeight || 480
      const c = (captureCanvasRef.current ??= document.createElement('canvas'))
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(v, 0, 0, w, h)
      inflightRef.current = true
      try {
        const jpeg: Blob | null = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8))
        if (!jpeg) return
        const pred = await apiInferFrame(jpeg)
        setLastPred(pred)
      } catch (e) {
        pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'infer.video_failed', msg: String(e), fields: {} })
      } finally {
        inflightRef.current = false
        if (pendingRef.current) {
          pendingRef.current = false
          void sendOne()
        }
      }
    }

    requestAnimationFrame(tick)
  }

  async function onPick(file?: File) {
    if (!file) return
    const video = videoRef.current
    if (!video) return
    runningRef.current = false
    setRunning(false)
    setLastPred(undefined)
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(file)
    urlRef.current = url
    video.src = url
    await video.play().catch(() => {})
    pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'video.loaded', msg: file.name, fields: {} })
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <label className={styles.fileBtn}>
          <input className={styles.fileInput} type="file" accept="video/*" onChange={(e) => void onPick(e.target.files?.[0])} />
          选择视频
        </label>

        {!running ? (
          <NeoButton
            onClick={() => {
              runningRef.current = true
              setRunning(true)
              loop()
              pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'video.infer.start', msg: `fps=${targetFps}`, fields: {} })
            }}
          >
            开始推理
          </NeoButton>
        ) : (
          <NeoButton
            tone="danger"
            onClick={() => {
              runningRef.current = false
              setRunning(false)
              pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'video.infer.stop', msg: 'stopped', fields: {} })
            }}
          >
            停止
          </NeoButton>
        )}

        <div className={styles.divider} />

        <label className={styles.toggle}>
          FPS
          <input
            className={styles.num}
            type="number"
            min={1}
            max={30}
            value={targetFps}
            onChange={(e) => setTargetFps(Math.max(1, Math.min(30, Number(e.target.value) || 8)))}
          />
        </label>

        <div className={styles.divider} />

        <NeoButton onClick={() => setRoi({ enabled: !roi.enabled })}>
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
          <input type="checkbox" checked={osd.labels} onChange={() => setOSD({ labels: !osd.labels })} />
          Labels
        </label>

        <div className={styles.spacer} />
        <div className={styles.meta}>bbox={bboxes.length}</div>
      </div>

      <div
        className={[styles.stage, alertActive ? styles.alertOn : '', dragOver ? styles.dropOver : ''].join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer?.files?.[0]
          if (file && file.type.startsWith('video/')) void onPick(file)
        }}
      >
        <video ref={videoRef} className={styles.video} controls playsInline />
        <VideoCanvasOverlay videoRef={videoRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} />
        <RoiOverlay anchorRef={videoRef} />
        <TelemetryHUD telemetry={filteredPred?.telemetry} />
        {dragOver && <div className={styles.dropHint}>松开以载入视频</div>}
      </div>
    </div>
  )
}


import { useEffect, useMemo, useRef, useState } from 'react'
import { EventEditOverlay } from '../widgets/EventEditOverlay'
import { newTrackerState } from '../../../utils/events'
import { createVideoReport, formatVideoTime, recordVideoFrame, seekVideo, VideoInferenceSession, videoReportCsv, type VideoReport } from '../../../utils/videoAnalysis'
import { useT } from '../../../i18n'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { TelemetryHUD } from '../widgets/TelemetryHUD'
import { VideoCanvasOverlay } from '../widgets/VideoCanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import styles from './VideoTab.module.css'

export function VideoTab() {
  const t = useT()
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
  const abortRef = useRef<AbortController | null>(null)
  const urlRef = useRef<string | null>(null)
  const reportRef = useRef<VideoReport | null>(null)
  const [report, setReport] = useState<VideoReport | null>(null)
  const [fileName, setFileName] = useState('')
  const [running, setRunning] = useState(false)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const [targetFps, setTargetFps] = useState(8)
  const [dragOver, setDragOver] = useState(false)
  const [editTool, setEditTool] = useState<'none' | 'line' | 'zone'>('none')
  const [error, setError] = useState('')
  const modelId = useConsoleStore((s) => s.currentModelId)
  const eventsConfig = useConsoleStore((s) => s.eventsConfig)

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
      abortRef.current?.abort()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      useConsoleStore.getState().setLastPred(undefined)
      useConsoleStore.getState().resetCounters()
    }
  }, [])

  async function analyze() {
    const video = videoRef.current
    if (!video || !modelId || abortRef.current || !Number.isFinite(video.duration) || video.duration <= 0) return
    const controller = new AbortController()
    abortRef.current = controller
    video.pause()
    setRoi({ enabled: false })
    setEditTool('none')
    setError('')
    setRunning(true)
    setLastPred(undefined)
    useConsoleStore.getState().resetCounters()
    const snapshot = useConsoleStore.getState()
    const analysis = createVideoReport(fileName, video.duration, targetFps, modelId, { ...snapshot.params, track: true }, snapshot.eventsConfig)
    reportRef.current = analysis
    setReport({ ...analysis })
    const tracker = newTrackerState()
    let session: VideoInferenceSession | undefined
    // Changing model, engine, parameters or rules invalidates a run rather than mixing results.
    const unsubscribe = useConsoleStore.subscribe((next) => {
      if (next.currentModelId !== snapshot.currentModelId || next.engine.device !== snapshot.engine.device ||
          next.params !== snapshot.params || next.eventsConfig !== snapshot.eventsConfig) controller.abort()
    })
    try {
      session = new VideoInferenceSession(controller.signal)
      const canvas = (captureCanvasRef.current ??= document.createElement('canvas'))
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable')
      const total = Math.ceil(analysis.duration * analysis.fps)
      for (let index = 0; index < total; index++) {
        const mediaTime = index / analysis.fps
        await seekVideo(video, mediaTime, controller.signal)
        if (controller.signal.aborted) break
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const jpeg = canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
        const pred = await session.infer(jpeg, analysis.params)
        if (controller.signal.aborted) break
        recordVideoFrame(analysis, tracker, pred, mediaTime)
        // Video events are processed synchronously here, independently of React render frequency.
        useConsoleStore.setState({ counters: analysis.counters, events: analysis.events.slice(-500) })
        setLastPred({ ...pred, source: 'video', mediaTime })
        setReport({ ...analysis })
      }
      analysis.status = controller.signal.aborted ? 'stopped' : 'completed'
    } catch (e) {
      analysis.status = controller.signal.aborted ? 'stopped' : 'error'
      if (!controller.signal.aborted) {
        setError(String(e))
        pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'video.analysis.failed', msg: String(e), fields: {} })
      }
    } finally {
      unsubscribe()
      session?.close()
      if (abortRef.current === controller) {
        abortRef.current = null
        setRunning(false)
        setReport({ ...analysis })
      }
    }
  }

  function onPick(file?: File) {
    if (!file || abortRef.current) return
    const video = videoRef.current
    if (!video) return
    setVideoLoaded(false)
    setError('')
    setLastPred(undefined)
    useConsoleStore.getState().resetCounters()
    setReport(null)
    reportRef.current = null
    setEditTool('none')
    setFileName(file.name)
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(file)
    urlRef.current = url
    video.src = url
    video.load()
    pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'video.loaded', msg: file.name, fields: {} })
  }

  function exportReport() {
    const current = reportRef.current
    if (!current) return
    const url = URL.createObjectURL(new Blob([videoReportCsv(current)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${current.fileName}.analysis.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function edit(mode: 'line' | 'zone') {
    videoRef.current?.pause()
    setRoi({ enabled: false })
    setEditTool(editTool === mode ? 'none' : mode)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <label className={styles.fileBtn}>
          <input className={styles.fileInput} type="file" disabled={running} accept="video/*" onChange={(e) => void onPick(e.target.files?.[0])} />
          {t('video.selectVideo')}
        </label>

        {!running ? (
          <NeoButton onClick={() => void analyze()} disabled={!videoLoaded || !modelId}>
            {t('video.analyze')}
          </NeoButton>
        ) : (
          <NeoButton tone="danger" onClick={() => abortRef.current?.abort()}>{t('common.stop')}</NeoButton>
        )}
        <NeoButton onClick={exportReport} disabled={running || !report || report.frames === 0}>{t('video.exportReport')}</NeoButton>
        <NeoButton onClick={() => edit('line')} disabled={running || !videoLoaded}>
          {t(editTool === 'line' ? 'video.finishEdit' : 'video.drawLine')}
        </NeoButton>
        <NeoButton onClick={() => edit('zone')} disabled={running || !videoLoaded}>
          {t(editTool === 'zone' ? 'video.finishEdit' : 'video.drawZone')}
        </NeoButton>
        <NeoButton disabled={running || (!eventsConfig.lines.length && !eventsConfig.zones.length)} onClick={() => {
          useConsoleStore.getState().setEventsConfig({ lines: [], zones: [] })
          setEditTool('none')
        }}>{t('video.clearRules')}</NeoButton>

        <div className={styles.divider} />

        <label className={styles.toggle}>
          FPS
          <input
            className={styles.num}
            type="number"
            min={1}
            max={30}
            value={targetFps}
            disabled={running}
            onChange={(e) => setTargetFps(Math.max(1, Math.min(30, Number(e.target.value) || 8)))}
          />
        </label>

        <div className={styles.divider} />

        <NeoButton onClick={() => { setEditTool('none'); setRoi({ enabled: !roi.enabled }) }} disabled={!videoLoaded || running}>
          ROI
        </NeoButton>
        <NeoButton onClick={() => setRoi({ mode: roi.mode === 'rect' ? 'poly' : 'rect' })} disabled={!roi.enabled}>
          {roi.mode === 'rect' ? t('common.rectangle') : t('common.polygon')}
        </NeoButton>
        <NeoButton onClick={() => setRoi({ polygon: [], closed: false })} disabled={!roi.enabled || roi.polygon.length === 0}>
          {t('common.clearRoi')}
        </NeoButton>
        <NeoButton onClick={() => setRoi({ closed: false })} disabled={!roi.enabled || !roi.closed}>
          {t('common.continueEdit')}
        </NeoButton>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={roi.applyFilter}
            onChange={(e) => setRoi({ applyFilter: e.target.checked })}
            disabled={!roi.enabled}
          />
          {t('common.showOnlyInsideRoi')}
        </label>

        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={() => setOSD({ bbox: !osd.bbox })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.labels} onChange={() => setOSD({ labels: !osd.labels })} />
          Labels
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.heatmap} onChange={() => setOSD({ heatmap: !osd.heatmap })} />
          {t('common.heatmap')}
        </label>

        <div className={styles.spacer} />
        <div className={styles.meta}>bbox={bboxes.length}</div>
      </div>

      <div className={styles.meta}>{t('video.analysisHint')}</div>
      {editTool !== 'none' && <div className={styles.meta}>{t(editTool === 'line' ? 'video.lineHint' : 'video.zoneHint')}</div>}
      {report && <div role="status" className={styles.meta}>
        {t(`video.${report.status}`)} · {formatVideoTime(report.analyzedSeconds)} / {formatVideoTime(report.duration)} · {report.frames} {t('video.frames')} · {report.events.length} {t('video.events')}
      </div>}
      {error && <div role="alert">{error}</div>}
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
        <video ref={videoRef} className={styles.video} controls={!running} playsInline
          onLoadedData={() => setVideoLoaded(Number.isFinite(videoRef.current?.duration) && (videoRef.current?.duration ?? 0) > 0)}
          onError={() => { setError(t('video.decodeError')); setVideoLoaded(false); abortRef.current?.abort() }}
          onPlay={() => { if (abortRef.current) videoRef.current?.pause(); else setLastPred(undefined) }}
          onSeeking={() => { if (!abortRef.current) setLastPred(undefined) }}
        />
        <VideoCanvasOverlay videoRef={videoRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} showHeatmap={osd.heatmap} />
        <RoiOverlay anchorRef={videoRef} />
        <EventEditOverlay key={editTool} anchorRef={videoRef} enabled={editTool !== 'none'} mode={editTool === 'zone' ? 'zone' : 'line'} />
        <TelemetryHUD telemetry={filteredPred?.telemetry} />
        {dragOver && <div className={styles.dropHint}>{t('video.dropHint')}</div>}
      </div>
    </div>
  )
}


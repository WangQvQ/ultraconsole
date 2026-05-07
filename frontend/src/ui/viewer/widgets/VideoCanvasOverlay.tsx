import { useEffect, useRef } from 'react'
import { useConsoleStore, type PredResponse } from '../../../store/useConsoleStore'
import {
  drawBoxes,
  drawCountingLines,
  drawCountingZones,
  drawKeypoints,
  drawMasks,
  drawTrails,
  fitContain,
  pruneTrails,
  pushTrail,
  type TrailMap,
} from '../../../utils/draw'
import styles from './CanvasOverlay.module.css'

export function VideoCanvasOverlay(props: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  pred?: PredResponse
  showBBox: boolean
  showLabels: boolean
  showMasks?: boolean
  showKeypoints?: boolean
  showTrails?: boolean
  drawEvents?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const eventsConfig = useConsoleStore((s) => s.eventsConfig)

  const predRef = useRef<PredResponse | undefined>(props.pred)
  const flagsRef = useRef({
    showBBox: props.showBBox,
    showLabels: props.showLabels,
    showMasks: props.showMasks ?? true,
    showKeypoints: props.showKeypoints ?? true,
    showTrails: props.showTrails ?? true,
    drawEvents: props.drawEvents ?? true,
  })
  const eventsRef = useRef(eventsConfig)
  const trailsRef = useRef<TrailMap>(new Map())
  const redrawRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    predRef.current = props.pred
    if (props.pred) {
      const active = new Set<number>()
      const w = props.pred.width
      const h = props.pred.height
      for (const b of props.pred.bboxes) {
        if (b.trackId !== undefined && b.trackId !== null) {
          active.add(b.trackId)
          if (w > 0 && h > 0) {
            const cx = ((b.x1 + b.x2) / 2) / w
            const cy = ((b.y1 + b.y2) / 2) / h
            pushTrail(trailsRef.current, b.trackId, cx, cy)
          }
        }
      }
      pruneTrails(trailsRef.current, active)
    }
  }, [props.pred])

  useEffect(() => {
    flagsRef.current = {
      showBBox: props.showBBox,
      showLabels: props.showLabels,
      showMasks: props.showMasks ?? true,
      showKeypoints: props.showKeypoints ?? true,
      showTrails: props.showTrails ?? true,
      drawEvents: props.drawEvents ?? true,
    }
  }, [props.showBBox, props.showLabels, props.showMasks, props.showKeypoints, props.showTrails, props.drawEvents])

  useEffect(() => {
    eventsRef.current = eventsConfig
  }, [eventsConfig])

  useEffect(() => {
    const video = props.videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    let raf = 0
    let alive = true

    const redraw = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!alive) return
        const r = video.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        canvas.style.width = `${r.width}px`
        canvas.style.height = `${r.height}px`
        canvas.width = Math.max(1, Math.floor(r.width * dpr))
        canvas.height = Math.max(1, Math.floor(r.height * dpr))

        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, r.width, r.height)

        const pred = predRef.current
        const flags = flagsRef.current
        const evCfg = eventsRef.current

        const srcW = pred?.width ?? 0
        const srcH = pred?.height ?? 0
        if (srcW <= 0 || srcH <= 0) return
        const fc = fitContain(r.width, r.height, srcW, srcH)

        if (pred && flags.showMasks && pred.masks && pred.masks.length > 0) {
          drawMasks(ctx, pred.masks, fc)
        }
        if (flags.drawEvents) {
          drawCountingZones(ctx, evCfg.zones, fc, srcW, srcH)
          drawCountingLines(ctx, evCfg.lines, fc, srcW, srcH)
        }
        if (flags.showTrails) drawTrails(ctx, trailsRef.current, fc)
        if (pred && flags.showBBox) drawBoxes(ctx, pred.bboxes, fc, flags.showLabels)
        if (pred && flags.showKeypoints && pred.keypoints && pred.keypoints.length > 0) {
          drawKeypoints(ctx, pred.keypoints, fc)
        }
      })
    }

    redrawRef.current = redraw
    redraw()

    const ro = new ResizeObserver(redraw)
    ro.observe(video)
    window.addEventListener('resize', redraw, { passive: true })
    video.addEventListener('loadedmetadata', redraw)
    video.addEventListener('resize', redraw)

    return () => {
      alive = false
      video.removeEventListener('resize', redraw)
      video.removeEventListener('loadedmetadata', redraw)
      window.removeEventListener('resize', redraw)
      ro.disconnect()
      cancelAnimationFrame(raf)
      redrawRef.current = null
    }
  }, [props.videoRef])

  useEffect(() => {
    redrawRef.current?.()
  }, [
    props.pred,
    props.showBBox,
    props.showLabels,
    props.showMasks,
    props.showKeypoints,
    props.showTrails,
    props.drawEvents,
    eventsConfig,
  ])

  return <canvas ref={canvasRef} className={styles.canvas} />
}

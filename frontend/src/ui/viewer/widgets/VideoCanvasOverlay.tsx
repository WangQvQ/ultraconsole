import { useEffect, useMemo, useRef } from 'react'
import type { PredResponse } from '../../../store/useConsoleStore'
import styles from './CanvasOverlay.module.css'

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = '12px ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  const padX = 6
  const padY = 4
  const w = ctx.measureText(text).width + padX * 2
  const h = 16 + padY * 2
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(x, y - h, w, h)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(text, x + padX, y - padY)
}

export function VideoCanvasOverlay(props: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  pred?: PredResponse
  showBBox: boolean
  showLabels: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxes = useMemo(() => props.pred?.bboxes ?? [], [props.pred])
  const srcW = props.pred?.width ?? 0
  const srcH = props.pred?.height ?? 0

  useEffect(() => {
    const video = props.videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

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

    if (!props.pred || !props.showBBox) return
    if (srcW <= 0 || srcH <= 0) return

    const scale = Math.min(r.width / srcW, r.height / srcH)
    const drawW = srcW * scale
    const drawH = srcH * scale
    const offX = (r.width - drawW) / 2
    const offY = (r.height - drawH) / 2

    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(76,255,122,0.95)'

    for (const b of boxes) {
      const x = offX + b.x1 * scale
      const y = offY + b.y1 * scale
      const w = (b.x2 - b.x1) * scale
      const h = (b.y2 - b.y1) * scale
      ctx.strokeRect(x, y, w, h)
      if (props.showLabels && b.label) {
        drawLabel(ctx, b.label, x, y)
      }
    }
  }, [boxes, props.pred, props.showBBox, props.showLabels, props.videoRef, srcH, srcW])

  return <canvas ref={canvasRef} className={styles.canvas} />
}


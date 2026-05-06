import { useEffect, useRef } from 'react'
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

export function CanvasOverlay(props: {
  imgRef: React.RefObject<HTMLImageElement | null>
  pred?: PredResponse
  showBBox: boolean
  showLabels: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // 用 ref 持有最新的绘制参数，避免每次 pred 变化都重建 observer
  const predRef = useRef<PredResponse | undefined>(props.pred)
  const showBBoxRef = useRef(props.showBBox)
  const showLabelsRef = useRef(props.showLabels)
  const redrawRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    predRef.current = props.pred
  }, [props.pred])
  useEffect(() => {
    showBBoxRef.current = props.showBBox
  }, [props.showBBox])
  useEffect(() => {
    showLabelsRef.current = props.showLabels
  }, [props.showLabels])

  // observer / 监听只挂一次
  useEffect(() => {
    const img = props.imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas) return

    let raf = 0
    let alive = true

    const redraw = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!alive) return
        const r = img.getBoundingClientRect()
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
        if (!pred || !showBBoxRef.current) return
        const srcW = pred.width
        const srcH = pred.height
        if (srcW <= 0 || srcH <= 0) return

        const scale = Math.min(r.width / srcW, r.height / srcH)
        const drawW = srcW * scale
        const drawH = srcH * scale
        const offX = (r.width - drawW) / 2
        const offY = (r.height - drawH) / 2

        ctx.lineWidth = 2
        ctx.strokeStyle = 'rgba(76,255,122,0.95)'

        for (const b of pred.bboxes) {
          const x = offX + b.x1 * scale
          const y = offY + b.y1 * scale
          const w = (b.x2 - b.x1) * scale
          const h = (b.y2 - b.y1) * scale
          ctx.strokeRect(x, y, w, h)
          if (showLabelsRef.current && b.label) {
            drawLabel(ctx, b.label, x, y)
          }
        }
      })
    }

    redrawRef.current = redraw
    redraw()

    const ro = new ResizeObserver(redraw)
    ro.observe(img)
    window.addEventListener('resize', redraw, { passive: true })
    img.addEventListener('load', redraw)

    return () => {
      alive = false
      img.removeEventListener('load', redraw)
      window.removeEventListener('resize', redraw)
      ro.disconnect()
      cancelAnimationFrame(raf)
      redrawRef.current = null
    }
  }, [props.imgRef])

  // 任何绘制相关 prop 变化只触发一次轻量重绘
  useEffect(() => {
    redrawRef.current?.()
  }, [props.pred, props.showBBox, props.showLabels])

  return <canvas ref={canvasRef} className={styles.canvas} />
}

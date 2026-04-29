import { useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore, type RoiPoint } from '../../../store/useConsoleStore'
import styles from './RoiOverlay.module.css'

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x))
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function samePoint(a: RoiPoint, b: RoiPoint) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
}

function normalizePoly(poly: RoiPoint[]) {
  if (poly.length >= 2 && samePoint(poly[0], poly[poly.length - 1])) return poly.slice(0, -1)
  return poly
}

function getSourceSize(el: HTMLElement | null): { w: number; h: number } | null {
  if (!el) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyEl = el as any
  const w = Number(anyEl.naturalWidth ?? anyEl.videoWidth ?? 0)
  const h = Number(anyEl.naturalHeight ?? anyEl.videoHeight ?? 0)
  if (!w || !h) return null
  return { w, h }
}

function fitContain(rectW: number, rectH: number, srcW: number, srcH: number) {
  const scale = Math.min(rectW / srcW, rectH / srcH)
  const drawW = srcW * scale
  const drawH = srcH * scale
  const offX = (rectW - drawW) / 2
  const offY = (rectH - drawH) / 2
  return { scale, offX, offY, drawW, drawH }
}

function srcNormToDisplay(p: RoiPoint, rectW: number, rectH: number, srcW: number, srcH: number) {
  const { scale, offX, offY } = fitContain(rectW, rectH, srcW, srcH)
  return { x: offX + p.x * srcW * scale, y: offY + p.y * srcH * scale }
}

function displayToSrcNorm(x: number, y: number, rectW: number, rectH: number, srcW: number, srcH: number): RoiPoint | null {
  const { scale, offX, offY, drawW, drawH } = fitContain(rectW, rectH, srcW, srcH)
  // 点击在黑边/留白区域时，直接忽略（否则会被 clamp 到边缘，体验很差）
  if (x < offX || y < offY || x > offX + drawW || y > offY + drawH) return null
  const sx = (x - offX) / scale
  const sy = (y - offY) / scale
  return { x: clamp01(sx / srcW), y: clamp01(sy / srcH) }
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  polyRaw: RoiPoint[],
  rectW: number,
  rectH: number,
  srcW: number,
  srcH: number,
  preview?: RoiPoint,
  closed?: boolean,
) {
  const poly = normalizePoly(polyRaw)
  ctx.clearRect(0, 0, rectW, rectH)
  if (poly.length === 0 && !preview) return

  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(45, 212, 255, 0.95)'
  ctx.fillStyle = 'rgba(45, 212, 255, 0.08)'

  const pts = preview ? [...poly, preview] : poly
  if (pts.length >= 2) {
    ctx.beginPath()
    const p0 = srcNormToDisplay(pts[0], rectW, rectH, srcW, srcH)
    ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < pts.length; i++) {
      const pi = srcNormToDisplay(pts[i], rectW, rectH, srcW, srcH)
      ctx.lineTo(pi.x, pi.y)
    }
    if ((closed || (!preview && poly.length >= 3)) && poly.length >= 3) ctx.closePath()
    ctx.stroke()
    if (closed && poly.length >= 3) ctx.fill()
  }

  // points
  for (let idx = 0; idx < poly.length; idx++) {
    const p = poly[idx]
    const isFirst = idx === 0
    const dp = srcNormToDisplay(p, rectW, rectH, srcW, srcH)
    ctx.beginPath()
    ctx.arc(dp.x, dp.y, isFirst ? 8 : 7, 0, Math.PI * 2)
    ctx.fillStyle = isFirst ? 'rgba(255, 255, 255, 0.92)' : 'rgba(76, 255, 122, 0.95)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.stroke()
  }
}

export function RoiOverlay(props: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [preview, setPreview] = useState<RoiPoint | undefined>(undefined) // source-normalized

  const poly = useMemo(() => roi.polygon, [roi.polygon])

  useEffect(() => {
    const anchor = props.anchorRef.current
    const canvas = canvasRef.current
    if (!anchor || !canvas) return

    let raf = 0
    const redraw = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = anchor.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        canvas.style.width = `${r.width}px`
        canvas.style.height = `${r.height}px`
        canvas.width = Math.max(1, Math.floor(r.width * dpr))
        canvas.height = Math.max(1, Math.floor(r.height * dpr))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const src = getSourceSize(anchor)
        if (!src) {
          ctx.clearRect(0, 0, r.width, r.height)
          return
        }
        drawPolygon(ctx, poly, r.width, r.height, src.w, src.h, roi.closed ? undefined : preview, roi.closed)
      })
    }

    redraw()

    const ro = new ResizeObserver(() => redraw())
    ro.observe(anchor)
    window.addEventListener('resize', redraw, { passive: true })

    return () => {
      window.removeEventListener('resize', redraw)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [poly, preview, props.anchorRef, roi.closed])

  if (!roi.enabled) return null

  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      onMouseMove={(e) => {
        if (roi.closed) return
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
        const anchor = props.anchorRef.current
        const src = getSourceSize(anchor)
        if (!src) return
        const dx = e.clientX - rect.left
        const dy = e.clientY - rect.top
        const p = displayToSrcNorm(dx, dy, rect.width, rect.height, src.w, src.h)
        setPreview(p ?? undefined)
      }}
      onMouseLeave={() => setPreview(undefined)}
      onClick={(e) => {
        if (roi.closed) return
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
        const anchor = props.anchorRef.current
        const src = getSourceSize(anchor)
        if (!src) return
        const dx = e.clientX - rect.left
        const dy = e.clientY - rect.top
        const p = displayToSrcNorm(dx, dy, rect.width, rect.height, src.w, src.h)
        if (!p) return

        // 点击第一个点附近 => 自动闭合（更好用）
        const poly2 = normalizePoly(roi.polygon)
        if (poly2.length >= 3) {
          const first = poly2[0]
          const pd = srcNormToDisplay(p, rect.width, rect.height, src.w, src.h)
          const fd = srcNormToDisplay(first, rect.width, rect.height, src.w, src.h)
          const hitRadius = 14 // px
          if (dist2(pd.x, pd.y, fd.x, fd.y) <= hitRadius * hitRadius) {
            setRoi({ polygon: poly2, closed: true })
            setPreview(undefined)
            return
          }
        }

        setRoi({ polygon: [...poly2, p], closed: false })
      }}
      onDoubleClick={() => {
        const poly2 = normalizePoly(roi.polygon)
        if (poly2.length >= 3) {
          setRoi({ polygon: poly2, closed: true })
          setPreview(undefined)
        }
      }}
    />
  )
}


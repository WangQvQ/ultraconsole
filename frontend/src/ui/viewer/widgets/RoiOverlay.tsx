import { useEffect, useRef, useState } from 'react'
import { useConsoleStore, type RoiPoint } from '../../../store/useConsoleStore'
import styles from './RoiOverlay.module.css'

/* ---- utils ---- */

function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
function dist2(ax: number, ay: number, bx: number, by: number) { return (ax - bx) ** 2 + (ay - by) ** 2 }
function samePoint(a: RoiPoint, b: RoiPoint) { return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 }
function normalizePoly(poly: RoiPoint[]) {
  if (poly.length >= 2 && samePoint(poly[0], poly[poly.length - 1])) return poly.slice(0, -1)
  return poly
}

function getSourceSize(el: HTMLElement | null): { w: number; h: number } | null {
  if (!el) return null
  const any = el as any
  const w = Number(any.naturalWidth ?? any.videoWidth ?? 0)
  const h = Number(any.naturalHeight ?? any.videoHeight ?? 0)
  return w && h ? { w, h } : null
}

function fitContain(rectW: number, rectH: number, srcW: number, srcH: number) {
  const scale = Math.min(rectW / srcW, rectH / srcH)
  return { scale, offX: (rectW - srcW * scale) / 2, offY: (rectH - srcH * scale) / 2, drawW: srcW * scale, drawH: srcH * scale }
}

function toNorm(cx: number, cy: number, rectW: number, rectH: number, srcW: number, srcH: number): RoiPoint {
  const { scale, offX, offY } = fitContain(rectW, rectH, srcW, srcH)
  return { x: clamp01((cx - offX) / scale / srcW), y: clamp01((cy - offY) / scale / srcH) }
}

function toNormOrNull(cx: number, cy: number, rectW: number, rectH: number, srcW: number, srcH: number): RoiPoint | null {
  const { scale, offX, offY, drawW, drawH } = fitContain(rectW, rectH, srcW, srcH)
  if (cx < offX || cy < offY || cx > offX + drawW || cy > offY + drawH) return null
  return { x: clamp01((cx - offX) / scale / srcW), y: clamp01((cy - offY) / scale / srcH) }
}

function toDisplay(p: RoiPoint, rectW: number, rectH: number, srcW: number, srcH: number) {
  const { scale, offX, offY } = fitContain(rectW, rectH, srcW, srcH)
  return { x: offX + p.x * srcW * scale, y: offY + p.y * srcH * scale }
}

/* ---- draw ---- */

function drawPoly(
  ctx: CanvasRenderingContext2D, poly: RoiPoint[],
  rw: number, rh: number, sw: number, sh: number,
  preview?: RoiPoint, closed?: boolean,
) {
  const pts = normalizePoly(poly)
  ctx.clearRect(0, 0, rw, rh)
  if (pts.length === 0 && !preview) return

  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(45, 212, 255, 0.95)'
  ctx.fillStyle = 'rgba(45, 212, 255, 0.08)'

  const all = preview ? [...pts, preview] : pts
  if (all.length >= 2) {
    ctx.beginPath()
    const p0 = toDisplay(all[0], rw, rh, sw, sh)
    ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < all.length; i++) { const pi = toDisplay(all[i], rw, rh, sw, sh); ctx.lineTo(pi.x, pi.y) }
    const isClosed = (closed || (!preview && pts.length >= 3)) && pts.length >= 3
    if (isClosed) ctx.closePath()
    ctx.stroke()
    if (isClosed) ctx.fill()
  }

  for (let i = 0; i < pts.length; i++) {
    const dp = toDisplay(pts[i], rw, rh, sw, sh)
    ctx.beginPath()
    ctx.arc(dp.x, dp.y, i === 0 ? 8 : 7, 0, Math.PI * 2)
    ctx.fillStyle = i === 0 ? 'rgba(255,255,255,0.92)' : 'rgba(76,255,122,0.95)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.stroke()
  }
}

function drawRect(
  ctx: CanvasRenderingContext2D, a: RoiPoint, b: RoiPoint,
  rw: number, rh: number, sw: number, sh: number,
) {
  ctx.clearRect(0, 0, rw, rh)
  const da = toDisplay(a, rw, rh, sw, sh)
  const db = toDisplay(b, rw, rh, sw, sh)
  const x = Math.min(da.x, db.x), y = Math.min(da.y, db.y)
  const w = Math.abs(da.x - db.x), h = Math.abs(da.y - db.y)
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(45, 212, 255, 0.95)'
  ctx.fillStyle = 'rgba(45, 212, 255, 0.08)'
  ctx.strokeRect(x, y, w, h)
  ctx.fillRect(x, y, w, h)
}

/* ---- component ---- */

export function RoiOverlay(props: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [preview, setPreview] = useState<RoiPoint | undefined>(undefined)

  // refs for use inside event listeners (avoid stale closures)
  const roiRef = useRef(roi)
  useEffect(() => { roiRef.current = roi }, [roi])
  const setRoiRef = useRef(setRoi)
  useEffect(() => { setRoiRef.current = setRoi }, [setRoi])

  /* ---- main effect: resize + draw + events ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let alive = true
    let raf = 0

    // drag state (raw canvas-pixel coords)
    let dragSX = 0, dragSY = 0, dragCX = 0, dragCY = 0
    let dragging = false

    function getCtx() {
      const ctx = canvas.getContext('2d')
      return ctx
    }

    function sizeCanvas(anchor: HTMLElement) {
      const r = anchor.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
      const ctx = getCtx()
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return r
    }

    function redraw() {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!alive) return
        const anchor = props.anchorRef.current
        if (!anchor) return
        const r = sizeCanvas(anchor)
        const ctx = getCtx()
        if (!ctx) return
        const src = getSourceSize(anchor)
        if (!src) { ctx.clearRect(0, 0, r.width, r.height); return }

        const s = roiRef.current
        if (s.mode === 'rect' && dragging) {
          const a = toNorm(dragSX, dragSY, r.width, r.height, src.w, src.h)
          const b = toNorm(dragCX, dragCY, r.width, r.height, src.w, src.h)
          drawRect(ctx, a, b, r.width, r.height, src.w, src.h)
        } else {
          const pv = (s.mode === 'poly' && !s.closed) ? previewRef.current : undefined
          drawPoly(ctx, s.polygon, r.width, r.height, src.w, src.h, pv, s.closed)
        }
      })
    }

    // preview ref for draw loop
    const previewRef = { current: preview as RoiPoint | undefined }
    // sync preview from React state
    // (we update previewRef in the poly mousemove handler below)

    /* ---- mouse coord helpers ---- */
    function canvasXY(e: MouseEvent): { x: number; y: number } {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    function anchorSrc() {
      const anchor = props.anchorRef.current
      const src = getSourceSize(anchor)
      return src
    }
    function canvasRect() { return canvas.getBoundingClientRect() }

    /* ---- rect drag handlers (document-level) ---- */
    function onDocMove(e: MouseEvent) {
      if (!dragging) return
      const { x, y } = canvasXY(e)
      dragCX = x
      dragCY = y
      redraw()
    }
    function onDocUp(e: MouseEvent) {
      if (!dragging) return
      dragging = false
      document.removeEventListener('mousemove', onDocMove)
      document.removeEventListener('mouseup', onDocUp)

      const r = canvasRect()
      const src = anchorSrc()
      if (!src) { redraw(); return }

      const a = toNorm(dragSX, dragSY, r.width, r.height, src.w, src.h)
      const b = toNorm(dragCX, dragCY, r.width, r.height, src.w, src.h)
      const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y)
      const maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y)

      if (maxX - minX > 0.005 && maxY - minY > 0.005) {
        setRoiRef.current({
          polygon: [
            { x: minX, y: minY }, { x: maxX, y: minY },
            { x: maxX, y: maxY }, { x: minX, y: maxY },
          ],
          closed: true,
        })
      }
      redraw()
    }

    /* ---- canvas event listeners ---- */
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return
      const s = roiRef.current
      if (!s.enabled) return

      const { x, y } = canvasXY(e)
      const r = canvasRect()
      const src = anchorSrc()
      if (!src) return

      if (s.mode === 'rect') {
        dragging = true
        dragSX = x; dragSY = y
        dragCX = x; dragCY = y
        document.addEventListener('mousemove', onDocMove)
        document.addEventListener('mouseup', onDocUp)
        redraw()
        return
      }

      // poly mode
      if (s.closed) return
      const p = toNormOrNull(x, y, r.width, r.height, src.w, src.h)
      if (!p) return
      const poly2 = normalizePoly(s.polygon)
      if (poly2.length >= 3) {
        const first = toDisplay(poly2[0], r.width, r.height, src.w, src.h)
        if (dist2(x, y, first.x, first.y) <= 14 * 14) {
          setRoiRef.current({ polygon: poly2, closed: true })
          previewRef.current = undefined
          setPreview(undefined)
          redraw()
          return
        }
      }
      setRoiRef.current({ polygon: [...poly2, p], closed: false })
      redraw()
    }

    function onMouseMove(e: MouseEvent) {
      const s = roiRef.current
      if (!s.enabled || s.closed) return
      if (s.mode === 'rect') return // rect preview handled by document listener

      const { x, y } = canvasXY(e)
      const r = canvasRect()
      const src = anchorSrc()
      if (!src) return
      const p = toNormOrNull(x, y, r.width, r.height, src.w, src.h)
      previewRef.current = p ?? undefined
      setPreview(p ?? undefined)
      redraw()
    }

    function onMouseLeave() {
      const s = roiRef.current
      if (s.mode === 'poly') {
        previewRef.current = undefined
        setPreview(undefined)
        redraw()
      }
    }

    function onDblClick(e: MouseEvent) {
      const s = roiRef.current
      if (s.mode !== 'poly' || s.closed) return
      const poly2 = normalizePoly(s.polygon)
      if (poly2.length >= 3) {
        setRoiRef.current({ polygon: poly2, closed: true })
        previewRef.current = undefined
        setPreview(undefined)
        redraw()
      }
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)
    canvas.addEventListener('dblclick', onDblClick)

    /* ---- resize observer on anchor ---- */
    let ro: ResizeObserver | null = null
    let observed: HTMLElement | null = null

    function bind(anchor: HTMLElement) {
      if (observed === anchor) return
      ro?.disconnect()
      ro = new ResizeObserver(() => redraw())
      ro.observe(anchor)
      observed = anchor
      redraw()
    }

    let loopRaf = 0
    function loopBind() {
      if (!alive) return
      const anchor = props.anchorRef.current
      if (anchor) { bind(anchor); return }
      loopRaf = requestAnimationFrame(loopBind)
    }

    const onResize = () => { const a = props.anchorRef.current; if (a) redraw() }
    window.addEventListener('resize', onResize, { passive: true })
    loopBind()

    return () => {
      alive = false
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('dblclick', onDblClick)
      // 拖拽中卸载也要清理 document 级监听
      document.removeEventListener('mousemove', onDocMove)
      document.removeEventListener('mouseup', onDocUp)
      dragging = false
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(loopRaf)
    }
  }, [props.anchorRef, roi.enabled]) // rebind when anchor changes or ROI toggled on

  // redraw when store state changes
  const roiKey = `${roi.enabled}-${roi.mode}-${roi.closed}-${roi.polygon.length}`
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const anchor = props.anchorRef.current
    if (!anchor) return
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
    if (!src) { ctx.clearRect(0, 0, r.width, r.height); return }
    const pv = (roi.mode === 'poly' && !roi.closed) ? preview : undefined
    drawPoly(ctx, roi.polygon, r.width, r.height, src.w, src.h, pv, roi.closed)
  }, [roiKey, preview, roi.polygon, props.anchorRef])

  if (!roi.enabled) return null

  return <canvas ref={canvasRef} className={styles.canvas} />
}

import { useEffect, useRef, useState } from 'react'
import { useConsoleStore, type CountingLine, type CountingZone, type RoiPointXY } from '../../../store/useConsoleStore'
import { fitContain } from '../../../utils/draw'
import styles from './EventEditOverlay.module.css'

type Mode = 'line' | 'zone'

function genId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`
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

function displayToSrcNorm(x: number, y: number, rectW: number, rectH: number, srcW: number, srcH: number): RoiPointXY | null {
  const fc = fitContain(rectW, rectH, srcW, srcH)
  if (x < fc.offX || y < fc.offY || x > fc.offX + fc.drawW || y > fc.offY + fc.drawH) return null
  return {
    x: Math.max(0, Math.min(1, (x - fc.offX) / fc.scale / srcW)),
    y: Math.max(0, Math.min(1, (y - fc.offY) / fc.scale / srcH)),
  }
}

export function EventEditOverlay(props: {
  anchorRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  mode: Mode
  onClose?: () => void
}) {
  const eventsConfig = useConsoleStore((s) => s.eventsConfig)
  const setEventsConfig = useConsoleStore((s) => s.setEventsConfig)
  const roiEnabled = useConsoleStore((s) => s.roi.enabled)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [previewLine, setPreviewLine] = useState<{ a: RoiPointXY; b?: RoiPointXY } | null>(null)
  const [zoneDraft, setZoneDraft] = useState<RoiPointXY[]>([])
  const [hoverPt, setHoverPt] = useState<RoiPointXY | null>(null)

  // 切换模式时清空草稿
  useEffect(() => {
    setPreviewLine(null)
    setZoneDraft([])
    setHoverPt(null)
  }, [props.mode, props.enabled])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const anchor = props.anchorRef.current
    if (!anchor) return

    const draw = () => {
      const r = anchor.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, r.width, r.height)
      const src = getSourceSize(anchor)
      if (!src) return
      const fc = fitContain(r.width, r.height, src.w, src.h)
      const toDx = (p: RoiPointXY) => fc.offX + p.x * src.w * fc.scale
      const toDy = (p: RoiPointXY) => fc.offY + p.y * src.h * fc.scale

      // 已有 lines / zones（半透明显示）
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.55)'
      for (const l of eventsConfig.lines) {
        ctx.beginPath()
        ctx.moveTo(toDx(l.a), toDy(l.a))
        ctx.lineTo(toDx(l.b), toDy(l.b))
        ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(255, 99, 132, 0.55)'
      ctx.fillStyle = 'rgba(255, 99, 132, 0.08)'
      for (const z of eventsConfig.zones) {
        if (z.polygon.length < 3) continue
        ctx.beginPath()
        ctx.moveTo(toDx(z.polygon[0]), toDy(z.polygon[0]))
        for (let i = 1; i < z.polygon.length; i++) {
          ctx.lineTo(toDx(z.polygon[i]), toDy(z.polygon[i]))
        }
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }

      // 草稿 line
      if (props.mode === 'line' && previewLine?.a) {
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.95)'
        const ax = toDx(previewLine.a)
        const ay = toDy(previewLine.a)
        ctx.beginPath()
        ctx.arc(ax, ay, 5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)'
        ctx.fill()
        const end = previewLine.b ?? hoverPt ?? previewLine.a
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(toDx(end), toDy(end))
        ctx.stroke()
      }

      // 草稿 zone
      if (props.mode === 'zone' && (zoneDraft.length > 0 || hoverPt)) {
        ctx.lineWidth = 2
        ctx.strokeStyle = 'rgba(255, 99, 132, 0.95)'
        ctx.fillStyle = 'rgba(255, 99, 132, 0.12)'
        const pts = hoverPt ? [...zoneDraft, hoverPt] : zoneDraft
        if (pts.length >= 1) {
          ctx.beginPath()
          ctx.moveTo(toDx(pts[0]), toDy(pts[0]))
          for (let i = 1; i < pts.length; i++) ctx.lineTo(toDx(pts[i]), toDy(pts[i]))
          if (zoneDraft.length >= 3) ctx.closePath()
          ctx.stroke()
          if (zoneDraft.length >= 3) ctx.fill()
        }
        for (let i = 0; i < zoneDraft.length; i++) {
          const p = zoneDraft[i]
          ctx.beginPath()
          ctx.arc(toDx(p), toDy(p), i === 0 ? 6 : 5, 0, Math.PI * 2)
          ctx.fillStyle = i === 0 ? 'rgba(255,255,255,0.95)' : 'rgba(255, 99, 132, 0.95)'
          ctx.fill()
        }
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(anchor)
    window.addEventListener('resize', draw, { passive: true })
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [eventsConfig, previewLine, zoneDraft, hoverPt, props.mode, props.anchorRef])

  if (!props.enabled) return null

  return (
    <canvas
      ref={canvasRef}
      className={`${styles.canvas} ${roiEnabled ? '' : styles.active}`}
      onPointerMove={(e) => {
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
        const src = getSourceSize(props.anchorRef.current)
        if (!src) return
        const p = displayToSrcNorm(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, src.w, src.h)
        setHoverPt(p)
      }}
      onPointerLeave={() => setHoverPt(null)}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
        const src = getSourceSize(props.anchorRef.current)
        if (!src) return
        const p = displayToSrcNorm(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, src.w, src.h)
        if (!p) return
        if (props.mode === 'line') {
          if (!previewLine?.a) {
            setPreviewLine({ a: p })
          } else {
            const newLine: CountingLine = {
              id: genId('line'),
              name: `L${eventsConfig.lines.length + 1}`,
              a: previewLine.a,
              b: p,
            }
            setEventsConfig({ lines: [...eventsConfig.lines, newLine] })
            setPreviewLine(null)
          }
        } else {
          // zone
          if (zoneDraft.length >= 3) {
            const first = zoneDraft[0]
            const fc = fitContain(rect.width, rect.height, src.w, src.h)
            const fdx = fc.offX + first.x * src.w * fc.scale
            const fdy = fc.offY + first.y * src.h * fc.scale
            const cdx = e.clientX - rect.left
            const cdy = e.clientY - rect.top
            if ((fdx - cdx) ** 2 + (fdy - cdy) ** 2 <= 14 * 14) {
              const newZone: CountingZone = {
                id: genId('zone'),
                name: `Z${eventsConfig.zones.length + 1}`,
                polygon: zoneDraft,
              }
              setEventsConfig({ zones: [...eventsConfig.zones, newZone] })
              setZoneDraft([])
              return
            }
          }
          setZoneDraft([...zoneDraft, p])
        }
      }}
      onDoubleClick={() => {
        if (props.mode === 'zone' && zoneDraft.length >= 3) {
          const newZone: CountingZone = {
            id: genId('zone'),
            name: `Z${eventsConfig.zones.length + 1}`,
            polygon: zoneDraft,
          }
          setEventsConfig({ zones: [...eventsConfig.zones, newZone] })
          setZoneDraft([])
        }
      }}
    />
  )
}

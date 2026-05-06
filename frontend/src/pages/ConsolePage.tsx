import { useEffect, useMemo, useRef, useState } from 'react'
import { ControlPanel } from '../ui/control/ControlPanel'
import { MonitorPanel } from '../ui/monitor/MonitorPanel'
import { SystemStatusBar } from '../ui/status/SystemStatusBar'
import { ViewerPanel } from '../ui/viewer/ViewerPanel'
import styles from './ConsolePage.module.css'

const clampLeft = (n: number) => Math.max(240, Math.min(560, Number.isFinite(n) ? n : 340))
const clampRight = (n: number) => Math.max(260, Math.min(620, Number.isFinite(n) ? n : 360))
const clampBottom = (n: number) => Math.max(180, Math.min(560, Number.isFinite(n) ? n : 280))

export function ConsolePage() {
  const [leftW, setLeftW] = useState<number>(() => clampLeft(Number(localStorage.getItem('layout.leftW') || 340)))
  const [rightW, setRightW] = useState<number>(() => clampRight(Number(localStorage.getItem('layout.rightW') || 360)))
  const [bottomH, setBottomH] = useState<number>(() => clampBottom(Number(localStorage.getItem('layout.bottomH') || 280)))
  const [resizing, setResizing] = useState<'left' | 'right' | 'bottom' | null>(null)

  const dragRef = useRef<{
    kind: 'left' | 'right' | 'bottom'
    startX: number
    startY: number
    startLeftW: number
    startRightW: number
    startBottomH: number
  } | null>(null)

  const shellStyle = useMemo(
    () => ({ ['--left-w' as any]: `${leftW}px`, ['--right-w' as any]: `${rightW}px`, ['--bottom-h' as any]: `${bottomH}px` }),
    [leftW, rightW, bottomH],
  )

  useEffect(() => {
    localStorage.setItem('layout.leftW', String(leftW))
  }, [leftW])

  useEffect(() => {
    localStorage.setItem('layout.rightW', String(rightW))
  }, [rightW])

  useEffect(() => {
    localStorage.setItem('layout.bottomH', String(bottomH))
  }, [bottomH])

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const dy = ev.clientY - dragRef.current.startY
      if (dragRef.current.kind === 'left') setLeftW(clampLeft(dragRef.current.startLeftW + dx))
      else if (dragRef.current.kind === 'right') setRightW(clampRight(dragRef.current.startRightW - dx))
      else setBottomH(clampBottom(dragRef.current.startBottomH - dy))
    }
    const onUp = () => {
      dragRef.current = null
      setResizing(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div className={[styles.shell, resizing ? styles.resizing : ''].filter(Boolean).join(' ')} style={shellStyle}>
      <header className={styles.topbar}>
        <SystemStatusBar />
      </header>
      <aside className={styles.left}>
        <ControlPanel />
      </aside>

      <div
        className={styles.resizer}
        onPointerDown={(e) => {
          if (window.matchMedia('(max-width: 1100px)').matches) return
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { kind: 'left', startX: e.clientX, startY: e.clientY, startLeftW: leftW, startRightW: rightW, startBottomH: bottomH }
          setResizing('left')
        }}
      />

      <main className={styles.center}>
        <ViewerPanel />
      </main>

      <div
        className={styles.vResizer}
        onPointerDown={(e) => {
          // 仅在右栏下沉（上下布局）时启用
          if (!window.matchMedia('(max-width: 1100px)').matches) return
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { kind: 'bottom', startX: e.clientX, startY: e.clientY, startLeftW: leftW, startRightW: rightW, startBottomH: bottomH }
          setResizing('bottom')
        }}
      />

      <div
        className={styles.resizer}
        onPointerDown={(e) => {
          if (window.matchMedia('(max-width: 1100px)').matches) return
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { kind: 'right', startX: e.clientX, startY: e.clientY, startLeftW: leftW, startRightW: rightW, startBottomH: bottomH }
          setResizing('right')
        }}
      />

      <aside className={styles.right}>
        <MonitorPanel />
      </aside>
    </div>
  )
}


import { useEffect, useRef } from 'react'
import { useConsoleStore } from '../store/useConsoleStore'
import { newTrackerState, processFrame } from './events'

/**
 * 监听 lastPred，对带 trackId 的 bbox 做线穿越/区域进出检测，
 * 把 events/counters 写回 store。
 * 没启用 tracking 时本 hook 实际为 no-op。
 */
export function useEventTracker() {
  const lastPred = useConsoleStore((s) => s.lastPred)
  const eventsConfig = useConsoleStore((s) => s.eventsConfig)
  const pushEvent = useConsoleStore((s) => s.pushEvent)
  const bumpLineCounter = useConsoleStore((s) => s.bumpLineCounter)
  const setZoneCount = useConsoleStore((s) => s.setZoneCount)

  const stateRef = useRef(newTrackerState())
  const lastFrameKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!lastPred) return
    const key = String(lastPred.frameId ?? lastPred.ts)
    if (lastFrameKeyRef.current === key) return
    lastFrameKeyRef.current = key

    const result = processFrame({
      state: stateRef.current,
      bboxes: lastPred.bboxes,
      width: lastPred.width,
      height: lastPred.height,
      lines: eventsConfig.lines,
      zones: eventsConfig.zones,
      classFilter: eventsConfig.classes,
      ts: lastPred.ts,
    })

    for (const e of result.events) pushEvent(e)
    for (const [lineId, c] of Object.entries(result.lineCounts)) {
      for (let i = 0; i < c.in; i++) bumpLineCounter(lineId, 'in')
      for (let i = 0; i < c.out; i++) bumpLineCounter(lineId, 'out')
    }
    for (const [zoneId, c] of Object.entries(result.zoneCounts)) {
      setZoneCount(zoneId, c.current, c.deltaTotal)
    }
  }, [lastPred, eventsConfig, pushEvent, bumpLineCounter, setZoneCount])
}

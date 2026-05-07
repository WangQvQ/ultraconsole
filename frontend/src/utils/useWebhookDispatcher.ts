import { useEffect, useRef } from 'react'
import { apiNotify, type NotifyKind, type NotifyRequest } from '../api/client'
import { useConsoleStore, type EventEntry } from '../store/useConsoleStore'

/**
 * 监听 alert.active 与 events 增量，按需 POST /api/notify。
 * 后端再做格式化、限频、转发到 webhook。
 *
 * 这里只负责"何时派发"——做幂等：
 *  - alert：仅在 active false→true 边沿派发一次
 *  - events：每次 events 数组增长，把新增项派发；批量 4 条/秒上限
 */

const DISPATCH_BATCH_INTERVAL = 250 // ms

export function useWebhookDispatcher() {
  const alert = useConsoleStore((s) => s.alert)
  const alertConfig = useConsoleStore((s) => s.alertConfig)
  const events = useConsoleStore((s) => s.events)
  const eventsConfig = useConsoleStore((s) => s.eventsConfig)
  const modelId = useConsoleStore((s) => s.currentModelId)

  // alert 边沿
  const prevAlertActiveRef = useRef(false)
  useEffect(() => {
    if (alert.active && !prevAlertActiveRef.current) {
      const req: NotifyRequest = {
        kind: 'alert',
        level: 'WARN',
        title: '告警触发',
        msg: alert.reason || `class=${alertConfig.targetClass} streak=${alert.streak}`,
        ref: alertConfig.targetClass || 'alert',
        fields: {
          targetClass: alertConfig.targetClass,
          minFrames: alertConfig.minFrames,
          streak: alert.streak,
          modelId,
        },
      }
      void apiNotify(req).catch(() => {})
    }
    prevAlertActiveRef.current = alert.active
  }, [alert.active, alert.reason, alert.streak, alertConfig.targetClass, alertConfig.minFrames, modelId])

  // events 增量
  const lastEventsLenRef = useRef(events.length)
  const pendingRef = useRef<EventEntry[]>([])
  const flushTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const prevLen = lastEventsLenRef.current
    if (events.length > prevLen) {
      const added = events.slice(prevLen)
      pendingRef.current.push(...added)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null
          const batch = pendingRef.current.splice(0, pendingRef.current.length)
          for (const e of batch) {
            const kind: NotifyKind = e.kind
            const ref = e.ref
            const name =
              e.kind === 'line.cross'
                ? eventsConfig.lines.find((l) => l.id === ref)?.name || ref
                : eventsConfig.zones.find((z) => z.id === ref)?.name || ref
            const title =
              e.kind === 'line.cross'
                ? `计数线 ${name} ${e.direction ?? ''}`
                : e.kind === 'zone.enter'
                  ? `进入区域 ${name}`
                  : `离开区域 ${name}`
            const req: NotifyRequest = {
              kind,
              level: 'WARN',
              title,
              msg: `${e.cls}#${e.trackId ?? '-'}`,
              ref,
              fields: { trackId: e.trackId, cls: e.cls, direction: e.direction, modelId },
            }
            void apiNotify(req).catch(() => {})
          }
        }, DISPATCH_BATCH_INTERVAL)
      }
    }
    lastEventsLenRef.current = events.length
  }, [events, eventsConfig, modelId])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    }
  }, [])
}

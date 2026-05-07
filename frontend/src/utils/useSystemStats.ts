import { useEffect } from 'react'
import { apiSystemStats } from '../api/client'
import { useConsoleStore } from '../store/useConsoleStore'

export function useSystemStats(intervalMs = 1500) {
  const setSystemStats = useConsoleStore((s) => s.setSystemStats)

  useEffect(() => {
    let alive = true
    let timer: number | null = null

    const tick = async () => {
      try {
        const s = await apiSystemStats()
        if (alive) setSystemStats(s)
      } catch {
        // ignore
      }
      if (alive) timer = window.setTimeout(tick, intervalMs)
    }
    void tick()

    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [intervalMs, setSystemStats])
}

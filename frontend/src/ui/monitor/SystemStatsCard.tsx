import { useMemo } from 'react'
import { useConsoleStore, type LatencyStats } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import styles from './SystemStatsCard.module.css'

function fmtMb(x?: number) {
  if (x === undefined || x === null) return '--'
  if (x >= 1024) return `${(x / 1024).toFixed(1)}GB`
  return `${x.toFixed(0)}MB`
}
function fmtPct(x?: number) {
  if (x === undefined || x === null) return '--'
  return `${x.toFixed(0)}%`
}
function fmtMs(x?: number) {
  if (x === undefined || x === null) return '--'
  return `${x.toFixed(1)}ms`
}

function Sparkline(props: { data: number[]; max?: number; height?: number }) {
  const path = useMemo(() => {
    const data = props.data
    if (!data || data.length === 0) return ''
    const w = 120
    const h = props.height ?? 28
    const max = props.max ?? Math.max(1, ...data)
    const stepX = w / Math.max(1, data.length - 1)
    return data
      .map((v, i) => {
        const x = i * stepX
        const y = h - (Math.min(v, max) / max) * h
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }, [props.data, props.max, props.height])
  const h = props.height ?? 28
  return (
    <svg className={styles.sparkline} width="120" height={h} viewBox={`0 0 120 ${h}`}>
      <path d={path} fill="none" stroke="rgba(76,255,122,0.95)" strokeWidth="1.5" />
    </svg>
  )
}

function LatencyRow({ lat }: { lat: LatencyStats }) {
  const max = useMemo(() => {
    if (!lat.recentMs || lat.recentMs.length === 0) return 1
    return Math.max(1, lat.p99Ms ?? Math.max(...lat.recentMs))
  }, [lat])
  return (
    <div className={styles.latency}>
      <div className={styles.latencyStats}>
        <span>P50 <b>{fmtMs(lat.p50Ms)}</b></span>
        <span>P95 <b>{fmtMs(lat.p95Ms)}</b></span>
        <span>P99 <b>{fmtMs(lat.p99Ms)}</b></span>
        <span>n={lat.count}</span>
      </div>
      <Sparkline data={lat.recentMs ?? []} max={max} />
    </div>
  )
}

export function SystemStatsCard() {
  const stats = useConsoleStore((s) => s.systemStats)

  return (
    <Card title="System Stats" right={stats ? new Date(stats.ts * 1000).toLocaleTimeString() : '--'}>
      {!stats ? (
        <div className={styles.hint}>采集中…</div>
      ) : (
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.k}>CPU</span>
            <span className={styles.v}>
              {fmtPct(stats.cpuPct)} {stats.cpuCount ? `· ${stats.cpuCount} core` : ''}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Mem</span>
            <span className={styles.v}>
              {fmtMb(stats.memUsedMb)} / {fmtMb(stats.memTotalMb)} ({fmtPct(stats.memPct)})
            </span>
          </div>

          {stats.gpus.length === 0 ? (
            <div className={styles.row}>
              <span className={styles.k}>GPU</span>
              <span className={styles.v}>无 / NVML 不可用</span>
            </div>
          ) : (
            stats.gpus.map((g) => (
              <div key={g.index} className={styles.gpu}>
                <div className={styles.row}>
                  <span className={styles.k}>GPU{g.index}</span>
                  <span className={styles.v} title={g.name}>{g.name}</span>
                </div>
                <div className={styles.subRow}>
                  <span>util {fmtPct(g.utilPct)}</span>
                  <span>mem {fmtMb(g.memUsedMb)}/{fmtMb(g.memTotalMb)}</span>
                  <span>{g.tempC !== undefined ? `${g.tempC.toFixed(0)}°C` : '--'}</span>
                  <span>{g.powerW !== undefined ? `${g.powerW.toFixed(0)}W` : '--'}</span>
                </div>
              </div>
            ))
          )}

          <div className={styles.divider} />
          <div className={styles.subTitle}>Inference Latency</div>
          <LatencyRow lat={stats.inferLatency} />
        </div>
      )}
    </Card>
  )
}

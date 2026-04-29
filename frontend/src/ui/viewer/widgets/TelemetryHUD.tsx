import type { Telemetry } from '../../../store/useConsoleStore'
import styles from './TelemetryHUD.module.css'

function fmtMs(x?: number) {
  if (x === undefined || x === null || Number.isNaN(x)) return '--'
  return `${x.toFixed(1)}ms`
}

function fmtFps(x?: number) {
  if (x === undefined || x === null || Number.isNaN(x)) return '--'
  return x.toFixed(1)
}

export function TelemetryHUD(props: { telemetry?: Telemetry }) {
  const t = props.telemetry
  if (!t) return null
  return (
    <div className={styles.hud}>
      <div className={styles.row}>
        <span className={styles.k}>FPS</span>
        <span className={styles.v}>{fmtFps(t.fps)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.k}>Pre</span>
        <span className={styles.v}>{fmtMs(t.preprocessMs)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.k}>Inf</span>
        <span className={styles.v}>{fmtMs(t.inferenceMs)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.k}>Post</span>
        <span className={styles.v}>{fmtMs(t.postprocessMs)}</span>
      </div>
    </div>
  )
}


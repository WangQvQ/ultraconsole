import { useConsoleStore } from '../../store/useConsoleStore'
import styles from './SystemStatusBar.module.css'

function fmtFps(x?: number) {
  if (x === undefined || x === null || Number.isNaN(x)) return '--'
  return x.toFixed(1)
}

export function SystemStatusBar() {
  const modelId = useConsoleStore((s) => s.currentModelId)
  const device = useConsoleStore((s) => s.engine.device)
  const conns = useConsoleStore((s) => s.connections)
  const fps = useConsoleStore((s) => s.telemetrySummary.fps)

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.item}>
          Model <span className={styles.value}>{modelId || '(none)'}</span>
        </span>
        <span className={styles.sep} />
        <span className={styles.item}>
          Device <span className={styles.value}>{device.toUpperCase()}</span>
        </span>
      </div>

      <div className={styles.right}>
        <span className={styles.item}>
          WS(Infer) <span className={[styles.state, styles[conns.inferWs]].join(' ')}>{conns.inferWs}</span>
        </span>
        <span className={styles.sep} />
        <span className={styles.item}>
          WS(RTSP) <span className={[styles.state, styles[conns.rtspWs]].join(' ')}>{conns.rtspWs}</span>
        </span>
        <span className={styles.sep} />
        <span className={styles.item}>
          FPS <span className={styles.fps}>{fmtFps(fps)}</span>
        </span>
      </div>
    </div>
  )
}


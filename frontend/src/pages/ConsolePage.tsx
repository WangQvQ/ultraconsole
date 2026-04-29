import { ControlPanel } from '../ui/control/ControlPanel'
import { MonitorPanel } from '../ui/monitor/MonitorPanel'
import { SystemStatusBar } from '../ui/status/SystemStatusBar'
import { ViewerPanel } from '../ui/viewer/ViewerPanel'
import styles from './ConsolePage.module.css'

export function ConsolePage() {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <SystemStatusBar />
      </header>
      <aside className={styles.left}>
        <ControlPanel />
      </aside>

      <main className={styles.center}>
        <ViewerPanel />
      </main>

      <aside className={styles.right}>
        <MonitorPanel />
      </aside>
    </div>
  )
}


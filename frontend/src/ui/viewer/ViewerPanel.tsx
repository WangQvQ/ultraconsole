import { useState } from 'react'
import { Card } from '../primitives/Card'
import { ImageTab } from './tabs/ImageTab'
import { RtspTab } from './tabs/RtspTab'
import { VideoTab } from './tabs/VideoTab'
import { WallTab } from './tabs/WallTab'
import { WebcamTab } from './tabs/WebcamTab'
import { TaskResults } from './widgets/TaskResults'
import { useConsoleStore } from '../../store/useConsoleStore'
import styles from './ViewerPanel.module.css'

type TabKey = 'image' | 'video' | 'rtsp' | 'webcam' | 'wall'

export function ViewerPanel() {
  const [tab, setTab] = useState<TabKey>('image')
  function changeTab(next: TabKey) {
    if (next === tab) return
    useConsoleStore.getState().setLastPred(undefined)
    setTab(next)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs}>
        <button className={[styles.tab, tab === 'image' ? styles.on : ''].join(' ')} onClick={() => changeTab('image')}>
          Image
        </button>
        <button className={[styles.tab, tab === 'video' ? styles.on : ''].join(' ')} onClick={() => changeTab('video')}>
          Video
        </button>
        <button className={[styles.tab, tab === 'rtsp' ? styles.on : ''].join(' ')} onClick={() => changeTab('rtsp')}>
          RTSP
        </button>
        <button className={[styles.tab, tab === 'webcam' ? styles.on : ''].join(' ')} onClick={() => changeTab('webcam')}>
          Webcam
        </button>
        <button className={[styles.tab, tab === 'wall' ? styles.on : ''].join(' ')} onClick={() => changeTab('wall')}>
          Wall
        </button>
      </div>

      <Card title="Core View">
        {tab === 'image' && <ImageTab />}
        {tab === 'video' && <VideoTab />}
        {tab === 'rtsp' && <RtspTab />}
        {tab === 'webcam' && <WebcamTab />}
        {tab === 'wall' && <WallTab />}
      </Card>
      <TaskResults />
    </div>
  )
}

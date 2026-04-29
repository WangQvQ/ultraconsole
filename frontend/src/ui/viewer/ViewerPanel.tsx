import { useState } from 'react'
import { Card } from '../primitives/Card'
import { ImageTab } from './tabs/ImageTab'
import { RtspTab } from './tabs/RtspTab'
import { VideoTab } from './tabs/VideoTab'
import { WebcamTab } from './tabs/WebcamTab'
import styles from './ViewerPanel.module.css'

type TabKey = 'image' | 'video' | 'rtsp' | 'webcam'

export function ViewerPanel() {
  const [tab, setTab] = useState<TabKey>('image')

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs}>
        <button className={[styles.tab, tab === 'image' ? styles.on : ''].join(' ')} onClick={() => setTab('image')}>
          Image
        </button>
        <button className={[styles.tab, tab === 'video' ? styles.on : ''].join(' ')} onClick={() => setTab('video')}>
          Video
        </button>
        <button className={[styles.tab, tab === 'rtsp' ? styles.on : ''].join(' ')} onClick={() => setTab('rtsp')}>
          RTSP
        </button>
        <button className={[styles.tab, tab === 'webcam' ? styles.on : ''].join(' ')} onClick={() => setTab('webcam')}>
          Webcam
        </button>
      </div>

      <Card title="Core View">
        {tab === 'image' && <ImageTab />}
        {tab === 'video' && <VideoTab />}
        {tab === 'rtsp' && <RtspTab />}
        {tab === 'webcam' && <WebcamTab />}
      </Card>
    </div>
  )
}


import { useMemo, useState } from 'react'
import { useT } from '../../../i18n'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { decodeDenseMap, denseMapNpy } from '../../../utils/denseMap'
import styles from './TaskResults.module.css'

export function TaskResults() {
  const t = useT()
  const pred = useConsoleStore((s) => s.lastPred)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const map = pred?.depth ?? pred?.semantic
  const decoded = useMemo(() => map ? decodeDenseMap(map) : null, [map])
  if (!pred || (!map && !pred.classifications?.length)) return null
  const value = point && decoded ? decoded.read(point.x, point.y) : null
  function download() {
    if (!map) return
    const url = URL.createObjectURL(new Blob([denseMapNpy(map)], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${map.unit === 'm' ? 'depth' : 'semantic'}_${map.width}x${map.height}.npy`
    link.click()
    URL.revokeObjectURL(url)
  }
  return <details className={styles.wrap}>
    <summary>{t(`tasks.${pred.taskType}`)} · {map?.modelId ?? pred.modelId}</summary>
    {!!pred.classifications?.length && <ol>{pred.classifications.map((c) => <li key={c.cls}>{c.cls} · {(c.conf * 100).toFixed(2)}%</li>)}</ol>}
    {map && <div className={styles.content}>
      <img className={styles.preview} src={`data:image/png;base64,${map.pngBase64}`} alt={t(`tasks.${map.unit === 'm' ? 'depth' : 'semantic'}`)}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setPoint({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
        }} onPointerLeave={() => setPoint(null)} />
      <div>
        <p>{t('tasks.sampleHint', { width: map.width, height: map.height })}</p>
        {map.unit === 'm' && <>
          <p>{t('tasks.depthStats')} · {map.min?.toFixed(2) ?? '—'} / {map.median?.toFixed(2) ?? '—'} / {map.max?.toFixed(2) ?? '—'} m</p>
          <p>{t('tasks.colorScale')} · {map.colorMin}–{map.colorMax} m</p>
          <p>{t('tasks.metricHint')}</p>
        </>}
        <p aria-live="polite">{point ? `${Math.floor(point.x * pred.width)}, ${Math.floor(point.y * pred.height)} · ${value === null ? '—' : map.unit === 'm' ? `≈${value.toFixed(2)} m` : map.classes[String(value)] ?? String(value)}` : t('tasks.hoverHint')}</p>
        <button onClick={download}>{t('tasks.exportMap')}</button>
        <a href={`data:image/png;base64,${map.pngBase64}`} download="preview.png">{t('tasks.exportPreview')}</a>
      </div>
    </div>}
  </details>
}

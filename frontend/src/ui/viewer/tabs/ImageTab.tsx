import { useMemo, useRef, useState } from 'react'
import { apiInferImage } from '../../../api/client'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { downloadBadCaseZip } from '../../../utils/badcase'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { CanvasOverlay } from '../widgets/CanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import { TelemetryHUD } from '../widgets/TelemetryHUD.tsx'
import styles from './ImageTab.module.css'

export function ImageTab() {
  const params = useConsoleStore((s) => s.params)
  const osd = useConsoleStore((s) => s.osd)
  const setOSD = useConsoleStore((s) => s.setOSD)
  const setLastPred = useConsoleStore((s) => s.setLastPred)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alertActive = useConsoleStore((s) => s.alert.active)
  const alertConfig = useConsoleStore((s) => s.alertConfig)
  const roi = useConsoleStore((s) => s.roi)
  const setRoi = useConsoleStore((s) => s.setRoi)
  const modelId = useConsoleStore((s) => s.currentModelId)
  const device = useConsoleStore((s) => s.engine.device)
  const pushLog = useConsoleStore((s) => s.pushLog)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const filteredPred = useMemo(() => {
    if (!lastPred) return undefined
    if (!roi.applyFilter || roi.polygon.length < 3) return lastPred
    return {
      ...lastPred,
      bboxes: filterBBoxesByRoiNormalized({
        bboxes: lastPred.bboxes,
        roiPoly: roi.polygon,
        width: lastPred.width,
        height: lastPred.height,
      }),
    }
  }, [lastPred, roi.applyFilter, roi.polygon])
  const bboxes = useMemo(() => (filteredPred ? filteredPred.bboxes : []), [filteredPred])

  async function onPick(file?: File) {
    if (!file) return
    setBusy(true)
    setLastPred(undefined)
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    try {
      const pred = await apiInferImage(file)
      setLastPred(pred)
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'infer.image', msg: `bbox=${pred.bboxes.length}`, fields: {} })
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'infer.image_failed', msg: String(e), fields: {} })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <label className={styles.fileBtn}>
          <input
            className={styles.fileInput}
            type="file"
            accept="image/*"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          选择图片
        </label>
        <NeoButton
          onClick={() => {
            setLastPred(undefined)
            setImgUrl(undefined)
          }}
          disabled={busy}
        >
          清空
        </NeoButton>

        <div className={styles.divider} />

        <NeoButton
          onClick={async () => {
            if (!imgUrl) return
            try {
              const jpeg = await fetch(imgUrl).then((r) => r.blob())
              await downloadBadCaseZip({
                jpeg,
                config: {
                  ts: Date.now() / 1000,
                  modelId,
                  device,
                  params,
                  osd,
                  alertConfig,
                },
                pred: lastPred,
              })
              pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'badcase.saved', msg: 'image zip downloaded', fields: {} })
            } catch (e) {
              pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'badcase.failed', msg: String(e), fields: {} })
            }
          }}
          disabled={!imgUrl || busy}
        >
          📷 BadCase
        </NeoButton>

        <NeoButton
          onClick={() => {
            setRoi({ enabled: !roi.enabled })
          }}
          disabled={!imgUrl}
        >
          ROI
        </NeoButton>
        <NeoButton
          onClick={() => setRoi({ polygon: [], closed: false })}
          disabled={!roi.enabled || roi.polygon.length === 0}
        >
          清除 ROI
        </NeoButton>
        <NeoButton onClick={() => setRoi({ closed: false })} disabled={!roi.enabled || !roi.closed}>
          继续编辑
        </NeoButton>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={roi.applyFilter}
            onChange={(e) => setRoi({ applyFilter: e.target.checked })}
            disabled={!roi.enabled}
          />
          仅显示 ROI 内
        </label>

        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={(e) => setOSD({ bbox: e.target.checked })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.labels} onChange={(e) => setOSD({ labels: e.target.checked })} />
          Labels
        </label>

        <div className={styles.spacer} />
        <div className={styles.meta}>
          conf={params.conf.toFixed(2)} iou={params.iou.toFixed(2)}
        </div>
      </div>

      <div className={[styles.stage, alertActive ? styles.alertOn : ''].join(' ')}>
        {imgUrl ? (
          <>
            <img ref={imgRef} className={styles.img} src={imgUrl} alt="" />
            <CanvasOverlay imgRef={imgRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} />
            <RoiOverlay anchorRef={imgRef} />
            <TelemetryHUD telemetry={filteredPred?.telemetry} />
          </>
        ) : (
          <div className={styles.empty}>拖拽/选择一张图片开始。</div>
        )}

        {busy && <div className={styles.busy}>推理中…</div>}
      </div>

      {bboxes.length > 0 && (
        <div className={styles.footer}>
          <div className={styles.count}>Detected: {bboxes.length}</div>
        </div>
      )}
    </div>
  )
}



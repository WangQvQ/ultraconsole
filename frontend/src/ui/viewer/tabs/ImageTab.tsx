import { useEffect, useMemo, useRef, useState } from 'react'
import { apiInferImage } from '../../../api/client'
import { useT } from '../../../i18n'
import { useConsoleStore } from '../../../store/useConsoleStore'
import { downloadBadCaseZip } from '../../../utils/badcase'
import { filterBBoxesByRoiNormalized } from '../../../utils/roi'
import { NeoButton } from '../../primitives/NeoButton'
import { CanvasOverlay } from '../widgets/CanvasOverlay'
import { RoiOverlay } from '../widgets/RoiOverlay'
import { TelemetryHUD } from '../widgets/TelemetryHUD.tsx'
import styles from './ImageTab.module.css'

export function ImageTab() {
  const t = useT()
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
  const imgUrlRef = useRef<string | null>(null)
  const [imgFile, setImgFile] = useState<File | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const busyRef = useRef(false)
  const pendingReInferRef = useRef(false)
  const reInferTimerRef = useRef<number | null>(null)
  const reInferSkipFirstRef = useRef(true)

  useEffect(() => {
    return () => {
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
      imgUrlRef.current = null
      if (reInferTimerRef.current) window.clearTimeout(reInferTimerRef.current)
    }
  }, [])

  async function runInfer(file: File) {
    if (busyRef.current) {
      // 已经在跑：标记为有挂起请求，跑完后用最新参数补一次
      pendingReInferRef.current = true
      return
    }
    busyRef.current = true
    setBusy(true)
    setLastPred(undefined)
    try {
      const pred = await apiInferImage(file)
      setLastPred(pred)
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'infer.image', msg: `bbox=${pred.bboxes.length}`, fields: {} })
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'infer.image_failed', msg: String(e), fields: {} })
    } finally {
      busyRef.current = false
      setBusy(false)
      if (pendingReInferRef.current) {
        pendingReInferRef.current = false
        void runInfer(file)
      }
    }
  }

  const filteredPred = useMemo(() => {
    if (!lastPred) return undefined
    const classFiltered =
      params.classFilter.length > 0 ? lastPred.bboxes.filter((b) => params.classFilter.includes(b.cls)) : lastPred.bboxes

    const roiFiltered =
      roi.applyFilter && roi.polygon.length >= 3
        ? filterBBoxesByRoiNormalized({
            bboxes: classFiltered,
            roiPoly: roi.polygon,
            width: lastPred.width,
            height: lastPred.height,
          })
        : classFiltered

    return { ...lastPred, bboxes: roiFiltered }
  }, [lastPred, params.classFilter, roi.applyFilter, roi.polygon])
  const bboxes = useMemo(() => (filteredPred ? filteredPred.bboxes : []), [filteredPred])

  async function onPick(file?: File) {
    if (!file) return
    setLastPred(undefined)
    setImgFile(file)
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
    const url = URL.createObjectURL(file)
    imgUrlRef.current = url
    setImgUrl(url)
  }

  // 阈值/类别变化：自动重新推理（对图片是“重新跑一遍模型”）
  useEffect(() => {
    if (reInferSkipFirstRef.current) {
      reInferSkipFirstRef.current = false
      return
    }
    if (!imgFile) return
    if (reInferTimerRef.current) window.clearTimeout(reInferTimerRef.current)
    reInferTimerRef.current = window.setTimeout(() => {
      void runInfer(imgFile)
    }, 250)
  }, [params.conf, params.iou, params.classFilter, imgFile])

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
          {t('image.selectImage')}
        </label>
        <NeoButton onClick={() => imgFile && void runInfer(imgFile)} disabled={!imgFile || busy}>
          {t('common.startInfer')}
        </NeoButton>
        <NeoButton
          onClick={() => {
            setLastPred(undefined)
            setImgUrl(undefined)
            setImgFile(undefined)
            if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
            imgUrlRef.current = null
          }}
          disabled={busy}
        >
          {t('image.clear')}
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
          onClick={() => setRoi({ mode: roi.mode === 'rect' ? 'poly' : 'rect' })}
          disabled={!roi.enabled}
        >
          {roi.mode === 'rect' ? t('common.rectangle') : t('common.polygon')}
        </NeoButton>
        <NeoButton
          onClick={() => setRoi({ polygon: [], closed: false })}
          disabled={!roi.enabled || roi.polygon.length === 0}
        >
          {t('common.clearRoi')}
        </NeoButton>
        <NeoButton onClick={() => setRoi({ closed: false })} disabled={!roi.enabled || !roi.closed}>
          {t('common.continueEdit')}
        </NeoButton>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={roi.applyFilter}
            onChange={(e) => setRoi({ applyFilter: e.target.checked })}
            disabled={!roi.enabled}
          />
          {t('common.showOnlyInsideRoi')}
        </label>

        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.bbox} onChange={(e) => setOSD({ bbox: e.target.checked })} />
          BBox
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.labels} onChange={(e) => setOSD({ labels: e.target.checked })} />
          Labels
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={osd.heatmap} onChange={(e) => setOSD({ heatmap: e.target.checked })} />
          {t('common.heatmap')}
        </label>

        <div className={styles.spacer} />
        <div className={styles.meta}>
          conf={params.conf.toFixed(2)} iou={params.iou.toFixed(2)}
        </div>
      </div>

      <div
        className={[styles.stage, alertActive ? styles.alertOn : '', dragOver ? styles.dropOver : ''].join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={(e) => {
          // 只在离开 stage 本身时清除（避免子元素 dragleave 误触发）
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer?.files?.[0]
          if (file && file.type.startsWith('image/')) void onPick(file)
        }}
      >
        {imgUrl ? (
          <>
            <img ref={imgRef} className={styles.img} src={imgUrl} alt="" />
            <CanvasOverlay imgRef={imgRef} pred={filteredPred} showBBox={osd.bbox} showLabels={osd.labels} showHeatmap={osd.heatmap} />
            <RoiOverlay anchorRef={imgRef} />
            <TelemetryHUD telemetry={filteredPred?.telemetry} />
          </>
        ) : (
          <div className={styles.empty}>{t('image.dragHint')}</div>
        )}

        {dragOver && <div className={styles.dropHint}>{t('image.dropHint')}</div>}
        {busy && <div className={styles.busy}>{t('image.inferring')}</div>}
      </div>

      {bboxes.length > 0 && (
        <div className={styles.footer}>
          <div className={styles.count}>Detected: {bboxes.length}</div>
        </div>
      )}
    </div>
  )
}



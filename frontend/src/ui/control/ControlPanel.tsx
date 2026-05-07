import { useEffect, useMemo, useRef, useState } from 'react'
import { apiListModels, apiSelectEngine, apiSelectModel, apiUpdateParams } from '../../api/client'
import { useConsoleStore } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import styles from './ControlPanel.module.css'

export function ControlPanel() {
  const { engine, params, models, currentModelId, classes } = useConsoleStore()
  const setEngine = useConsoleStore((s) => s.setEngine)
  const setParams = useConsoleStore((s) => s.setParams)
  const setModels = useConsoleStore((s) => s.setModels)
  const setCurrentModel = useConsoleStore((s) => s.setCurrentModel)
  const pushLog = useConsoleStore((s) => s.pushLog)

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiListModels()
      .then((ms) => setModels(ms))
      .catch((e) => pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'models.list', msg: String(e), fields: {} }))
  }, [pushLog, setModels])

  const classOptions = useMemo(() => Array.from(new Set(classes)).sort(), [classes])

  async function onSelectModel(modelId: string) {
    setBusy(true)
    try {
      const model = await apiSelectModel(modelId)
      setCurrentModel(model)
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'model.selected', msg: modelId, fields: {} })
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'model.select_failed', msg: String(e), fields: { modelId } })
    } finally {
      setBusy(false)
    }
  }

  async function onToggleEngine(next: 'cpu' | 'cuda') {
    setEngine({ warming: true, device: next })
    try {
      await apiSelectEngine(next)
      pushLog({ ts: Date.now() / 1000, level: 'INFO', event: 'engine.selected', msg: next, fields: {} })
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'engine.select_failed', msg: String(e), fields: { device: next } })
    } finally {
      setEngine({ warming: false })
    }
  }

  // 滑动条/标签变更要防抖到后端，避免几十次/秒的 /api/params 请求
  const flushTimerRef = useRef<number | null>(null)
  const pendingParamsRef = useRef<{ conf: number; iou: number; classFilter: string[] } | null>(null)
  function flushParams(next: { conf: number; iou: number; classFilter: string[] }) {
    pendingParamsRef.current = next
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(async () => {
      const p = pendingParamsRef.current
      pendingParamsRef.current = null
      if (!p) return
      try {
        await apiUpdateParams(p)
      } catch (e) {
        pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'params.sync_failed', msg: String(e), fields: {} })
      }
    }, 200)
  }
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current)
    }
  }, [])

  return (
    <div className={styles.stack}>
      <Card title="Model Hub" right={busy ? '切换中…' : undefined}>
        <div className={styles.row}>
          <select
            className={styles.select}
            value={currentModelId || ''}
            onChange={(e) => onSelectModel(e.target.value)}
            disabled={busy}
          >
            <option value="" disabled>
              请选择模型（backend/models）
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.filename}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card title="Engine" right={engine.warming ? '预热中…' : engine.device.toUpperCase()}>
        <div className={styles.row}>
          <NeoButton onClick={() => onToggleEngine('cpu')} disabled={engine.warming || engine.device === 'cpu'}>
            CPU
          </NeoButton>
          <NeoButton onClick={() => onToggleEngine('cuda')} disabled={engine.warming || engine.device === 'cuda'}>
            GPU (CUDA)
          </NeoButton>
        </div>
      </Card>

      <Card title="NMS Controls">
        <div className={styles.field}>
          <div className={styles.labelRow}>
            <div className={styles.label}>Conf Threshold</div>
            <div className={styles.value}>{params.conf.toFixed(2)}</div>
          </div>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={params.conf}
            onChange={(e) => {
              const conf = Number(e.target.value)
              const next = { ...params, conf }
              setParams({ conf })
              flushParams(next)
            }}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <div className={styles.label}>IoU Threshold</div>
            <div className={styles.value}>{params.iou.toFixed(2)}</div>
          </div>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={params.iou}
            onChange={(e) => {
              const iou = Number(e.target.value)
              const next = { ...params, iou }
              setParams({ iou })
              flushParams(next)
            }}
          />
        </div>
      </Card>

      <Card title="Class Filter">
        {classOptions.length === 0 ? (
          <div className={styles.hint}>选择模型后，这里会出现类别标签。</div>
        ) : (
          <div className={styles.tags}>
            {classOptions.map((c) => {
              const active = params.classFilter.includes(c)
              return (
                <button
                  key={c}
                  className={[styles.tag, active ? styles.tagOn : ''].join(' ')}
                  onClick={() => {
                    const classFilter = active ? params.classFilter.filter((x) => x !== c) : [...params.classFilter, c]
                    const next = { ...params, classFilter }
                    setParams({ classFilter })
                    flushParams(next)
                  }}
                >
                  {c}
                </button>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Tracking & Events" right={params.track ? 'on' : 'off'}>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={params.track}
            onChange={(e) => {
              const track = e.target.checked
              const next = { ...params, track }
              setParams({ track })
              flushParams(next)
            }}
          />
          启用 ByteTrack 跟踪（Webcam / RTSP）
        </label>
        <div className={styles.hint}>
          开启后 bbox 会带 trackId、轨迹 & 计数线/区域生效。
          <br />
          画线/区域：在画面右键菜单切换"Line / Zone"工具，或使用 ROI 工具旁的快捷按钮。
        </div>
      </Card>
    </div>
  )
}


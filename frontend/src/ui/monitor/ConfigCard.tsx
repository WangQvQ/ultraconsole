import { useRef, useState } from 'react'
import { applyConfig, exportConfigDownload } from '../../utils/configIO'
import { useConsoleStore } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import styles from './ConfigCard.module.css'

export function ConfigCard() {
  const pushLog = useConsoleStore((s) => s.pushLog)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)

  async function onExport() {
    setBusy(true)
    try {
      await exportConfigDownload()
      setStatus('✅ 已导出')
    } catch (e) {
      setStatus(`❌ ${e}`)
    } finally {
      setBusy(false)
    }
  }

  async function onImportFile(file: File) {
    setBusy(true)
    setStatus('解析中…')
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const res = await applyConfig(json)
      if (res.ok) {
        setStatus(`✅ 已应用 ${res.applied.length} 项`)
        pushLog({
          ts: Date.now() / 1000,
          level: 'INFO',
          event: 'config.import',
          msg: `applied ${res.applied.length} keys`,
          fields: { applied: res.applied },
        })
      } else {
        setStatus(`⚠️ 部分失败：${res.errors.map((e) => e.key).join(', ')}`)
        pushLog({
          ts: Date.now() / 1000,
          level: 'WARN',
          event: 'config.import_partial',
          msg: 'some keys failed',
          fields: { applied: res.applied, errors: res.errors },
        })
      }
    } catch (e) {
      setStatus(`❌ ${e}`)
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'config.import_failed', msg: String(e), fields: {} })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Config Import / Export" right={busy ? '处理中…' : undefined}>
      <div
        className={[styles.dropZone, dragOver ? styles.dropOver : ''].join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer?.files?.[0]
          if (file) void onImportFile(file)
        }}
      >
        <div className={styles.row}>
          <NeoButton onClick={onExport} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>
            ⬇ 导出 JSON
          </NeoButton>
          <NeoButton
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{ padding: '6px 10px', fontSize: 12 }}
          >
            ⬆ 导入 JSON
          </NeoButton>
          <input
            ref={fileRef}
            className={styles.fileInput}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onImportFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <div className={styles.hint}>
          也可以直接把 JSON 拖到这里。包含：模型参数 / 引擎 / OSD / ROI / 计数线区 / 告警 / Webhook
        </div>
        <div className={styles.status}>{status}</div>
      </div>
    </Card>
  )
}

import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { applyConfig, exportConfigDownload } from '../../utils/configIO'
import { useConsoleStore } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import styles from './ConfigCard.module.css'

export function ConfigCard() {
  const t = useT()
  const pushLog = useConsoleStore((s) => s.pushLog)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)

  async function onExport() {
    setBusy(true)
    try {
      await exportConfigDownload()
      setStatus(`✅ ${t('config.exported')}`)
    } catch (e) {
      setStatus(`❌ ${e}`)
    } finally {
      setBusy(false)
    }
  }

  async function onImportFile(file: File) {
    setBusy(true)
    setStatus(t('config.parsing'))
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const res = await applyConfig(json)
      if (res.ok) {
        setStatus(`✅ ${t('config.applied', { count: res.applied.length })}`)
        pushLog({
          ts: Date.now() / 1000,
          level: 'INFO',
          event: 'config.import',
          msg: `applied ${res.applied.length} keys`,
          fields: { applied: res.applied },
        })
      } else {
        setStatus(`⚠️ ${t('config.partialFail', { errors: res.errors.map((e) => e.key).join(', ') })}`)
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
    <Card title="Config Import / Export" right={busy ? t('config.processing') : undefined}>
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
            ⬇ {t('config.exportJson')}
          </NeoButton>
          <NeoButton
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{ padding: '6px 10px', fontSize: 12 }}
          >
            ⬆ {t('config.importJson')}
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
          {t('config.dragHint')}
        </div>
        <div className={styles.status}>{status}</div>
      </div>
    </Card>
  )
}

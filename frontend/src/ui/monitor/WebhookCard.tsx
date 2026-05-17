import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import {
  apiGetWebhook,
  apiSetWebhook,
  apiTestWebhook,
  type LevelType,
  type NotifyKind,
  type WebhookConfig,
  type WebhookFormat,
} from '../../api/client'
import { useConsoleStore } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import styles from './WebhookCard.module.css'

const FORMAT_OPTIONS: { value: WebhookFormat; labelKey: string }[] = [
  { value: 'generic', labelKey: 'webhook.genericJson' },
  { value: 'dingtalk', labelKey: 'webhook.dingtalk' },
  { value: 'wecom', labelKey: 'webhook.wecom' },
  { value: 'feishu', labelKey: 'webhook.feishu' },
  { value: 'slack', labelKey: 'Slack' },
]

const LEVELS: LevelType[] = ['INFO', 'WARN', 'ERROR']
const KINDS: NotifyKind[] = ['alert', 'line.cross', 'zone.enter', 'zone.leave']

const DEFAULT_CFG: WebhookConfig = {
  enabled: false,
  url: '',
  format: 'generic',
  minLevel: 'WARN',
  cooldownSec: 30,
  includeKinds: ['alert', 'line.cross', 'zone.enter'],
  timeoutSec: 5,
}

export function WebhookCard() {
  const t = useT()
  const pushLog = useConsoleStore((s) => s.pushLog)
  const [cfg, setCfg] = useState<WebhookConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testStatus, setTestStatus] = useState<string>('')

  useEffect(() => {
    apiGetWebhook()
      .then((c) => {
        setCfg(c)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  async function save(next?: Partial<WebhookConfig>) {
    if (!loaded) return
    const merged = { ...cfg, ...(next || {}) }
    setCfg(merged)
    setBusy(true)
    try {
      const saved = await apiSetWebhook(merged)
      setCfg(saved)
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'WARN', event: 'webhook.save_failed', msg: String(e), fields: {} })
    } finally {
      setBusy(false)
    }
  }

  async function onTest() {
    setTestStatus(t('webhook.sending'))
    try {
      const res = await apiTestWebhook()
      if (res.ok) {
        setTestStatus(`✅ ok ${res.httpStatus ?? ''}`)
      } else if (res.skipped) {
        setTestStatus(`⏭ skipped: ${res.reason}`)
      } else {
        setTestStatus(`❌ ${res.reason || 'failed'}`)
      }
    } catch (e) {
      setTestStatus(`❌ ${e}`)
    }
  }

  function toggleKind(k: NotifyKind) {
    const set = new Set(cfg.includeKinds)
    if (set.has(k)) set.delete(k)
    else set.add(k)
    void save({ includeKinds: Array.from(set) })
  }

  return (
    <Card title="Webhook" right={cfg.enabled ? t('webhook.enabled') : t('webhook.disabled')}>
      <div className={styles.stack}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
            disabled={busy}
          />
          {t('common.enable')}
        </label>

        <div className={styles.field}>
          <span className={styles.label}>URL</span>
          <input
            className={styles.input}
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            value={cfg.url}
            onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
            onBlur={() => void save()}
          />
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{t('webhook.format')}</span>
            <select
              className={styles.select}
              value={cfg.format}
              onChange={(e) => void save({ format: e.target.value as WebhookFormat })}
            >
              {FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('webhook.minLevel')}</span>
            <select
              className={styles.select}
              value={cfg.minLevel}
              onChange={(e) => void save({ minLevel: e.target.value as LevelType })}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{t('webhook.cooldown')}</span>
            <input
              className={styles.num}
              type="number"
              min={0}
              max={3600}
              value={cfg.cooldownSec}
              onChange={(e) => setCfg({ ...cfg, cooldownSec: Number(e.target.value) || 0 })}
              onBlur={() => void save()}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('webhook.timeout')}</span>
            <input
              className={styles.num}
              type="number"
              min={1}
              max={30}
              value={cfg.timeoutSec}
              onChange={(e) => setCfg({ ...cfg, timeoutSec: Number(e.target.value) || 5 })}
              onBlur={() => void save()}
            />
          </label>
        </div>

        <div className={styles.tags}>
          <span className={styles.label}>{t('webhook.eventTypes')}</span>
          {KINDS.map((k) => {
            const on = cfg.includeKinds.includes(k)
            return (
              <button
                key={k}
                className={[styles.tag, on ? styles.tagOn : ''].join(' ')}
                onClick={() => toggleKind(k)}
                disabled={busy}
              >
                {k}
              </button>
            )
          })}
        </div>

        <div className={styles.actionsRow}>
          <NeoButton onClick={onTest} disabled={!cfg.enabled || !cfg.url} style={{ padding: '6px 10px', fontSize: 12 }}>
            {t('webhook.sendTest')}
          </NeoButton>
          <span className={styles.testStatus}>{testStatus}</span>
        </div>

        <div className={styles.hint}>
          {t('webhook.hint')}
        </div>
      </div>
    </Card>
  )
}

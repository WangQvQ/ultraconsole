import { useEffect, useRef } from 'react'
import { apiExportLogsCsv } from '../../api/client'
import { useT } from '../../i18n'
import { useConsoleStore } from '../../store/useConsoleStore'
import { useEventTracker } from '../../utils/useEventTracker'
import { useSystemStats } from '../../utils/useSystemStats'
import { useWebhookDispatcher } from '../../utils/useWebhookDispatcher'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import { ConfigCard } from './ConfigCard'
import { SystemStatsCard } from './SystemStatsCard'
import { WebhookCard } from './WebhookCard'
import styles from './MonitorPanel.module.css'

export function MonitorPanel() {
  const t = useT()
  const logs = useConsoleStore((s) => s.logs)
  const classes = useConsoleStore((s) => s.classes)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alert = useConsoleStore((s) => s.alert)
  const alertConfig = useConsoleStore((s) => s.alertConfig)
  const pushLog = useConsoleStore((s) => s.pushLog)
  const setAlert = useConsoleStore((s) => s.setAlert)
  const setAlertConfig = useConsoleStore((s) => s.setAlertConfig)
  const counters = useConsoleStore((s) => s.counters)
  const events = useConsoleStore((s) => s.events)
  const eventsConfig = useConsoleStore((s) => s.eventsConfig)
  const resetCounters = useConsoleStore((s) => s.resetCounters)

  // 启动全局 hook：系统资源轮询、事件追踪、webhook 派发
  useSystemStats()
  useEventTracker()
  useWebhookDispatcher()

  // 轻量规则引擎：目标类别出现连续 N 帧 -> 告警
  const prevActiveRef = useRef(false)
  const audioRef = useRef<AudioContext | null>(null)
  const lastPredKeyRef = useRef<string | null>(null)

  function beep() {
    try {
      const ctx = (audioRef.current ??= new (window.AudioContext || (window as any).webkitAudioContext)())
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = 880
      g.gain.value = 0.04
      o.connect(g)
      g.connect(ctx.destination)
      o.start()
      o.stop(ctx.currentTime + 0.15)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (alertConfig.enabled && lastPred) {
      const predKey = String(lastPred.frameId ?? lastPred.ts)
      if (lastPredKeyRef.current === predKey) return
      lastPredKeyRef.current = predKey

      const hit =
        !!alertConfig.targetClass &&
        lastPred.bboxes.some((b) => b.cls === alertConfig.targetClass) &&
        lastPred.bboxes.length > 0

      const nextStreak = hit ? alert.streak + 1 : 0
      const nextActive = hit && nextStreak >= alertConfig.minFrames
      if (nextStreak !== alert.streak || nextActive !== alert.active) {
        setAlert({
          streak: nextStreak,
          active: nextActive,
          reason: nextActive ? t('monitor.alertReason', { cls: alertConfig.targetClass ?? '', streak: nextStreak }) : undefined,
        })
        if (!prevActiveRef.current && nextActive) {
          pushLog({
            ts: Date.now() / 1000,
            level: 'WARN',
            event: 'alert.trigger',
            msg: `${alertConfig.targetClass} >= ${alertConfig.minFrames} frames`,
            fields: { streak: nextStreak },
          })
          if (alertConfig.sound) beep()
        }
        prevActiveRef.current = nextActive
      }
      return
    }

    if (alert.active || alert.streak !== 0) {
      setAlert({ active: false, streak: 0, reason: undefined })
    }
  }, [alert.active, alert.streak, alertConfig.enabled, alertConfig.minFrames, alertConfig.sound, alertConfig.targetClass, lastPred, pushLog, setAlert])

  async function onExport() {
    try {
      const csv = await apiExportLogsCsv()
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `logs_${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushLog({ ts: Date.now() / 1000, level: 'ERROR', event: 'logs.export_failed', msg: String(e), fields: {} })
    }
  }

  const lineNameById = new Map(eventsConfig.lines.map((l) => [l.id, l.name || l.id]))
  const zoneNameById = new Map(eventsConfig.zones.map((z) => [z.id, z.name || z.id]))
  const recentEvents = events.slice(-30).reverse()

  return (
    <div className={styles.stack}>
      <SystemStatsCard />

      <WebhookCard />

      <ConfigCard />

      <Card
        title="Counters / Events"
        right={
          <NeoButton onClick={resetCounters} style={{ padding: '6px 10px', fontSize: 11 }}>
            {t('monitor.reset')}
          </NeoButton>
        }
      >
        {eventsConfig.lines.length === 0 && eventsConfig.zones.length === 0 ? (
          <div className={styles.hint}>{t('monitor.countersHint')}</div>
        ) : (
          <div className={styles.countersBox}>
            {eventsConfig.lines.map((l) => {
              const c = counters.byLine[l.id] || { in: 0, out: 0 }
              return (
                <div key={l.id} className={styles.counterRow}>
                  <span className={styles.lineDot} />
                  <span className={styles.cName}>{l.name || l.id}</span>
                  <span className={styles.cIn}>↑ in {c.in}</span>
                  <span className={styles.cOut}>↓ out {c.out}</span>
                </div>
              )
            })}
            {eventsConfig.zones.map((z) => {
              const c = counters.byZone[z.id] || { current: 0, total: 0 }
              return (
                <div key={z.id} className={styles.counterRow}>
                  <span className={styles.zoneDot} />
                  <span className={styles.cName}>{z.name || z.id}</span>
                  <span className={styles.cCur}>now {c.current}</span>
                  <span className={styles.cTot}>total {c.total}</span>
                </div>
              )
            })}
          </div>
        )}

        {recentEvents.length > 0 && (
          <div className={styles.eventBox}>
            {recentEvents.map((e, i) => {
              const name = e.kind === 'line.cross' ? lineNameById.get(e.ref) : zoneNameById.get(e.ref)
              return (
                <div key={i} className={styles.eventRow}>
                  <span className={styles.eventKind}>
                    {e.kind === 'line.cross' ? `LINE ${e.direction}` : e.kind === 'zone.enter' ? 'ENTER' : 'LEAVE'}
                  </span>
                  <span>{name}</span>
                  <span className={styles.eventCls}>{e.cls}#{e.trackId ?? '-'}</span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Alert Engine" right={alert.active ? alert.reason : `streak=${alert.streak}`}>
        <div className={styles.alertRow}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={alertConfig.enabled}
              onChange={(e) => setAlertConfig({ enabled: e.target.checked })}
            />
            {t('common.enable')}
          </label>

          <label className={styles.toggle}>
            {t('monitor.class')}
            <select
              className={styles.select}
              value={alertConfig.targetClass || ''}
              onChange={(e) => setAlertConfig({ targetClass: e.target.value || undefined })}
              disabled={!alertConfig.enabled}
            >
              <option value="">{t('monitor.pleaseSelect')}</option>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.toggle}>
            N
            <input
              className={styles.num}
              type="number"
              min={1}
              max={120}
              value={alertConfig.minFrames}
              onChange={(e) => setAlertConfig({ minFrames: Math.max(1, Math.min(120, Number(e.target.value) || 5)) })}
              disabled={!alertConfig.enabled}
            />
          </label>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={alertConfig.sound}
              onChange={(e) => setAlertConfig({ sound: e.target.checked })}
              disabled={!alertConfig.enabled}
            />
            {t('monitor.sound')}
          </label>

          <div className={styles.spacer} />

          <NeoButton
            onClick={() => setAlert({ active: false, streak: 0, reason: undefined })}
            style={{ padding: '8px 10px', fontSize: 12 }}
          >
            {t('common.clear')}
          </NeoButton>
        </div>
        <div className={styles.hint}>{t('monitor.alertRule')}</div>
      </Card>

      <Card
        title="Event Logger"
        right={
          <NeoButton onClick={onExport} style={{ padding: '8px 10px', fontSize: 12 }}>
            {t('monitor.exportCsv')}
          </NeoButton>
        }
      >
        <div className={styles.logBox}>
          {logs.length === 0 ? (
            <div className={styles.hint}>{t('monitor.noLogs')}</div>
          ) : (
            logs
              .slice()
              .reverse()
              .slice(0, 200)
              .map((l, idx) => (
                <div key={idx} className={styles.logRow}>
                  <span className={[styles.level, styles[l.level]].join(' ')}>{l.level}</span>
                  <span className={styles.msg}>
                    {l.event}: {l.msg}
                  </span>
                </div>
              ))
          )}
        </div>
      </Card>
    </div>
  )
}


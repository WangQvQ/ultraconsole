import { useEffect, useRef } from 'react'
import { apiExportLogsCsv } from '../../api/client'
import { useConsoleStore } from '../../store/useConsoleStore'
import { Card } from '../primitives/Card'
import { NeoButton } from '../primitives/NeoButton'
import styles from './MonitorPanel.module.css'

export function MonitorPanel() {
  const logs = useConsoleStore((s) => s.logs)
  const classes = useConsoleStore((s) => s.classes)
  const lastPred = useConsoleStore((s) => s.lastPred)
  const alert = useConsoleStore((s) => s.alert)
  const alertConfig = useConsoleStore((s) => s.alertConfig)
  const pushLog = useConsoleStore((s) => s.pushLog)
  const setAlert = useConsoleStore((s) => s.setAlert)
  const setAlertConfig = useConsoleStore((s) => s.setAlertConfig)

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
          reason: nextActive ? `${alertConfig.targetClass} 连续 ${nextStreak} 帧` : undefined,
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

  return (
    <div className={styles.stack}>
      <Card title="Alert Engine" right={alert.active ? alert.reason : `streak=${alert.streak}`}>
        <div className={styles.alertRow}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={alertConfig.enabled}
              onChange={(e) => setAlertConfig({ enabled: e.target.checked })}
            />
            启用
          </label>

          <label className={styles.toggle}>
            类别
            <select
              className={styles.select}
              value={alertConfig.targetClass || ''}
              onChange={(e) => setAlertConfig({ targetClass: e.target.value || undefined })}
              disabled={!alertConfig.enabled}
            >
              <option value="">(请选择)</option>
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
            声音
          </label>

          <div className={styles.spacer} />

          <NeoButton
            onClick={() => setAlert({ active: false, streak: 0, reason: undefined })}
            style={{ padding: '8px 10px', fontSize: 12 }}
          >
            清除
          </NeoButton>
        </div>
        <div className={styles.hint}>规则：目标类别出现且连续帧数 ≥ N 即触发告警。</div>
      </Card>

      <Card
        title="Event Logger"
        right={
          <NeoButton onClick={onExport} style={{ padding: '8px 10px', fontSize: 12 }}>
            导出 CSV
          </NeoButton>
        }
      >
        <div className={styles.logBox}>
          {logs.length === 0 ? (
            <div className={styles.hint}>暂无日志（选择模型/推理后会出现）。</div>
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


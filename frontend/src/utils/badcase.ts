import JSZip from 'jszip'
import type { AlertConfig, OSDFlags, Params, PredResponse } from '../store/useConsoleStore'
import { useConsoleStore } from '../store/useConsoleStore'
import { apiHealth } from '../api/client'

export type BadCaseConfig = {
  ts: number
  modelId?: string
  device?: string
  params: Params
  osd: OSDFlags
  alertConfig: AlertConfig
}

export async function downloadBadCaseZip(args: {
  jpeg: Blob
  config: BadCaseConfig
  pred?: PredResponse
}) {
  const zip = new JSZip()
  zip.file('frame.jpg', args.jpeg)
  zip.file('config.json', JSON.stringify(args.config, null, 2))
  const state = useConsoleStore.getState()
  const health = await apiHealth().catch(() => null)
  zip.file('runtime.json', JSON.stringify({ health, model: state.currentModel, depthModel: state.depthModel,
    userAgent: navigator.userAgent, schemaVersion: args.pred?.schemaVersion }, null, 2))
  if (args.pred) zip.file('pred.json', JSON.stringify(args.pred, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `badcase_${Date.now()}.zip`
  a.click()
  URL.revokeObjectURL(url)
}


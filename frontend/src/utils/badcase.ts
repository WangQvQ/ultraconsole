import JSZip from 'jszip'
import type { AlertConfig, OSDFlags, Params, PredResponse } from '../store/useConsoleStore'

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
  if (args.pred) zip.file('pred.json', JSON.stringify(args.pred, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `badcase_${Date.now()}.zip`
  a.click()
  URL.revokeObjectURL(url)
}


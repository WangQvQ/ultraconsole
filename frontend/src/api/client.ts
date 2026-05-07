import type { DeviceType, LogEntry, ModelInfo, Params, PredResponse, SystemStats } from '../store/useConsoleStore'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export async function apiHealth() {
  const res = await fetch('/api/health')
  return json<{ ok: boolean; ts: number }>(res)
}

export async function apiListModels() {
  const res = await fetch('/api/models')
  return json<ModelInfo[]>(res)
}

export async function apiSelectModel(modelId: string) {
  const res = await fetch('/api/models/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId }),
  })
  return json<ModelInfo>(res)
}

export async function apiSelectEngine(device: DeviceType) {
  const res = await fetch('/api/engine/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device }),
  })
  return json<{ ok: boolean; device: DeviceType; warming: boolean }>(res)
}

export async function apiGetParams() {
  const res = await fetch('/api/params')
  return json<Params>(res)
}

export async function apiUpdateParams(p: Params) {
  const res = await fetch('/api/params', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  })
  return json<Params>(res)
}

export async function apiInferImage(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/infer/image', {
    method: 'POST',
    body: fd,
  })
  return json<PredResponse>(res)
}

export async function apiInferFrame(file: Blob) {
  const fd = new FormData()
  // 后端接口名为 file
  fd.append('file', new File([file], 'frame.jpg', { type: 'image/jpeg' }))
  const res = await fetch('/api/infer/frame', {
    method: 'POST',
    body: fd,
  })
  return json<PredResponse>(res)
}

export async function apiExportLogsCsv() {
  const res = await fetch('/api/logs/export.csv')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

export async function apiSystemStats() {
  const res = await fetch('/api/system/stats')
  return json<SystemStats>(res)
}

// ---- Webhook ----
export type WebhookFormat = 'generic' | 'dingtalk' | 'wecom' | 'feishu' | 'slack'
export type NotifyKind = 'alert' | 'line.cross' | 'zone.enter' | 'zone.leave' | 'test'
export type LevelType = 'INFO' | 'WARN' | 'ERROR'

export type WebhookConfig = {
  enabled: boolean
  url: string
  format: WebhookFormat
  minLevel: LevelType
  cooldownSec: number
  includeKinds: NotifyKind[]
  timeoutSec: number
}

export type NotifyResult = {
  ok: boolean
  skipped?: boolean
  reason?: string
  httpStatus?: number
}

export type NotifyRequest = {
  kind: NotifyKind
  level?: LevelType
  title: string
  msg: string
  ref?: string
  fields?: Record<string, unknown>
}

export async function apiGetWebhook() {
  const res = await fetch('/api/webhook')
  return json<WebhookConfig>(res)
}

export async function apiSetWebhook(cfg: WebhookConfig) {
  const res = await fetch('/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  return json<WebhookConfig>(res)
}

export async function apiTestWebhook() {
  const res = await fetch('/api/webhook/test', { method: 'POST' })
  return json<NotifyResult>(res)
}

export async function apiNotify(req: NotifyRequest) {
  const res = await fetch('/api/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  return json<NotifyResult>(res)
}

export function wsInferUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/infer`
}

export function wsStreamUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/stream`
}

export type WsPredMessage = { type: 'pred'; streamId?: string } & PredResponse
export type WsLogMessage = { type: 'log'; streamId?: string } & LogEntry
export type WsFrameMessage = {
  type: 'frame'
  streamId?: string
  frameId: string
  ts: number
  imageJpegBase64: string
  width: number
  height: number
}


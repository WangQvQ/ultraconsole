import type {
  DeviceType, ModelInfo, NotifyRequest, NotifyResult, Params, PredResponse,
  SystemStats, WebhookConfig,
} from './contracts'

export type * from './contracts'

const API_TOKEN = String(import.meta.env.VITE_ULTRA_API_TOKEN ?? '').trim()

function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (API_TOKEN) headers.set('authorization', `Bearer ${API_TOKEN}`)
  return fetch(input, { ...init, headers })
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export async function apiHealth() {
  const res = await apiFetch('/api/health')
  return json<{ ok: boolean; ts: number }>(res)
}

export async function apiListModels() {
  const res = await apiFetch('/api/models')
  return json<ModelInfo[]>(res)
}

export async function apiSelectModel(modelId: string) {
  const res = await apiFetch('/api/models/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId }),
  })
  return json<ModelInfo>(res)
}

export async function apiSelectEngine(device: DeviceType) {
  const res = await apiFetch('/api/engine/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device }),
  })
  return json<{ ok: boolean; device: DeviceType; warming: boolean }>(res)
}

export async function apiGetParams() {
  const res = await apiFetch('/api/params')
  return json<Params>(res)
}

export async function apiUpdateParams(p: Params) {
  const res = await apiFetch('/api/params', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  })
  return json<Params>(res)
}

export async function apiInferImage(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await apiFetch('/api/infer/image', {
    method: 'POST',
    body: fd,
  })
  return json<PredResponse>(res)
}

export async function apiInferFrame(file: Blob) {
  const fd = new FormData()
  // 后端接口名为 file
  fd.append('file', new File([file], 'frame.jpg', { type: 'image/jpeg' }))
  const res = await apiFetch('/api/infer/frame', {
    method: 'POST',
    body: fd,
  })
  return json<PredResponse>(res)
}

export async function apiExportLogsCsv() {
  const res = await apiFetch('/api/logs/export.csv')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

export async function apiSystemStats() {
  const res = await apiFetch('/api/system/stats')
  return json<SystemStats>(res)
}

export async function apiGetWebhook() {
  const res = await apiFetch('/api/webhook')
  return json<WebhookConfig>(res)
}

export async function apiSetWebhook(cfg: WebhookConfig) {
  const res = await apiFetch('/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  return json<WebhookConfig>(res)
}

export async function apiTestWebhook() {
  const res = await apiFetch('/api/webhook/test', { method: 'POST' })
  return json<NotifyResult>(res)
}

export async function apiNotify(req: NotifyRequest) {
  const res = await apiFetch('/api/notify', {
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

export function wsAuthProtocols(): string[] | undefined {
  if (!API_TOKEN) return undefined
  const bytes = new TextEncoder().encode(API_TOKEN)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return [`ultra-token.${encoded}`]
}

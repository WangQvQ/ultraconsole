import type { DeviceType, LogEntry, ModelInfo, Params, PredResponse } from '../store/useConsoleStore'

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

export function wsInferUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/infer`
}

export function wsStreamUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/stream`
}

export type WsPredMessage = { type: 'pred' } & PredResponse
export type WsLogMessage = { type: 'log' } & LogEntry


import type { Counters, EventEntry, EventsConfig, Params, PredResponse } from '../api/contracts'
import { wsAuthProtocols, wsInferUrl } from '../api/client'
import { newTrackerState, processFrame } from './events'

export type VideoReport = {
  fileName: string
  duration: number
  fps: number
  modelId: string
  params: Params
  config: EventsConfig
  status: 'running' | 'completed' | 'stopped' | 'error'
  analyzedSeconds: number
  frames: number
  events: EventEntry[]
  counters: Counters
}

export function createVideoReport(fileName: string, duration: number, fps: number, modelId: string, params: Params, config: EventsConfig): VideoReport {
  return { fileName, duration, fps, modelId, params: structuredClone(params), config: structuredClone(config), status: 'running', analyzedSeconds: 0, frames: 0, events: [], counters: { byLine: {}, byZone: {} } }
}

export function recordVideoFrame(report: VideoReport, state: ReturnType<typeof newTrackerState>, pred: PredResponse, mediaTime: number) {
  const result = processFrame({ state, bboxes: pred.bboxes, width: pred.width, height: pred.height, ...report.config, classFilter: report.config.classes, ts: pred.ts })
  for (const e of result.events) report.events.push({ ...e, mediaTime, source: 'video' })
  const byLine = { ...report.counters.byLine }
  const byZone = { ...report.counters.byZone }
  for (const [id, count] of Object.entries(result.lineCounts)) {
    const previous = byLine[id] ?? { in: 0, out: 0 }
    byLine[id] = { in: previous.in + count.in, out: previous.out + count.out }
  }
  for (const [id, count] of Object.entries(result.zoneCounts)) {
    byZone[id] = { current: count.current, total: (byZone[id]?.total ?? 0) + count.deltaTotal }
  }
  report.counters = { byLine, byZone }
  report.frames += 1
  report.analyzedSeconds = mediaTime
}

export function formatVideoTime(seconds: number) {
  const millis = Math.max(0, Math.round(seconds * 1000))
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`
}

function csvCell(value: unknown) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function videoReportCsv(report: VideoReport) {
  const rows: unknown[][] = [
    ['file', report.fileName], ['status', report.status], ['duration_seconds', report.duration],
    ['last_sample_seconds', report.analyzedSeconds], ['sample_fps', report.fps], ['processed_frames', report.frames],
    ['model', report.modelId], ['params', JSON.stringify(report.params)], ['rules', JSON.stringify(report.config)],
    [], ['type', 'id', 'name', 'in', 'out', 'current', 'total_entries'],
  ]
  for (const line of report.config.lines) {
    const c = report.counters.byLine[line.id] ?? { in: 0, out: 0 }
    rows.push(['line', line.id, line.name, c.in, c.out, '', ''])
  }
  for (const zone of report.config.zones) {
    const c = report.counters.byZone[zone.id] ?? { current: 0, total: 0 }
    rows.push(['zone', zone.id, zone.name, '', '', c.current, c.total])
  }
  rows.push([], ['video_time', 'video_seconds', 'kind', 'rule_id', 'class', 'track_id', 'direction'])
  for (const e of report.events) rows.push([formatVideoTime(e.mediaTime ?? 0), e.mediaTime, e.kind, e.ref, e.cls, e.trackId, e.direction])
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

/** One socket per analysis; only one frame in flight, so the server cannot drop samples. */
export class VideoInferenceSession {
  private socket: WebSocket
  private pending?: { resolve: (pred: PredResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  private ready: Promise<void>
  private failOpen?: (error: Error) => void
  private sequence = 0
  private frameId = ''
  private closedError?: Error
  constructor(signal: AbortSignal) {
    this.socket = new WebSocket(wsInferUrl(), wsAuthProtocols())
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Video connection timed out')), 15000)
      this.failOpen = (error) => { clearTimeout(timer); reject(error) }
      this.socket.onopen = () => { clearTimeout(timer); this.failOpen = undefined; resolve() }
    })
    // The first frame may still be seeking when the connection fails.
    void this.ready.catch(() => {})
    this.socket.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data))
        if (data.type === 'pred' && data.frameId === this.frameId && this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.resolve(data as PredResponse)
          this.pending = undefined
        } else if (data.type === 'log' && (data.level === 'ERROR' || data.level === 'WARN')) {
          this.close(new Error(data.msg || data.event))
        }
      } catch { this.close(new Error('Invalid video inference response')) }
    }
    this.socket.onerror = () => this.close(new Error('Video inference connection failed'))
    this.socket.onclose = () => this.close(new Error('Video inference connection closed'))
    signal.addEventListener('abort', () => this.close(new DOMException('Aborted', 'AbortError')), { once: true })
    if (signal.aborted) this.close(new DOMException('Aborted', 'AbortError'))
  }
  async infer(imageJpegBase64: string, params: Params): Promise<PredResponse> {
    await this.ready
    if (this.closedError) throw this.closedError
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Video inference connection closed')
    if (this.pending) throw new Error('Video inference already in progress')
    this.frameId = `video-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Video inference timed out')), 120000)
      this.pending = { resolve, reject, timer }
      this.socket.send(JSON.stringify({ type: 'frame', frameId: this.frameId, ts: Date.now() / 1000, imageJpegBase64, ...params, track: true }))
    })
  }
  close(error = new Error('Video analysis ended')) {
    this.closedError ??= error
    this.failOpen?.(error)
    this.failOpen = undefined
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = undefined
    }
    this.socket.onclose = null
    this.socket.onerror = null
    this.socket.close()
  }
}

export function seekVideo(video: HTMLVideoElement, seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (Math.abs(video.currentTime - seconds) < 0.00001 && video.readyState >= 2 && !video.seeking) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('Video decode/seek failed')) }
    const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(failed, 15000)
    video.addEventListener('seeked', done)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    video.currentTime = seconds
  })
}

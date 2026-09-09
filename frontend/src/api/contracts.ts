export type DeviceType = 'cpu' | 'cuda'

export type OSDFlags = {
  bbox: boolean
  masks: boolean
  keypoints: boolean
  labels: boolean
  heatmap: boolean
}

export type Params = { conf: number; iou: number; classFilter: string[]; track: boolean }
export type Telemetry = { fps?: number; preprocessMs?: number; inferenceMs?: number; postprocessMs?: number; vramUtil?: number }
export type PredBBox = { cls: string; conf: number; x1: number; y1: number; x2: number; y2: number; label?: string; trackId?: number }
export type PredMask = { cls: string; trackId?: number; points: number[][] }
export type PredKeypoint = { x: number; y: number; conf?: number }
export type PredInstanceKeypoints = { cls: string; trackId?: number; points: PredKeypoint[] }
export type PredResponse = {
  source?: 'video'
  mediaTime?: number
  frameId?: string
  ts: number
  width: number
  height: number
  taskType: 'detect' | 'segment' | 'pose'
  bboxes: PredBBox[]
  masks?: PredMask[]
  keypoints?: PredInstanceKeypoints[]
  telemetry: Telemetry
}

export type GpuStat = { index: number; name: string; utilPct?: number; memUsedMb?: number; memTotalMb?: number; tempC?: number; powerW?: number }
export type LatencyStats = { count: number; p50Ms?: number; p95Ms?: number; p99Ms?: number; avgMs?: number; recentMs: number[] }
export type SystemStats = {
  ts: number
  cpuPct?: number
  cpuCount?: number
  memUsedMb?: number
  memTotalMb?: number
  memPct?: number
  gpus: GpuStat[]
  inferLatency: LatencyStats
}

export type RoiPointXY = { x: number; y: number }
export type CountingLine = { id: string; name?: string; a: RoiPointXY; b: RoiPointXY }
export type CountingZone = { id: string; name?: string; polygon: RoiPointXY[] }
export type EventsConfig = { lines: CountingLine[]; zones: CountingZone[]; classes?: string[] }
export type EventEntry = {
  source?: 'video'
  mediaTime?: number
  ts: number
  kind: 'line.cross' | 'zone.enter' | 'zone.leave'
  ref: string
  trackId?: number
  cls: string
  direction?: 'in' | 'out'
}
export type Counters = {
  byLine: Record<string, { in: number; out: number }>
  byZone: Record<string, { current: number; total: number }>
}
export type ModelInfo = { id: string; filename: string; taskType: 'detect' | 'segment' | 'pose'; names: Record<string, string> }
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'
export type LogEntry = { ts: number; level: LogLevel; event: string; msg: string; fields: Record<string, unknown> }
export type AlertConfig = { enabled: boolean; targetClass?: string; minFrames: number; sound: boolean }
export type RoiPoint = { x: number; y: number }
export type RoiMode = 'rect' | 'poly'
export type RoiState = { enabled: boolean; polygon: RoiPoint[]; closed: boolean; applyFilter: boolean; mode: RoiMode }
export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

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
export type NotifyResult = { ok: boolean; skipped?: boolean; reason?: string; httpStatus?: number }
export type NotifyRequest = {
  kind: NotifyKind
  level?: LevelType
  title: string
  msg: string
  ref?: string
  fields?: Record<string, unknown>
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

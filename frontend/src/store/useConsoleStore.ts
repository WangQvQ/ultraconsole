import { create } from 'zustand'

export type DeviceType = 'cpu' | 'cuda'

export type OSDFlags = {
  bbox: boolean
  masks: boolean
  keypoints: boolean
  labels: boolean
  heatmap: boolean
}

export type Params = {
  conf: number
  iou: number
  classFilter: string[]
  track: boolean
}

export type Telemetry = {
  fps?: number
  preprocessMs?: number
  inferenceMs?: number
  postprocessMs?: number
  vramUtil?: number
}

export type PredBBox = {
  cls: string
  conf: number
  x1: number
  y1: number
  x2: number
  y2: number
  label?: string
  trackId?: number
}

export type PredMask = {
  cls: string
  trackId?: number
  points: number[][] // [[x,y], ...]
}

export type PredKeypoint = {
  x: number
  y: number
  conf?: number
}

export type PredInstanceKeypoints = {
  cls: string
  trackId?: number
  points: PredKeypoint[]
}

export type PredResponse = {
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

// 系统资源统计
export type GpuStat = {
  index: number
  name: string
  utilPct?: number
  memUsedMb?: number
  memTotalMb?: number
  tempC?: number
  powerW?: number
}
export type LatencyStats = {
  count: number
  p50Ms?: number
  p95Ms?: number
  p99Ms?: number
  avgMs?: number
  recentMs: number[]
}
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

// 跟踪事件配置：归一化到源图坐标 0..1
export type RoiPointXY = { x: number; y: number }
export type CountingLine = {
  id: string
  name?: string
  a: RoiPointXY
  b: RoiPointXY
  // a→b 方向的法线左侧到右侧记 in，右侧到左侧记 out（约定）
}
export type CountingZone = {
  id: string
  name?: string
  polygon: RoiPointXY[]
}
export type EventsConfig = {
  lines: CountingLine[]
  zones: CountingZone[]
  classes?: string[] // 限定计入哪些类别；空表示全部
}

export type EventEntry = {
  ts: number
  kind: 'line.cross' | 'zone.enter' | 'zone.leave'
  ref: string // line id / zone id
  trackId?: number
  cls: string
  direction?: 'in' | 'out'
}

export type Counters = {
  byLine: Record<string, { in: number; out: number }>
  byZone: Record<string, { current: number; total: number }>
}

export type ModelInfo = {
  id: string
  filename: string
  taskType: 'detect' | 'segment' | 'pose'
  names: Record<string, string>
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'
export type LogEntry = {
  ts: number
  level: LogLevel
  event: string
  msg: string
  fields: Record<string, unknown>
}

export type AlertConfig = {
  enabled: boolean
  targetClass?: string
  minFrames: number
  sound: boolean
}

export type RoiPoint = { x: number; y: number } // normalized 0..1

export type RoiMode = 'rect' | 'poly'

export type RoiState = {
  enabled: boolean
  polygon: RoiPoint[]
  closed: boolean
  applyFilter: boolean
  mode: RoiMode
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

type ConsoleState = {
  engine: { device: DeviceType; warming: boolean }
  params: Params
  osd: OSDFlags

  models: ModelInfo[]
  currentModelId?: string
  classes: string[]

  lastPred?: PredResponse

  logs: LogEntry[]
  alert: { active: boolean; reason?: string; streak: number }
  alertConfig: AlertConfig
  roi: RoiState
  connections: { inferWs: ConnState; rtspWs: ConnState }
  telemetrySummary: { fps?: number }
  systemStats?: SystemStats

  eventsConfig: EventsConfig
  events: EventEntry[]
  counters: Counters

  setEngine: (p: Partial<ConsoleState['engine']>) => void
  setParams: (p: Partial<Params>) => void
  setOSD: (p: Partial<OSDFlags>) => void

  setModels: (models: ModelInfo[]) => void
  setCurrentModel: (model?: ModelInfo) => void

  setLastPred: (pred?: PredResponse) => void

  pushLog: (entry: LogEntry) => void
  setAlert: (p: Partial<ConsoleState['alert']>) => void
  setAlertConfig: (p: Partial<AlertConfig>) => void
  setRoi: (p: Partial<RoiState>) => void
  setConnections: (p: Partial<ConsoleState['connections']>) => void
  setTelemetrySummary: (p: Partial<ConsoleState['telemetrySummary']>) => void
  setSystemStats: (s?: SystemStats) => void

  setEventsConfig: (p: Partial<EventsConfig>) => void
  pushEvent: (e: EventEntry) => void
  bumpLineCounter: (lineId: string, dir: 'in' | 'out') => void
  setZoneCount: (zoneId: string, current: number, totalDelta?: number) => void
  resetCounters: () => void
}

export const useConsoleStore = create<ConsoleState>((set, get) => ({
  engine: { device: 'cpu', warming: false },
  params: { conf: 0.25, iou: 0.7, classFilter: [], track: false },
  osd: { bbox: true, masks: true, keypoints: true, labels: true, heatmap: false },

  models: [],
  currentModelId: undefined,
  classes: [],

  lastPred: undefined,

  logs: [],
  alert: { active: false, streak: 0 },
  alertConfig: { enabled: false, minFrames: 5, sound: false },
  roi: { enabled: false, polygon: [], closed: false, applyFilter: true, mode: 'rect' },
  connections: { inferWs: 'idle', rtspWs: 'idle' },
  telemetrySummary: {},
  systemStats: undefined,

  eventsConfig: { lines: [], zones: [] },
  events: [],
  counters: { byLine: {}, byZone: {} },

  setEngine: (p) => set({ engine: { ...get().engine, ...p } }),
  setParams: (p) => set({ params: { ...get().params, ...p } }),
  setOSD: (p) => set({ osd: { ...get().osd, ...p } }),

  setModels: (models) => set({ models }),
  setCurrentModel: (model) =>
    set({
      currentModelId: model?.id,
      classes: model ? Object.values(model.names) : [],
      params: model ? { ...get().params, classFilter: [] } : get().params,
    }),

  setLastPred: (pred) =>
    set((s) => ({
      lastPred: pred,
      telemetrySummary: { ...s.telemetrySummary, fps: pred?.telemetry?.fps ?? s.telemetrySummary.fps },
    })),

  pushLog: (entry) =>
    set((s) => {
      const MAX = 1000
      if (s.logs.length < MAX) return { logs: [...s.logs, entry] }
      // 已满：截掉最旧的一条
      const next = s.logs.slice(s.logs.length - MAX + 1)
      next.push(entry)
      return { logs: next }
    }),

  setAlert: (p) => set({ alert: { ...get().alert, ...p } }),
  setAlertConfig: (p) => set({ alertConfig: { ...get().alertConfig, ...p } }),
  setRoi: (p) => set({ roi: { ...get().roi, ...p } }),
  setConnections: (p) => set({ connections: { ...get().connections, ...p } }),
  setTelemetrySummary: (p) => set({ telemetrySummary: { ...get().telemetrySummary, ...p } }),
  setSystemStats: (s) => set({ systemStats: s }),

  setEventsConfig: (p) => set({ eventsConfig: { ...get().eventsConfig, ...p } }),
  pushEvent: (e) =>
    set((s) => {
      const MAX = 500
      const next = s.events.length < MAX ? [...s.events, e] : [...s.events.slice(s.events.length - MAX + 1), e]
      return { events: next }
    }),
  bumpLineCounter: (lineId, dir) =>
    set((s) => {
      const cur = s.counters.byLine[lineId] || { in: 0, out: 0 }
      return {
        counters: {
          ...s.counters,
          byLine: { ...s.counters.byLine, [lineId]: { ...cur, [dir]: cur[dir] + 1 } },
        },
      }
    }),
  setZoneCount: (zoneId, current, totalDelta = 0) =>
    set((s) => {
      const cur = s.counters.byZone[zoneId] || { current: 0, total: 0 }
      return {
        counters: {
          ...s.counters,
          byZone: { ...s.counters.byZone, [zoneId]: { current, total: cur.total + totalDelta } },
        },
      }
    }),
  resetCounters: () => set({ counters: { byLine: {}, byZone: {} }, events: [] }),
}))


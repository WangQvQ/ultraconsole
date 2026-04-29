import { create } from 'zustand'

export type DeviceType = 'cpu' | 'cuda'

export type OSDFlags = {
  bbox: boolean
  masks: boolean
  keypoints: boolean
  labels: boolean
}

export type Params = {
  conf: number
  iou: number
  classFilter: string[]
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
}

export type PredResponse = {
  frameId?: string
  ts: number
  width: number
  height: number
  taskType: 'detect' | 'segment' | 'pose'
  bboxes: PredBBox[]
  telemetry: Telemetry
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

export type RoiState = {
  enabled: boolean
  polygon: RoiPoint[]
  closed: boolean
  applyFilter: boolean
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
}

export const useConsoleStore = create<ConsoleState>((set, get) => ({
  engine: { device: 'cpu', warming: false },
  params: { conf: 0.25, iou: 0.7, classFilter: [] },
  osd: { bbox: true, masks: false, keypoints: false, labels: true },

  models: [],
  currentModelId: undefined,
  classes: [],

  lastPred: undefined,

  logs: [],
  alert: { active: false, streak: 0 },
  alertConfig: { enabled: false, minFrames: 5, sound: false },
  roi: { enabled: false, polygon: [], closed: false, applyFilter: true },
  connections: { inferWs: 'idle', rtspWs: 'idle' },
  telemetrySummary: {},

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
    set((s) => ({
      logs: [...s.logs.slice(-999), entry],
    })),

  setAlert: (p) => set({ alert: { ...get().alert, ...p } }),
  setAlertConfig: (p) => set({ alertConfig: { ...get().alertConfig, ...p } }),
  setRoi: (p) => set({ roi: { ...get().roi, ...p } }),
  setConnections: (p) => set({ connections: { ...get().connections, ...p } }),
  setTelemetrySummary: (p) => set({ telemetrySummary: { ...get().telemetrySummary, ...p } }),
}))


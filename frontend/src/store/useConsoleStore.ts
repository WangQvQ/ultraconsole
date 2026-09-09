import { create } from 'zustand'
import type {
  AlertConfig, ConnState, Counters, DeviceType, EventEntry, EventsConfig, LogEntry,
  ModelInfo, OSDFlags, Params, PredResponse, RoiState, SystemStats,
} from '../api/contracts'

export type * from '../api/contracts'

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

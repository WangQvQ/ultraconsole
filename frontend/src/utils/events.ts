import type { CountingLine, CountingZone, EventEntry, PredBBox } from '../store/useConsoleStore'
import { pointInPolygon } from './roi'

// 上一帧每个 trackId 的中心点（归一化源图坐标 0..1），以及它落在哪些 zoneId 内
export type TrackerState = {
  prevCenter: Map<number, { x: number; y: number }>
  inZones: Map<number, Set<string>>
  trackClass: Map<number, string>
}

export function newTrackerState(): TrackerState {
  return { prevCenter: new Map(), inZones: new Map(), trackClass: new Map() }
}

function side(line: CountingLine, p: { x: number; y: number }): number {
  // (b - a) × (p - a) 的 z 分量，>0 / <0 表示在线两侧
  const abx = line.b.x - line.a.x
  const aby = line.b.y - line.a.y
  const apx = p.x - line.a.x
  const apy = p.y - line.a.y
  return abx * apy - aby * apx
}

export type ProcessOut = {
  events: EventEntry[]
  lineCounts: Record<string, { in: number; out: number }>
  zoneCounts: Record<string, { current: number; deltaTotal: number }>
}

/**
 * 处理一帧 bboxes，更新 tracker 状态并产生事件。
 * - bbox 必须有 trackId 才参与事件检测（未启用 tracking 时本函数为空跑）。
 * - 坐标会归一化到 [0,1]。
 */
export function processFrame(args: {
  state: TrackerState
  bboxes: PredBBox[]
  width: number
  height: number
  lines: CountingLine[]
  zones: CountingZone[]
  classFilter?: string[]
  ts?: number
}): ProcessOut {
  const { state, bboxes, width, height, lines, zones } = args
  const ts = args.ts ?? Date.now() / 1000
  const events: EventEntry[] = []
  const lineCounts: Record<string, { in: number; out: number }> = {}
  const zoneCounts: Record<string, { current: number; deltaTotal: number }> = {}
  for (const z of zones) zoneCounts[z.id] = { current: 0, deltaTotal: 0 }

  if (width <= 0 || height <= 0) return { events, lineCounts, zoneCounts }

  const activeIds = new Set<number>()

  for (const b of bboxes) {
    if (b.trackId === undefined || b.trackId === null) continue
    if (args.classFilter && args.classFilter.length > 0 && !args.classFilter.includes(b.cls)) continue
    const id = b.trackId
    activeIds.add(id)
    state.trackClass.set(id, b.cls)
    const cx = ((b.x1 + b.x2) / 2) / width
    const cy = ((b.y1 + b.y2) / 2) / height
    const cur = { x: cx, y: cy }
    const prev = state.prevCenter.get(id)

    // ---- 线穿越 ----
    if (prev) {
      for (const l of lines) {
        const s1 = side(l, prev)
        const s2 = side(l, cur)
        if (s1 === 0 || s2 === 0) continue
        if (s1 * s2 < 0) {
          const dir: 'in' | 'out' = s1 < 0 && s2 > 0 ? 'in' : 'out'
          const ck = lineCounts[l.id] || { in: 0, out: 0 }
          ck[dir] += 1
          lineCounts[l.id] = ck
          events.push({ ts, kind: 'line.cross', ref: l.id, trackId: id, cls: b.cls, direction: dir })
        }
      }
    }

    // ---- 区域进/出 ----
    const prevSet = state.inZones.get(id) || new Set<string>()
    const nextSet = new Set<string>()
    for (const z of zones) {
      const inside = z.polygon.length >= 3 && pointInPolygon(cur, z.polygon)
      if (inside) {
        nextSet.add(z.id)
        zoneCounts[z.id].current += 1
        if (!prevSet.has(z.id)) {
          events.push({ ts, kind: 'zone.enter', ref: z.id, trackId: id, cls: b.cls })
          zoneCounts[z.id].deltaTotal += 1
        }
      } else if (prevSet.has(z.id)) {
        events.push({ ts, kind: 'zone.leave', ref: z.id, trackId: id, cls: b.cls })
      }
    }
    state.inZones.set(id, nextSet)
    state.prevCenter.set(id, cur)
  }

  // 清理消失的 track（保留少量帧避免抖动）
  const toDelete: number[] = []
  for (const id of state.prevCenter.keys()) {
    if (!activeIds.has(id)) toDelete.push(id)
  }
  for (const id of toDelete) {
    state.prevCenter.delete(id)
    state.inZones.delete(id)
    state.trackClass.delete(id)
  }

  return { events, lineCounts, zoneCounts }
}

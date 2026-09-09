import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoReport, formatVideoTime, recordVideoFrame, VideoInferenceSession, videoReportCsv } from './videoAnalysis'
import { newTrackerState, processFrame } from './events'
import type { PredResponse } from '../api/contracts'

const line = { id: 'line', name: 'Gate', a: { x: 0.5, y: 0.25 }, b: { x: 0.5, y: 0.75 } }
const zone = { id: 'zone', polygon: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }] }
const params = { conf: 0.25, iou: 0.7, classFilter: [], track: true }
const prediction = (x: number, y = 0.5): PredResponse => ({
  ts: 1700000000, width: 100, height: 100, taskType: 'detect', telemetry: {},
  bboxes: [{ cls: 'person', conf: 0.9, trackId: 1, x1: x * 100 - 1, x2: x * 100 + 1, y1: y * 100 - 1, y2: y * 100 + 1 }],
})
const report = () => createVideoReport('video.mp4', 10, 8, 'model.pt', params, { lines: [line], zones: [zone] })

describe('counting segment', () => {
  for (const [y, expected] of [[0.5, 1], [0.1, 0], [0.9, 0], [0.25, 1]]) {
    it(`counts ${expected} crossing at y=${y}`, () => {
      const state = newTrackerState()
      const frame = (x: number) => processFrame({ state, ...prediction(x, y), lines: [line], zones: [] })
      frame(0.4)
      expect(frame(0.6).events).toHaveLength(expected)
    })
  }
  it('counts both directions but not motion on the same side', () => {
    const state = newTrackerState()
    const frame = (x: number) => processFrame({ state, ...prediction(x), lines: [line], zones: [] })
    frame(0.3)
    expect(frame(0.4).events).toEqual([])
    expect(frame(0.6).events[0].direction).toBe('out')
    expect(frame(0.4).events[0].direction).toBe('in')
  })
})

describe('video reports', () => {
  it('records media time and cumulative counts, isolated between runs', () => {
    const first = report()
    const state = newTrackerState()
    recordVideoFrame(first, state, prediction(0.4), 0)
    recordVideoFrame(first, state, prediction(0.6), 0.125)
    expect(first.counters.byLine.line.out).toBe(1)
    expect(first.counters.byZone.zone).toEqual({ current: 1, total: 1 })
    expect(first.events.map((e) => e.kind)).toEqual(['line.cross', 'zone.enter'])
    expect(first.events[0]).toMatchObject({ mediaTime: 0.125, source: 'video', ts: 1700000000 })
    const second = report()
    recordVideoFrame(second, newTrackerState(), prediction(0.6), 0)
    expect(second.counters.byLine).toEqual({})
  })
  it('exports all events beyond the UI history limit with an honest partial status', () => {
    const current = report()
    const state = newTrackerState()
    for (let i = 0; i < 602; i++) recordVideoFrame(current, state, prediction(i % 2 ? 0.6 : 0.4), i / 8)
    current.status = 'stopped'
    const csv = videoReportCsv(current)
    expect(current.events.length).toBeGreaterThan(500)
    expect(csv.match(/"line.cross"/g)).toHaveLength(601)
    expect(csv).toContain('"status","stopped"')
    expect(csv).toContain('"last_sample_seconds","75.125"')
  })
  it('snapshots rules and protects CSV text while preserving timestamps', () => {
    const config = { lines: [structuredClone(line)], zones: [] }
    const current = createVideoReport('=SUM(1,2).mp4', 10, 8, 'model.pt', params, config)
    config.lines[0].name = 'Changed'
    expect(current.config.lines[0].name).toBe('Gate')
    expect(videoReportCsv(current)).toContain('"\'=SUM(1,2).mp4"')
    expect(formatVideoTime(3661.125)).toBe('01:01:01.125')
  })
})

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 1
  onopen?: () => void
  onmessage?: (message: { data: string }) => void
  onclose?: (() => void) | null
  onerror?: (() => void) | null
  sent: { frameId: string }[] = []
  constructor() { FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()) }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { this.readyState = 3 }
}

afterEach(() => vi.unstubAllGlobals())
it('isolates sockets between runs and rejects in-flight work on cancellation', async () => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  const controller = new AbortController()
  const first = new VideoInferenceSession(controller.signal)
  const pending = first.infer('jpeg', params)
  const rejection = expect(pending).rejects.toThrow('Aborted')
  await Promise.resolve()
  controller.abort()
  await rejection
  const second = new VideoInferenceSession(new AbortController().signal)
  const result = second.infer('jpeg', params)
  await Promise.resolve()
  await Promise.resolve()
  const socket = FakeSocket.instances.at(-1)!
  socket.onmessage?.({ data: JSON.stringify({ type: 'pred', ...prediction(0.4), frameId: socket.sent[0].frameId }) })
  await expect(result).resolves.toMatchObject({ bboxes: prediction(0.4).bboxes })
  second.close()
})

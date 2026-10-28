import { describe, expect, it } from 'vitest'
import type { PredDenseMap } from '../api/contracts'
import { decodeDenseMap, denseMapNpy } from './denseMap'

const values = new Float32Array([1, 2.5, NaN, 150])
const map: PredDenseMap = { width: 2, height: 2, dtype: 'float32', unit: 'm', modelId: 'depth.pt', classes: {},
  dataBase64: btoa(String.fromCharCode(...new Uint8Array(values.buffer))), pngBase64: '' }

describe('dense map inspection and numeric export', () => {
  it('maps normalized coordinates, clamps edges and excludes invalid depth', () => {
    const decoded = decodeDenseMap(map)
    expect(decoded.read(0, 0)).toBe(1)
    expect(decoded.read(.6, 0)).toBe(2.5)
    expect(decoded.read(0, .6)).toBeNull()
    expect(decoded.read(1, 1)).toBe(150)
  })
  it('writes a NumPy header and the original floating-point values', () => {
    const npy = denseMapNpy(map)
    expect(Array.from(npy.slice(0, 8))).toEqual([147, 78, 85, 77, 80, 89, 1, 0])
    const length = new DataView(npy.buffer).getUint16(8, true)
    const header = new TextDecoder().decode(npy.slice(10, 10 + length))
    expect(header).toContain("'descr': '<f4'")
    expect(header).toContain("'shape': (2, 2)")
    expect((10 + length) % 64).toBe(0)
    expect(npy.slice(10 + length)).toEqual(new Uint8Array(values.buffer))
  })
  it('rejects truncated buffers and oversized maps', () => {
    expect(() => decodeDenseMap({ ...map, dataBase64: '' })).toThrow()
    expect(() => decodeDenseMap({ ...map, width: 257 })).toThrow()
  })
  it('retains semantic IDs above 255 and treats the ignore ID as empty', () => {
    const data = new Uint16Array([513, 255, 0, 1])
    const decoded = decodeDenseMap({ ...map, dtype: 'uint16', unit: 'class-id', dataBase64: btoa(String.fromCharCode(...new Uint8Array(data.buffer))) })
    expect(decoded.read(0, 0)).toBe(513)
    expect(decoded.read(.6, 0)).toBeNull()
    expect(decoded.read(0, .6)).toBe(0)
  })
})

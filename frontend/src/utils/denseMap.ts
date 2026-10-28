import type { PredDenseMap } from '../api/contracts'

export function decodeDenseMap(map: PredDenseMap) {
  const itemSize = map.dtype === 'float32' ? 4 : 2
  const bytes = Uint8Array.from(atob(map.dataBase64), (c) => c.charCodeAt(0))
  if (map.width < 1 || map.height < 1 || map.width > 256 || map.height > 256 || bytes.length !== map.width * map.height * itemSize) {
    throw new Error('Invalid dense map dimensions or payload')
  }
  const view = new DataView(bytes.buffer)
  return {
    bytes,
    read(x: number, y: number) {
      const ix = Math.min(map.width - 1, Math.max(0, Math.floor(x * map.width)))
      const iy = Math.min(map.height - 1, Math.max(0, Math.floor(y * map.height)))
      const offset = (iy * map.width + ix) * itemSize
      const value = map.dtype === 'float32' ? view.getFloat32(offset, true) : view.getUint16(offset, true)
      return Number.isFinite(value) && (map.unit !== 'm' || value > 0) && (map.unit !== 'class-id' || value !== 255) ? value : null
    },
  }
}

/** NumPy v1 format. Export explicitly preserves the sampled dimensions and numeric scale. */
export function denseMapNpy(map: PredDenseMap): Uint8Array<ArrayBuffer> {
  const { bytes } = decodeDenseMap(map)
  const text = `{'descr': '${map.dtype === 'float32' ? '<f4' : '<u2'}', 'fortran_order': False, 'shape': (${map.height}, ${map.width}), }`
  const padding = (64 - ((10 + text.length + 1) % 64)) % 64
  const header = new TextEncoder().encode(text + ' '.repeat(padding) + '\n')
  const output = new Uint8Array(10 + header.length + bytes.length)
  output.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0])
  new DataView(output.buffer).setUint16(8, header.length, true)
  output.set(header, 10)
  output.set(bytes, 10 + header.length)
  return output
}

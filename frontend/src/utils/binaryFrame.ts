export type BinaryFrameMeta = {
  type: 'frame'
  streamId: string
  frameId: string
  ts: number
  width: number
  height: number
}

/** Decode: uint32 big-endian header length + UTF-8 JSON header + JPEG bytes. */
export function decodeBinaryFrame(data: unknown): { meta: BinaryFrameMeta; jpeg: Blob } | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 5) return null
  const view = new DataView(data)
  const headerLength = view.getUint32(0, false)
  if (headerLength < 2 || headerLength > data.byteLength - 4) return null
  try {
    const headerBytes = new Uint8Array(data, 4, headerLength)
    const meta = JSON.parse(new TextDecoder().decode(headerBytes)) as BinaryFrameMeta
    if (meta.type !== 'frame' || !meta.streamId) return null
    return { meta, jpeg: new Blob([data.slice(4 + headerLength)], { type: 'image/jpeg' }) }
  } catch {
    return null
  }
}

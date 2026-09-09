import { describe, expect, it } from 'vitest'

import { decodeBinaryFrame } from './binaryFrame'

function packet(meta: object, jpeg: number[]) {
  const header = new TextEncoder().encode(JSON.stringify(meta))
  const output = new Uint8Array(4 + header.length + jpeg.length)
  new DataView(output.buffer).setUint32(0, header.length, false)
  output.set(header, 4)
  output.set(jpeg, 4 + header.length)
  return output.buffer
}

describe('decodeBinaryFrame', () => {
  it('decodes metadata and JPEG payload', async () => {
    const value = decodeBinaryFrame(
      packet({ type: 'frame', streamId: 'cam_1', frameId: '3', ts: 1, width: 2, height: 2 }, [0xff, 0xd8]),
    )
    expect(value?.meta.streamId).toBe('cam_1')
    expect(Array.from(new Uint8Array(await value!.jpeg.arrayBuffer()))).toEqual([0xff, 0xd8])
  })

  it('rejects malformed packets', () => {
    expect(decodeBinaryFrame(new ArrayBuffer(3))).toBeNull()
  })
})

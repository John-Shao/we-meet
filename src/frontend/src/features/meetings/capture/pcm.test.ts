import { describe, expect, it } from 'vitest'
import { CHUNK_FRAMES, PcmFramer, pcmWave } from './pcm'

describe('standalone PCM framing', () => {
  it('preserves samples across callback boundaries and emits a correct little-endian WAV', () => {
    const chunks: Int16Array[] = []
    const framer = new PcmFramer((pcm) => chunks.push(pcm))
    framer.push(new Float32Array(CHUNK_FRAMES - 1).fill(1))
    expect(chunks).toHaveLength(0)
    framer.push(
      new Float32Array([-1, 0, 0.5, 2, -2, NaN, ...Array(10).fill(0)])
    )
    expect(chunks).toHaveLength(1)
    framer.push(new Float32Array([0]))
    framer.flush()
    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK_FRAMES, 16])
    expect([...chunks[1].slice(0, 5)]).toEqual([0, 16384, 32767, -32768, 0])
    const encoded = pcmWave(chunks[0])
    const view = new DataView(encoded)
    expect(new TextDecoder().decode(encoded.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(encoded.byteLength - 8)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(40, true)).toBe(CHUNK_FRAMES * 2)
    expect(view.getInt16(encoded.byteLength - 2, true)).toBe(-32768)
  })

  it('rejects empty, overlong and partial-millisecond uploads', () => {
    for (const size of [0, 17, 160016])
      expect(() => pcmWave(new Int16Array(size))).toThrow()
    expect(pcmWave(new Int16Array(16)).byteLength).toBe(76)
  })
})

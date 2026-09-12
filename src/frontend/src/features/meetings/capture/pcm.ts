/** The browser's AudioContext performs resampling; never label another rate 16 kHz. */
export const SAMPLE_RATE = 16000
export const CHUNK_FRAMES = SAMPLE_RATE * 5
export const MAX_CHUNKS = 4320
export const MAX_PENDING_BYTES = 32 * 1024 * 1024

export function pcmWave(pcm: Int16Array): ArrayBuffer {
  if (!pcm.length || pcm.length > SAMPLE_RATE * 10 || pcm.length % 16 !== 0)
    throw new Error('invalid_pcm')
  const data = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(data)
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0))
    )
  text(0, 'RIFF')
  view.setUint32(4, data.byteLength - 8, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  pcm.forEach((value, index) => view.setInt16(44 + index * 2, value, true))
  return data
}

export async function checksum(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Fixed memory, mono PCM frames; a short stop tail is aligned to whole milliseconds. */
export class PcmFramer {
  private buffer = new Int16Array(CHUNK_FRAMES)
  private length = 0

  constructor(private emit: (pcm: Int16Array) => void) {}

  push(input: Float32Array) {
    for (const value of input) {
      const clamped = Math.max(
        -1,
        Math.min(1, Number.isFinite(value) ? value : 0)
      )
      this.buffer[this.length++] = Math.round(
        clamped * (clamped < 0 ? 32768 : 32767)
      )
      if (this.length === CHUNK_FRAMES) this.flush()
    }
  }

  flush() {
    const count = this.length - (this.length % 16)
    if (count) this.emit(this.buffer.slice(0, count))
    this.buffer.copyWithin(0, count, this.length)
    this.length -= count
  }
}

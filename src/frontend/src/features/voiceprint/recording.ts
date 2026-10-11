import { MAX_WAV_BYTES } from './api'

const RATE = 24000
const MAX_FRAMES = RATE * 10
const MAX_RECORDING_BYTES = 600000

/** Produce the server's single-channel 24 kHz PCM16 WAV; never persist audio. */
export function pcmWav(samples: Float32Array): Blob {
  if (samples.length < RATE * 3 || samples.length > MAX_FRAMES)
    throw new Error('duration')
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)
  const text = (offset: number, value: string) =>
    [...value].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0))
    )
  text(0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((value, index) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('audio')
    view.setInt16(
      44 + index * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true
    )
  })
  return new Blob([bytes], { type: 'audio/wav' })
}

export async function validateWav(blob: Blob) {
  if (blob.size < 44 || blob.size > MAX_WAV_BYTES) throw new Error('audio')
  const view = new DataView(await blob.arrayBuffer())
  const ascii = (offset: number, count: number) =>
    String.fromCharCode(...new Uint8Array(view.buffer, offset, count))
  if (
    ascii(0, 4) !== 'RIFF' ||
    ascii(8, 4) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== blob.size
  )
    throw new Error('audio')
  let position = 12,
    frames = 0,
    format = false,
    dataSeen = false
  while (position + 8 <= blob.size) {
    const type = ascii(position, 4),
      size = view.getUint32(position + 4, true)
    const start = position + 8,
      end = start + size
    if (end + (size % 2) > blob.size) throw new Error('audio')
    if (type === 'fmt ') {
      if (
        format ||
        ![16, 18].includes(size) ||
        (size === 18 && view.getUint16(start + 16, true) !== 0) ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== RATE ||
        view.getUint32(start + 8, true) !== RATE * 2 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw new Error('audio')
      format = true
    } else if (type === 'data') {
      if (dataSeen || !format || size % 2) throw new Error('audio')
      dataSeen = true
      frames = size / 2
    }
    position = end + (size % 2)
  }
  if (!format || !dataSeen || position !== blob.size) throw new Error('audio')
  if (frames < RATE * 3 || frames > MAX_FRAMES) throw new Error('duration')
  return frames / RATE
}

export class VoiceprintRecorder {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private timer?: ReturnType<typeof setTimeout>
  private reject?: (reason: Error) => void
  private canceled = false
  private started = false

  async start(
    signal: AbortSignal,
    onStarted: () => void,
    onPreparing?: () => void
  ): Promise<Blob> {
    if (this.started) throw new Error('audio')
    this.started = true
    const cancel = () => this.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('canceled')
      const permission = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      })
      void permission
        .then((stream) => {
          if (this.canceled || signal.aborted)
            stream.getTracks().forEach((track) => track.stop())
        })
        .catch(() => undefined)
      this.stream = await Promise.race([
        permission,
        new Promise<never>((_resolve, reject) => {
          this.reject = reject
        }),
      ])
      if (signal.aborted || this.canceled) throw new Error('canceled')
      const parts: Blob[] = []
      let length = 0
      const result = await new Promise<Blob>((resolve, reject) => {
        this.reject = reject
        try {
          this.recorder = new MediaRecorder(this.stream!, {
            audioBitsPerSecond: 128000,
          })
          this.recorder.ondataavailable = (event) => {
            length += event.data.size
            if (length > MAX_RECORDING_BYTES) {
              reject(new Error('audio'))
              this.cancel()
              return
            }
            if (!this.canceled) parts.push(event.data)
          }
          this.recorder.onerror = () => {
            reject(new Error('microphone'))
            this.cancel()
          }
          this.recorder.onstop = () =>
            resolve(new Blob(parts, { type: this.recorder?.mimeType }))
          this.recorder.start(250)
          this.timer = setTimeout(() => this.finish(), 10000)
          onStarted()
        } catch {
          reject(new Error('microphone'))
        }
      })
      if (this.canceled || signal.aborted) throw new Error('canceled')
      if (result.size === 0) throw new Error('audio')
      onPreparing?.()
      // Decode only our short, bounded local recording, never an arbitrary media URL.
      const decoder = new OfflineAudioContext(1, 1, RATE)
      const decoded = await Promise.race([
        result.arrayBuffer().then((bytes) => {
          if (this.canceled || signal.aborted) throw new Error('canceled')
          return decoder.decodeAudioData(bytes)
        }),
        new Promise<never>((_resolve, reject) => {
          this.reject = reject
          this.timer = setTimeout(() => reject(new Error('audio')), 10000)
        }),
      ])
      if (this.canceled || signal.aborted) throw new Error('canceled')
      if (
        decoded.sampleRate !== RATE ||
        decoded.length < RATE * 3 ||
        decoded.length > RATE * 11 ||
        decoded.numberOfChannels > 2 ||
        decoded.numberOfChannels < 1
      )
        throw new Error('duration')
      const samples = new Float32Array(Math.min(decoded.length, MAX_FRAMES))
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const input = decoded.getChannelData(channel)
        samples.forEach((_value, index) => {
          samples[index] += input[index] / decoded.numberOfChannels
        })
      }
      // Browser decoding/resampling can overshoot full scale. Saturate to the
      // PCM16 range without normalizing away clipping; server quality checks
      // still see the saturated peaks. Non-finite samples remain invalid.
      samples.forEach((value, index) => {
        if (!Number.isFinite(value)) throw new Error('audio')
        samples[index] = Math.max(-1, Math.min(1, value))
      })
      return pcmWav(samples)
    } finally {
      signal.removeEventListener('abort', cancel)
      this.cleanup()
    }
  }

  finish() {
    clearTimeout(this.timer)
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.stream?.getTracks().forEach((track) => track.stop())
  }
  cancel() {
    this.canceled = true
    this.reject?.(new Error('canceled'))
    this.finish()
    this.cleanup()
  }
  private cleanup() {
    clearTimeout(this.timer)
    this.stream?.getTracks().forEach((track) => track.stop())
    if (this.recorder) {
      this.recorder.ondataavailable = null
      this.recorder.onerror = null
      this.recorder.onstop = null
    }
    this.reject = undefined
  }
}

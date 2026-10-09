import { Blob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pcmWav, validateWav, VoiceprintRecorder } from './recording'

beforeEach(() => {
  vi.stubGlobal('Blob', Blob)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('encodes finite samples to the exact backend PCM format and duration boundaries', async () => {
  for (const seconds of [3, 8, 10]) {
    const wav = pcmWav(
      Float32Array.from(
        { length: 24000 * seconds },
        (_, i) => 0.1 * Math.sin(i / 10)
      )
    )
    expect(await validateWav(wav)).toBe(seconds)
    const view = new DataView(await wav.arrayBuffer())
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
  }
  for (const input of [
    new Float32Array(100),
    new Float32Array(240001),
    new Float32Array(72000).fill(NaN),
  ])
    expect(() => pcmWav(input)).toThrow()
})

it('rejects malformed, oversized and mismatched WAV containers before any upload', async () => {
  const wav = await pcmWav(new Float32Array(72000)).arrayBuffer()
  const corrupt = wav.slice(0)
  new DataView(corrupt).setUint32(24, 48000, true)
  for (const value of [
    new Blob(['not audio']),
    new Blob([new Uint8Array(484097)]),
    new Blob([corrupt]),
    new Blob([wav.slice(0, -1)]),
  ])
    await expect(validateWav(value as globalThis.Blob)).rejects.toThrow()
})

it('rejects multiple data chunks even when the first one is empty', async () => {
  const original = new Uint8Array(
    await pcmWav(new Float32Array(72000)).arrayBuffer()
  )
  const bytes = new Uint8Array(original.length + 8)
  bytes.set(original.subarray(0, 44))
  bytes.set(original.subarray(36), 44)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, bytes.length - 8, true)
  view.setUint32(40, 0, true)
  await expect(
    validateWav(new Blob([bytes]) as globalThis.Blob)
  ).rejects.toThrow('audio')
})

it('cancels a still-open browser permission prompt and stops a late microphone grant', async () => {
  let grant!: (value: MediaStream) => void
  const stop = vi.fn(),
    stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(
        () =>
          new Promise((r) => {
            grant = r
          })
      ),
    },
  })
  const recorder = new VoiceprintRecorder(),
    lifetime = new AbortController()
  const pending = recorder.start(lifetime.signal, vi.fn())
  const assertion = expect(pending).rejects.toThrow('canceled')
  recorder.cancel()
  await assertion
  grant(stream)
  await Promise.resolve()
  expect(stop).toHaveBeenCalled()
})

it.each([0, 1.03, -1.03])(
  'stops the microphone and quantizes decoder overshoot to bounded PCM16: %s',
  async (amplitude) => {
    vi.useFakeTimers()
    const stop = vi.fn(),
      stream = { getTracks: () => [{ stop }] }
    class Recorder {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable?: (event: { data: globalThis.Blob }) => void
      onstop?: () => void
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['bounded recording']) as globalThis.Blob,
        })
        this.onstop?.()
      }
    }
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    })
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData() {
          return {
            sampleRate: 24000,
            length: 240000,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(240000).fill(amplitude),
          }
        }
      }
    )
    const started = vi.fn(),
      recorder = new VoiceprintRecorder()
    const pending = recorder.start(new AbortController().signal, started)
    await vi.advanceTimersByTimeAsync(10000)
    const wav = await pending
    expect(started).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalled()
    expect(await validateWav(wav)).toBe(10)
    expect(wav.size).toBe(480044)
    expect(new DataView(await wav.arrayBuffer()).getInt16(44, true)).toBe(
      amplitude > 0 ? 32767 : amplitude < 0 ? -32768 : 0
    )
  }
)

it.each(['cancel', 'timeout'])(
  'releases a stopped recording when audio decoding hangs: %s',
  async (action) => {
    vi.useFakeTimers()
    const stop = vi.fn()
    class Recorder {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable?: (event: { data: globalThis.Blob }) => void
      onstop?: () => void
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['short recording']) as globalThis.Blob,
        })
        this.onstop?.()
      }
    }
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
      },
    })
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return new Promise(() => undefined)
        }
      }
    )
    const recorder = new VoiceprintRecorder()
    const preparing = vi.fn()
    const pending = recorder.start(
      new AbortController().signal,
      vi.fn(),
      preparing
    )
    const assertion = expect(pending).rejects.toThrow(
      action === 'cancel' ? 'canceled' : 'audio'
    )
    await vi.advanceTimersByTimeAsync(4000)
    recorder.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(preparing).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalled()
    if (action === 'cancel') recorder.cancel()
    else await vi.advanceTimersByTimeAsync(10000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  }
)

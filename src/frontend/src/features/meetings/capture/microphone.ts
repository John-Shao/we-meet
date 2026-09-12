import workletUrl from './capture.worklet.ts?worker&url'
import { SAMPLE_RATE } from './pcm'

/** The owning controller must hold the account's Web Lock for this object's lifetime. */
export class CaptureMicrophone {
  private queue = Promise.resolve()
  private failed = false
  private closing = false
  private drains = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  private failure: Error | undefined

  private constructor(
    private stream: MediaStream,
    private context: AudioContext,
    private processor: AudioWorkletNode,
    sink: (pcm: Int16Array) => Promise<void>,
    private onFailure: () => void
  ) {
    processor.port.onmessage = ({ data }) => {
      if (data.kind === 'failed') {
        this.fail()
        return
      }
      if (data.kind === 'pcm') {
        this.queue = this.queue
          .then(async () => {
            if (this.failed) throw new Error('audio_capture_interrupted')
            await sink(data.pcm)
            processor.port.postMessage({ kind: 'ack', sequence: data.sequence })
          })
          .catch(() => {
            this.fail()
          })
      }
      if (data.kind === 'drained') {
        void this.queue.then(() => {
          const pending = this.drains.get(data.id)
          this.drains.delete(data.id)
          if (this.failure) pending?.reject(this.failure)
          else pending?.resolve()
        })
      }
    }
    processor.onprocessorerror = () => this.fail()
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => this.fail()
    })
    context.onstatechange = () => {
      if (!this.closing && context.state !== 'running') this.fail()
    }
  }

  static async open(
    sink: (pcm: Int16Array) => Promise<void>,
    onFailure: () => void
  ) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error('microphone_unsupported')
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    let stream: MediaStream | undefined
    try {
      if (context.sampleRate !== SAMPLE_RATE)
        throw new Error('sample_rate_unsupported')
      // Resume in the explicit user gesture, before waiting for device permission/network.
      await context.resume()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })
      await context.audioWorklet.addModule(workletUrl)
      const processor = new AudioWorkletNode(context, 'meeting-pcm-capture', {
        channelCount: 1,
        channelCountMode: 'explicit',
        numberOfInputs: 1,
        numberOfOutputs: 1,
      })
      const silence = context.createGain()
      silence.gain.value = 0
      context.createMediaStreamSource(stream).connect(processor)
      processor.connect(silence).connect(context.destination)
      return new CaptureMicrophone(stream, context, processor, sink, onFailure)
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      await context.close()
      throw error
    }
  }

  start() {
    if (this.failed || this.closing || this.context.state !== 'running')
      throw new Error('microphone_unavailable')
    this.processor.port.postMessage({ kind: 'start' })
  }

  async pause() {
    if (this.failure) throw this.failure
    if (this.closing) throw new Error('microphone_closed')
    const id = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => this.fail(), 10000)
      this.drains.set(id, {
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      this.processor.port.postMessage({ kind: 'pause', id })
    })
  }

  async stop() {
    try {
      await this.pause()
    } finally {
      this.close()
    }
  }

  close() {
    this.closing = true
    this.stream.getTracks().forEach((track) => track.stop())
    this.processor.disconnect()
    this.processor.port.close()
    void this.context.close().catch(() => undefined)
    this.drains.forEach(({ reject }) => reject(new Error('microphone_closed')))
    this.drains.clear()
  }

  private fail() {
    if (this.failed || this.closing) return
    this.failed = true
    this.failure = new Error('audio_capture_interrupted')
    this.close()
    this.onFailure()
  }
}

/** Fail closed on older browsers; a second tab never steals an active microphone lease. */
export async function withCaptureLock<T>(
  viewerId: string,
  run: () => Promise<T>
): Promise<T> {
  if (!navigator.locks) throw new Error('recording_lock_unsupported')
  return navigator.locks.request(
    `meeting-audio:${viewerId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('recording_open_in_another_tab')
      return run()
    }
  )
}

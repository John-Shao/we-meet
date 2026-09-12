import { PcmFramer, SAMPLE_RATE } from './pcm'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor
): void

/** No network or persistence on the audio thread. Unacknowledged transfer is bounded. */
class CaptureProcessor extends AudioWorkletProcessor {
  private active = false
  private failed = false
  private sequence = 0
  private pending = new Set<number>()
  private framer = new PcmFramer((pcm) => {
    if (this.pending.size >= 2) {
      this.fail()
      return
    }
    const sequence = ++this.sequence
    this.pending.add(sequence)
    this.port.postMessage({ kind: 'pcm', sequence, pcm }, [pcm.buffer])
  })

  constructor() {
    super()
    if (sampleRate !== SAMPLE_RATE) this.fail()
    this.port.onmessage = ({ data }) => {
      if (data.kind === 'ack') this.pending.delete(data.sequence)
      if (this.failed) return
      if (data.kind === 'start') this.active = true
      if (data.kind === 'pause' || data.kind === 'stop') {
        this.active = false
        this.framer.flush()
        this.port.postMessage({ kind: 'drained', id: data.id })
      }
    }
  }

  private fail() {
    this.failed = true
    this.active = false
    this.port.postMessage({ kind: 'failed' })
  }

  process(inputs: Float32Array[][]) {
    if (this.active && !this.failed && inputs[0]?.[0])
      this.framer.push(inputs[0][0])
    return !this.failed
  }
}

registerProcessor('meeting-pcm-capture', CaptureProcessor)

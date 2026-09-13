import { PcmFramer, SAMPLE_RATE } from './pcm'

export const TAP_FRAMES = SAMPLE_RATE / 10
export const TAP_PENDING_LIMIT = 4
export type TapEnd = 'closed' | 'paused' | 'backpressure'
export type TapEvent =
  | { kind: 'tap_pcm'; generation: string; sequence: number; pcm: Int16Array }
  | { kind: 'tap_end'; generation: string; reason: TapEnd }

/** Optional 100 ms copies. Overflow ends only this tap, never the recording framer. */
export class CapturePcmTap {
  private generation: string | null = null
  private framer: PcmFramer | null = null
  private pending = new Set<number>()
  private sequence = 0

  constructor(private emit: (event: TapEvent) => void) {}

  start(generation: string) {
    if (
      typeof generation !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(generation)
    )
      return
    this.end('closed')
    this.generation = generation
    this.sequence = 0
    this.framer = new PcmFramer((pcm) => {
      if (this.generation !== generation) {
        pcm.fill(0)
        return
      }
      if (this.pending.size >= TAP_PENDING_LIMIT) {
        pcm.fill(0)
        this.end('backpressure')
        return
      }
      const sequence = ++this.sequence
      this.pending.add(sequence)
      try {
        this.emit({ kind: 'tap_pcm', generation, sequence, pcm })
      } catch {
        pcm.fill(0)
        this.end('backpressure')
      }
    }, TAP_FRAMES)
  }

  acknowledge(generation: string, sequence: number) {
    if (generation === this.generation) this.pending.delete(sequence)
  }

  push(input: Float32Array) {
    this.framer?.push(input)
  }

  stop(generation: string) {
    if (generation === this.generation) this.end('closed')
  }

  finish() {
    this.framer?.flush()
    this.end('paused')
  }

  close() {
    this.end('closed')
  }

  private end(reason: TapEnd) {
    const generation = this.generation
    this.generation = null
    this.framer?.clear()
    this.framer = null
    this.pending.clear()
    if (generation) {
      try {
        this.emit({ kind: 'tap_end', generation, reason })
      } catch {
        /* A closed consumer cannot interrupt the original recording. */
      }
    }
  }
}

export interface CapturePcmListener {
  /** Copy/queue synchronously and return false on backpressure. Buffers are zeroed on return. */
  pcm(samples: Int16Array): boolean
  ended(reason: TapEnd): void
}

/** Main-thread generation fencing; late audio and callbacks cannot enter a new consumer. */
export class CapturePcmReceiver {
  private active?: {
    generation: string
    listener: CapturePcmListener
    sequence: number
  }

  constructor(private send: (message: object) => void) {}

  attach(generation: string, listener: CapturePcmListener) {
    this.close()
    this.active = { generation, listener, sequence: 0 }
    try {
      this.send({ kind: 'tap_start', generation })
    } catch {
      this.close()
    }
    return () => {
      if (this.active?.generation === generation) this.close()
    }
  }

  receive(event: TapEvent) {
    const active = this.active
    if (event.kind === 'tap_end') {
      if (active?.generation === event.generation) this.close(event.reason)
      return
    }
    try {
      if (!active || active.generation !== event.generation) return
      if (
        event.sequence !== active.sequence + 1 ||
        !event.pcm.length ||
        event.pcm.length > TAP_FRAMES ||
        event.pcm.length % 16
      ) {
        this.close('backpressure')
        return
      }
      active.sequence = event.sequence
      const accepted = active.listener.pcm(event.pcm)
      if (this.active !== active) return
      if (accepted !== true) {
        this.close('backpressure')
        return
      }
      this.send({
        kind: 'tap_ack',
        generation: event.generation,
        sequence: event.sequence,
      })
    } catch {
      if (this.active === active) this.close('backpressure')
    } finally {
      event.pcm.fill(0)
    }
  }

  close(reason: TapEnd = 'closed') {
    const active = this.active
    this.active = undefined
    if (!active) return
    try {
      this.send({ kind: 'tap_stop', generation: active.generation })
    } catch {
      /* Port may already be closed. */
    }
    try {
      active.listener.ended(reason)
    } catch {
      /* Optional consumer failures never reach the recording sink. */
    }
  }
}

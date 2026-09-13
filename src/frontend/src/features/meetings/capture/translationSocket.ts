import type { CapturePcmListener, CapturePcmReceiver, TapEnd } from './tap'
import {
  isConfiguration,
  isTranslationTicket,
  object,
  positive,
  sameConfiguration,
  type CaptureTranslationRun,
  type CaptureTranslationSource,
  type CaptureTranslationTicket,
} from './translationProtocol'

export type TranslationDirection = 'forward' | 'reverse'
export interface LiveTranslationText {
  id: string
  direction: TranslationDirection
  text: string
}
export interface TranslationSocketState {
  phase:
    | 'connecting'
    | 'ready'
    | 'speaking'
    | 'draining'
    | 'awaiting'
    | 'finishing'
    | 'stopped'
    | 'incomplete'
    | 'unknown'
  direction?: TranslationDirection
  candidate?: LiveTranslationText
  finals: LiveTranslationText[]
}
type Subscription = ReturnType<CapturePcmReceiver['attach']>
type Wire = Pick<
  WebSocket,
  | 'send'
  | 'close'
  | 'readyState'
  | 'bufferedAmount'
  | 'onopen'
  | 'onmessage'
  | 'onerror'
  | 'onclose'
>
interface Options {
  source: CaptureTranslationSource
  run: CaptureTranslationRun
  ticket: CaptureTranslationTicket
  authorized: () => boolean
  observe: (listener: CapturePcmListener) => Subscription
  changed: (state: TranslationSocketState) => void
  audio?: (samples: Int16Array) => void
  socket?: (url: string) => Wire
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128

/** No reconnect, audio replay, persistent transcript or second microphone. */
export class CaptureTranslationSocket {
  state: TranslationSocketState = { phase: 'connecting', finals: [] }
  private socket?: Wire
  private tap?: Subscription
  private ended = false
  private ready = false
  private sequence = 0
  private pending = new Map<number, { audio: boolean; at: number }>()
  private finalIds = new Set<string>()
  private afterDrain?: 'end' | 'finish'
  private endSequence?: number
  private deadline = Date.now() + 45000
  private timer?: ReturnType<typeof setInterval>

  constructor(private options: Options) {}

  private authorized() {
    try {
      return !this.ended && this.options.authorized()
    } catch {
      return false
    }
  }
  private publish(patch: Partial<TranslationSocketState>) {
    this.state = { ...this.state, ...patch }
    this.options.changed(this.state)
  }

  connect() {
    if (
      this.socket ||
      !this.authorized() ||
      !isTranslationTicket(
        this.options.ticket,
        this.options.source,
        this.options.run
      )
    )
      throw new Error('translation_connection_unavailable')
    const socket = (this.options.socket ?? ((url) => new WebSocket(url)))(
      this.options.ticket.gateway_url
    )
    this.socket = socket
    socket.onopen = () => {
      if (
        !this.authorized() ||
        Date.parse(this.options.ticket.expires_at) <= Date.now()
      )
        return this.abort()
      try {
        socket.send(
          JSON.stringify({
            type: 'authenticate',
            ticket: this.options.ticket.ticket,
            run_id: this.options.run.id,
            capture_id: this.options.source.captureId,
            generation: this.options.run.generation,
          })
        )
      } catch {
        this.abort()
      }
    }
    socket.onmessage = ({ data }) => {
      try {
        if (!this.authorized()) return this.abort()
        if (typeof data !== 'string' || data.length > 131072)
          throw new Error('invalid_translation_event')
        this.receive(JSON.parse(data))
      } catch {
        this.abort()
      }
    }
    socket.onerror = () => this.end('unknown')
    socket.onclose = () => this.end('unknown')
    this.timer = setInterval(() => {
      if (!this.authorized()) return this.abort()
      if (
        (this.deadline && this.deadline < Date.now()) ||
        [...this.pending.values()].some((item) => item.at + 5000 < Date.now())
      )
        this.end('unknown')
    }, 200)
  }

  private envelope(value: unknown): value is Record<string, unknown> {
    return (
      object(value) &&
      value.run_id === this.options.run.id &&
      value.capture_id === this.options.source.captureId &&
      value.generation === this.options.run.generation
    )
  }

  private receive(value: unknown) {
    if (!this.envelope(value)) throw new Error('translation_source_changed')
    if (value.type === 'finished') {
      if (
        typeof value.status !== 'string' ||
        !['stopped', 'incomplete', 'unknown'].includes(value.status) ||
        typeof value.complete !== 'boolean' ||
        value.complete !== (value.status === 'stopped')
      )
        throw new Error('invalid_translation_finish')
      this.end(value.status as 'stopped' | 'incomplete' | 'unknown')
      return
    }
    if (value.type === 'ready') {
      if (
        this.ready ||
        !isConfiguration(value.configuration) ||
        !sameConfiguration(value.configuration, this.options.run.configuration)
      )
        throw new Error('invalid_translation_ready')
      this.ready = true
      this.deadline = 0
      this.publish({ phase: 'ready' })
      if (this.options.run.configuration.mode === 'simultaneous') this.attach()
      return
    }
    if (!this.ready) throw new Error('translation_not_ready')
    if (value.type === 'ack') {
      if (
        !positive(value.sequence) ||
        value.sequence !== this.pending.keys().next().value
      )
        throw new Error('invalid_translation_ack')
      this.pending.delete(value.sequence)
      return
    }
    if (
      value.direction !== 'forward' &&
      !(
        value.direction === 'reverse' &&
        this.options.run.configuration.mode === 'push_to_talk'
      )
    )
      throw new Error('invalid_translation_direction')
    const direction = value.direction as TranslationDirection
    if (value.type === 'turn_empty') {
      if (
        !['awaiting', 'finishing'].includes(this.state.phase) ||
        this.state.direction !== direction ||
        value.sequence !== this.endSequence
      )
        throw new Error('invalid_translation_turn')
      if (this.state.phase !== 'finishing') {
        this.deadline = 0
        this.publish({ phase: 'ready', direction: undefined })
      }
      return
    }
    if (value.type === 'response_completed') {
      if (!identity(value.response_id))
        throw new Error('invalid_translation_response')
      if (
        this.state.phase === 'awaiting' &&
        this.state.direction === direction
      ) {
        this.deadline = 0
        this.publish({ phase: 'ready', direction: undefined })
      }
      return
    }
    if (!identity(value.response_id) || !identity(value.item_id))
      throw new Error('invalid_translation_item')
    if (value.type === 'audio') {
      this.audio(value.audio, value.sample_rate)
      return
    }
    if (
      (value.type !== 'target_candidate' && value.type !== 'target_final') ||
      typeof value.text !== 'string' ||
      value.text.length > 20000 ||
      (value.type === 'target_final' && !value.text.trim())
    )
      throw new Error('invalid_translation_text')
    const text = {
      id: JSON.stringify([direction, value.response_id, value.item_id]),
      direction,
      text: value.text,
    }
    if (value.type === 'target_candidate') {
      if (this.finalIds.has(text.id))
        throw new Error('translation_item_completed')
      this.publish({ candidate: text })
    } else {
      if (this.finalIds.has(text.id) || this.finalIds.size >= 20000)
        throw new Error('translation_item_completed')
      this.finalIds.add(text.id)
      const finals = [...this.state.finals, text].slice(-30)
      while (
        finals.length > 1 &&
        finals.reduce((sum, item) => sum + item.text.length, 0) > 100000
      )
        finals.shift()
      this.publish({
        finals,
        candidate:
          this.state.candidate?.id === text.id
            ? undefined
            : this.state.candidate,
      })
    }
  }

  private audio(raw: unknown, rate: unknown) {
    if (
      !this.options.run.configuration.audio ||
      rate !== 24000 ||
      typeof raw !== 'string' ||
      raw.length > 64000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw
      )
    )
      throw new Error('invalid_translation_audio')
    const decoded = atob(raw)
    if (!decoded.length || decoded.length % 2 || decoded.length > 48000)
      throw new Error('invalid_translation_audio')
    const samples = new Int16Array(decoded.length / 2)
    for (let index = 0; index < samples.length; index++)
      samples[index] =
        decoded.charCodeAt(index * 2) | (decoded.charCodeAt(index * 2 + 1) << 8)
    try {
      this.options.audio?.(samples)
    } finally {
      samples.fill(0)
    }
  }

  private send(data: string | ArrayBuffer, audio: boolean) {
    if (
      !this.authorized() ||
      !this.ready ||
      this.socket?.readyState !== 1 ||
      this.socket.bufferedAmount > 64000 ||
      this.pending.size >= 8 ||
      (audio &&
        [...this.pending.values()].filter((item) => item.audio).length >= 4)
    )
      throw new Error('translation_backpressure')
    this.pending.set(this.sequence, { audio, at: Date.now() })
    this.socket.send(data)
  }
  private control(
    type: 'begin' | 'end' | 'finish',
    direction?: TranslationDirection
  ) {
    this.send(
      JSON.stringify({
        type,
        sequence: ++this.sequence,
        ...(direction ? { direction } : {}),
      }),
      false
    )
  }
  private attach() {
    const subscription = this.options.observe({
      pcm: (samples) => {
        const buffer = new ArrayBuffer(samples.byteLength + 4)
        try {
          if (!samples.length || samples.length > 1600 || samples.length % 16)
            throw new Error('invalid_pcm')
          const view = new DataView(buffer)
          view.setUint32(0, ++this.sequence, true)
          samples.forEach((value, index) =>
            view.setInt16(4 + index * 2, value, true)
          )
          this.send(buffer, true)
          return true
        } catch {
          this.abort()
          return false
        } finally {
          new Uint8Array(buffer).fill(0)
        }
      },
      ended: (reason) => this.drained(reason),
    })
    if (this.ended) subscription()
    else this.tap = subscription
  }

  begin(direction: TranslationDirection) {
    if (
      !this.authorized() ||
      !this.ready ||
      this.state.phase !== 'ready' ||
      this.options.run.configuration.mode !== 'push_to_talk'
    )
      return
    try {
      this.publish({ phase: 'speaking', direction })
      this.control('begin', direction)
      this.attach()
    } catch {
      this.abort()
    }
  }
  endTurn() {
    if (this.state.phase !== 'speaking' || !this.tap) return
    this.afterDrain = 'end'
    this.deadline = Date.now() + 2000
    this.publish({ phase: 'draining' })
    this.tap.finish()
  }
  finish() {
    if (this.ended || !this.ready || this.state.phase === 'finishing') return
    this.afterDrain = 'finish'
    this.deadline = Date.now() + 45000
    this.publish({ phase: 'finishing' })
    if (this.tap) this.tap.finish()
    else {
      try {
        this.control('finish')
      } catch {
        this.abort()
      }
    }
  }
  private drained(reason: TapEnd) {
    this.tap = undefined
    if (this.ended) return
    if (reason !== 'finished' || !this.afterDrain) return this.abort()
    try {
      const finishing = this.afterDrain === 'finish'
      this.afterDrain = undefined
      this.deadline = Date.now() + 45000
      if (
        this.options.run.configuration.mode === 'push_to_talk' &&
        this.state.direction
      ) {
        this.endSequence = this.sequence + 1
        if (!finishing) this.publish({ phase: 'awaiting' })
        this.control('end', this.state.direction)
      }
      if (finishing) this.control('finish')
    } catch {
      this.abort()
    }
  }
  abort() {
    this.end('incomplete')
  }
  private end(phase: 'stopped' | 'incomplete' | 'unknown') {
    if (this.ended) return
    this.ended = true
    clearInterval(this.timer)
    const tap = this.tap
    this.tap = undefined
    tap?.()
    if (this.socket) {
      this.socket.onmessage =
        this.socket.onopen =
        this.socket.onerror =
        this.socket.onclose =
          null
      try {
        this.socket.close()
      } catch {
        /* Already disconnected. */
      }
    }
    this.pending.clear()
    this.finalIds.clear()
    this.publish({
      phase,
      candidate: undefined,
      direction: undefined,
      finals: phase === 'stopped' ? this.state.finals : [],
    })
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureTranslationSocket } from './translationSocket'
import type { CapturePcmListener } from './tap'
import { run, source, ticket } from './translation.testFixtures'

class Socket {
  readyState = 1
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: Array<string | ArrayBuffer> = []
  send(value: string | ArrayBuffer) {
    this.sent.push(typeof value === 'string' ? value : value.slice(0))
  }
  close = vi.fn()
}
const clients: CaptureTranslationSocket[] = []
function fixture(manual = false, audio = false) {
  const current = run()
  current.configuration.mode = manual ? 'push_to_talk' : 'simultaneous'
  current.configuration.audio = audio
  const socket = new Socket()
  let authorized = true
  let listener: CapturePcmListener
  let tail = new Int16Array(16).fill(7)
  const observe = vi.fn((value: CapturePcmListener) => {
    listener = value
    return Object.assign(
      vi.fn(() => listener.ended('closed')),
      {
        finish: vi.fn(() => {
          if (tail.length) listener.pcm(tail)
          listener.ended('finished')
        }),
      }
    )
  })
  const changed = vi.fn()
  const sound = vi.fn()
  const factory = vi.fn(() => socket as unknown as WebSocket)
  const client = new CaptureTranslationSocket({
    source,
    run: current,
    ticket: ticket(current),
    authorized: () => authorized,
    observe,
    changed,
    audio: sound,
    socket: factory,
  })
  clients.push(client)
  const message = (value: object) =>
    socket.onmessage?.({
      data: JSON.stringify({
        run_id: current.id,
        capture_id: source.captureId,
        generation: 1,
        ...value,
      }),
    } as MessageEvent)
  client.connect()
  socket.onopen?.(new Event('open'))
  return {
    client,
    socket,
    observe,
    changed,
    sound,
    factory,
    current,
    message,
    revoke: () => {
      authorized = false
    },
    ready: () =>
      message({ type: 'ready', configuration: current.configuration }),
    pcm: () => listener.pcm(new Int16Array(1600).fill(32767)),
    emptyTail: () => {
      tail = new Int16Array(0)
    },
  }
}
describe('recording translation socket', () => {
  afterEach(() => {
    clients.splice(0).forEach((client) => client.abort())
    vi.useRealTimers()
  })
  it('authenticates in a message, then attaches only the existing microphone', () => {
    const f = fixture()
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.factory).toHaveBeenCalledExactlyOnceWith(
      'wss://gateway.invalid/capture-translation'
    )
    expect(JSON.parse(f.socket.sent[0] as string).ticket).toBe(
      'isolated-signed-ticket'
    )
    f.ready()
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.pcm()).toBe(true)
    const frame = new DataView(f.socket.sent[1] as ArrayBuffer)
    expect(frame.getUint32(0, true)).toBe(1)
    expect(frame.getInt16(4, true)).toBe(32767)
  })
  it('bounds four unacknowledged audio frames and never reconnects', () => {
    const f = fixture()
    f.ready()
    for (let i = 0; i < 4; i++) expect(f.pcm()).toBe(true)
    expect(f.pcm()).toBe(false)
    expect(f.client.state.phase).toBe('incomplete')
    expect(f.factory).toHaveBeenCalledTimes(1)
    expect(f.socket.close).toHaveBeenCalledTimes(1)
  })
  it('commits a manual turn only after its short tail and supports an empty response', () => {
    const f = fixture(true)
    f.ready()
    f.client.begin('forward')
    expect(f.observe).toHaveBeenCalledTimes(1)
    f.message({ type: 'ack', sequence: 1 })
    f.client.endTurn()
    expect(new DataView(f.socket.sent[2] as ArrayBuffer).byteLength).toBe(36)
    expect(JSON.parse(f.socket.sent[3] as string)).toEqual({
      type: 'end',
      sequence: 3,
      direction: 'forward',
    })
    expect(f.client.state.phase).toBe('awaiting')
    f.message({ type: 'ack', sequence: 2 })
    f.message({ type: 'turn_empty', direction: 'forward', sequence: 3 })
    f.message({ type: 'ack', sequence: 3 })
    expect(f.client.state.phase).toBe('ready')
    f.client.begin('reverse')
    expect(JSON.parse(f.socket.sent.at(-1) as string)).toEqual({
      type: 'begin',
      sequence: 4,
      direction: 'reverse',
    })
  })
  it('waits for backend-confirmed finish after ordered microphone tail delivery', () => {
    const f = fixture()
    f.ready()
    f.client.finish()
    expect(f.client.state.phase).toBe('finishing')
    expect(JSON.parse(f.socket.sent[2] as string)).toEqual({
      type: 'finish',
      sequence: 2,
    })
    f.message({ type: 'finished', complete: true, status: 'stopped' })
    expect(f.client.state.phase).toBe('stopped')
  })
  it('allows empty manual tail completion while finishing', () => {
    const f = fixture(true)
    f.emptyTail()
    f.ready()
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 1 })
    f.client.finish()
    f.message({ type: 'turn_empty', direction: 'forward', sequence: 2 })
    expect(f.client.state.phase).toBe('finishing')
    f.message({ type: 'finished', complete: true, status: 'stopped' })
    expect(f.client.state.phase).toBe('stopped')
  })
  it('does not unlock a later speech turn on duplicate completion', () => {
    const f = fixture(true)
    f.emptyTail()
    f.ready()
    const completed = {
      type: 'response_completed',
      direction: 'forward',
      response_id: 'old',
    }
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 1 })
    f.client.endTurn()
    f.message({ type: 'ack', sequence: 2 })
    f.message(completed)
    expect(f.client.state.phase).toBe('ready')
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 3 })
    f.client.endTurn()
    f.message({ type: 'ack', sequence: 4 })
    f.message(completed)
    expect(f.client.state.phase).toBe('awaiting')
    f.message({ ...completed, response_id: 'new' })
    expect(f.client.state.phase).toBe('ready')
  })
  it('waits for the entire 3.8 speech turn after intermediate responses', () => {
    const f = fixture(true)
    f.emptyTail()
    f.ready()
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 1 })
    f.client.endTurn()
    f.message({ type: 'ack', sequence: 2 })
    f.message({
      type: 'response_completed',
      direction: 'forward',
      response_id: 'sentence-1',
      turn_complete: false,
    })
    expect(f.client.state.phase).toBe('awaiting')
    const completed = {
      type: 'turn_completed',
      direction: 'forward',
      response_id: 'turn-1',
    }
    f.message(completed)
    expect(f.client.state.phase).toBe('ready')
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 3 })
    f.client.endTurn()
    f.message({ type: 'ack', sequence: 4 })
    f.message(completed)
    expect(f.client.state.phase).toBe('awaiting')
  })
  it('allows bounded provider drain before the queued finish acknowledgement', () => {
    vi.useFakeTimers()
    const f = fixture(true)
    f.emptyTail()
    f.ready()
    f.client.begin('forward')
    f.message({ type: 'ack', sequence: 1 })
    f.client.finish()
    f.message({ type: 'ack', sequence: 2 })
    vi.advanceTimersByTime(6000)
    expect(f.client.state.phase).toBe('finishing')
    vi.advanceTimersByTime(40000)
    expect(f.client.state.phase).toBe('unknown')
  })
  it.each(['generation', 'configuration', 'ack', 'consent'])(
    'fails closed on invalid %s',
    (kind) => {
      const f = fixture()
      if (kind === 'configuration')
        f.message({
          type: 'ready',
          configuration: { ...f.current.configuration, audio: true },
        })
      else {
        f.ready()
        if (kind === 'generation')
          f.message({
            type: 'target_final',
            generation: 2,
            direction: 'forward',
            response_id: 'r',
            item_id: 'i',
            text: 'private',
          })
        if (kind === 'ack') f.message({ type: 'ack', sequence: 1 })
        if (kind === 'consent')
          f.message({
            type: 'audio',
            direction: 'forward',
            response_id: 'r',
            item_id: 'i',
            audio: 'AQABAA==',
            sample_rate: 24000,
          })
      }
      expect(f.client.state.phase).toBe('incomplete')
      expect(f.sound).not.toHaveBeenCalled()
    }
  )
  it('erases output PCM after a synchronous playback copy', () => {
    const f = fixture(false, true)
    f.ready()
    f.message({
      type: 'audio',
      direction: 'forward',
      response_id: 'r',
      item_id: 'i',
      audio: 'AQABAA==',
      sample_rate: 24000,
    })
    expect(f.sound).toHaveBeenCalledTimes(1)
    expect([...f.sound.mock.calls[0][0]]).toEqual([0, 0])
  })
  it('clears private candidates and finals on authority loss without a new microphone', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.ready()
    f.message({
      type: 'target_final',
      direction: 'forward',
      response_id: 'r',
      item_id: 'i',
      text: 'private',
    })
    expect(f.client.state.finals).toHaveLength(1)
    f.revoke()
    vi.advanceTimersByTime(201)
    expect(f.client.state.phase).toBe('incomplete')
    expect(f.client.state.finals).toEqual([])
    expect(f.observe).toHaveBeenCalledTimes(1)
  })
  it('times out missing acknowledgements with an unknown outcome', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.ready()
    f.pcm()
    vi.advanceTimersByTime(5200)
    expect(f.client.state.phase).toBe('unknown')
    expect(f.factory).toHaveBeenCalledTimes(1)
  })
})

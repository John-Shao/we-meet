import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_FRAMES, PcmFramer } from './pcm'
import {
  CapturePcmReceiver,
  CapturePcmTap,
  TAP_FRAMES,
  TAP_PENDING_LIMIT,
  type TapEvent,
} from './tap'

describe('isolated live PCM tap', () => {
  it('flushes a speech tail and starts another turn without stopping original PCM', () => {
    const events: TapEvent[] = []
    const originals: Int16Array[] = []
    const original = new PcmFramer((pcm) => originals.push(pcm))
    const tap = new CapturePcmTap((event) => events.push(event))
    const push = (count: number, value: number) => {
      const input = new Float32Array(count).fill(value)
      original.push(input)
      tap.push(input)
    }
    tap.start('first')
    push(533, 1)
    tap.drain('first')
    tap.drain('first')
    expect(events.map((event) => event.kind)).toEqual(['tap_pcm', 'tap_end'])
    expect(events[0].kind === 'tap_pcm' && events[0].pcm.length).toBe(528)
    expect(events[1]).toEqual({
      kind: 'tap_end',
      generation: 'first',
      reason: 'finished',
    })
    push(1000, -1)
    tap.start('second')
    tap.drain('first')
    push(1600, 0.5)
    tap.drain('second')
    const second = events[2]
    expect(
      second.kind === 'tap_pcm' &&
        second.pcm.every((sample) => sample === 16384)
    ).toBe(true)
    push(CHUNK_FRAMES - 3133, 0)
    expect(originals).toHaveLength(1)
    expect(originals[0][532]).toBe(32767)
    expect(originals[0][533]).toBe(-32768)
  })

  it('only captures the explicitly enabled interval in 100 ms copies', () => {
    const events: TapEvent[] = []
    const tap = new CapturePcmTap((event) => events.push(event))
    tap.push(new Float32Array(800).fill(-1))
    tap.start('one')
    tap.push(new Float32Array(800).fill(1))
    expect(events).toHaveLength(0)
    tap.push(new Float32Array(800).fill(0.5))
    const event = events[0]
    expect(event.kind).toBe('tap_pcm')
    if (event.kind === 'tap_pcm') {
      expect(event.pcm.length).toBe(TAP_FRAMES)
      expect(
        [...event.pcm.slice(0, 800)].every((sample) => sample === 32767)
      ).toBe(true)
      expect(event.pcm[800]).toBe(16384)
    }
  })

  it('bounds unacknowledged data and leaves every original sample intact', () => {
    const events: TapEvent[] = []
    const originals: Int16Array[] = []
    const tap = new CapturePcmTap((event) => events.push(event))
    const original = new PcmFramer((pcm) => originals.push(pcm))
    tap.start('one')
    for (let i = 0; i < CHUNK_FRAMES / 128; i++) {
      const samples = new Float32Array(128).fill(0.5)
      original.push(samples)
      tap.push(samples)
    }
    expect(events.filter((event) => event.kind === 'tap_pcm')).toHaveLength(
      TAP_PENDING_LIMIT
    )
    expect(events.at(-1)).toEqual({
      kind: 'tap_end',
      generation: 'one',
      reason: 'backpressure',
    })
    expect(originals).toHaveLength(1)
    expect(originals[0].length).toBe(CHUNK_FRAMES)
    expect([...originals[0]].every((sample) => sample === 16384)).toBe(true)
  })

  it('only an exact generation acknowledgement releases a pending frame', () => {
    const events: TapEvent[] = []
    const tap = new CapturePcmTap((event) => events.push(event))
    tap.start('one')
    for (let i = 1; i <= 20; i++) {
      tap.push(new Float32Array(TAP_FRAMES))
      tap.acknowledge('one', i)
    }
    expect(events).toHaveLength(20)
    tap.start('two')
    tap.push(new Float32Array(TAP_FRAMES * TAP_PENDING_LIMIT))
    tap.acknowledge('one', 1)
    tap.push(new Float32Array(TAP_FRAMES))
    expect(events.at(-1)).toEqual({
      kind: 'tap_end',
      generation: 'two',
      reason: 'backpressure',
    })
  })

  it('delivers the whole-millisecond pause tail before the end marker', () => {
    const events: TapEvent[] = []
    const tap = new CapturePcmTap((event) => events.push(event))
    tap.start('one')
    tap.push(new Float32Array(128).fill(-1))
    tap.finish()
    expect(events.map((event) => event.kind)).toEqual(['tap_pcm', 'tap_end'])
    const first = events[0]
    if (first.kind === 'tap_pcm')
      expect([...first.pcm]).toEqual(Array(128).fill(-32768))
    tap.push(new Float32Array(TAP_FRAMES))
    expect(events).toHaveLength(2)
  })

  it('clears stopped partial audio and ignores an old detach', () => {
    const events: TapEvent[] = []
    const tap = new CapturePcmTap((event) => events.push(event))
    tap.start('one')
    tap.push(new Float32Array(800).fill(-1))
    tap.start('two')
    tap.stop('one')
    tap.push(new Float32Array(TAP_FRAMES).fill(1))
    const current = events.at(-1)
    expect(current?.kind).toBe('tap_pcm')
    if (current?.kind === 'tap_pcm')
      expect([...current.pcm].every((sample) => sample === 32767)).toBe(true)
    tap.close()
    tap.finish()
    expect(events.filter((event) => event.kind === 'tap_end')).toHaveLength(2)
  })

  it('consumer exceptions cannot escape into the recording worklet', () => {
    const tap = new CapturePcmTap(() => {
      throw new Error('closed port')
    })
    expect(() => {
      tap.start('one')
      tap.push(new Float32Array(TAP_FRAMES * 10))
      tap.finish()
    }).not.toThrow()
  })
})

describe('main-thread PCM receiver', () => {
  it('requests one tail drain, waits for its end and cannot drain a replacement', () => {
    const send = vi.fn()
    const ended = vi.fn()
    const receiver = new CapturePcmReceiver(send)
    const first = receiver.attach('one', { pcm: () => true, ended })
    first.finish()
    first.finish()
    expect(
      send.mock.calls.filter(([message]) => message.kind === 'tap_finish')
    ).toEqual([[{ kind: 'tap_finish', generation: 'one' }]])
    expect(ended).not.toHaveBeenCalled()
    receiver.receive({ kind: 'tap_end', generation: 'one', reason: 'finished' })
    expect(ended).toHaveBeenCalledExactlyOnceWith('finished')
    const next = vi.fn()
    receiver.attach('two', { pcm: () => true, ended: next })
    first.finish()
    first()
    expect(next).not.toHaveBeenCalled()
  })

  const frame = (generation = 'one', sequence = 1): TapEvent => ({
    kind: 'tap_pcm',
    generation,
    sequence,
    pcm: new Int16Array(TAP_FRAMES).fill(12),
  })
  it('zeroes delivered buffers after a synchronous copy and acknowledges ordering', () => {
    const send = vi.fn()
    const receiver = new CapturePcmReceiver(send)
    let copy: Int16Array | undefined
    receiver.attach('one', {
      pcm: (samples) => {
        copy = samples.slice()
        return true
      },
      ended: vi.fn(),
    })
    const input = frame()
    receiver.receive(input)
    expect(copy?.[0]).toBe(12)
    if (input.kind === 'tap_pcm')
      expect([...input.pcm].every((value) => value === 0)).toBe(true)
    expect(send).toHaveBeenLastCalledWith({
      kind: 'tap_ack',
      generation: 'one',
      sequence: 1,
    })
  })

  it('drops and erases old-generation frames without ending a replacement', () => {
    const first = { pcm: vi.fn(() => true), ended: vi.fn() }
    const second = { pcm: vi.fn(() => true), ended: vi.fn() }
    const receiver = new CapturePcmReceiver(vi.fn())
    const detach = receiver.attach('one', first)
    receiver.attach('two', second)
    detach()
    const stale = frame()
    receiver.receive(stale)
    receiver.receive({ kind: 'tap_end', generation: 'one', reason: 'paused' })
    receiver.receive(frame('two'))
    expect(first.pcm).not.toHaveBeenCalled()
    expect(second.pcm).toHaveBeenCalledOnce()
    expect(second.ended).not.toHaveBeenCalled()
    if (stale.kind === 'tap_pcm') expect(stale.pcm[0]).toBe(0)
  })

  it.each(['overflow', 'exception', 'gap'] as const)(
    'closes only the tap on %s',
    (failure) => {
      const listener = {
        pcm: vi.fn(() => {
          if (failure === 'exception') throw new Error('sink failed')
          return false
        }),
        ended: vi.fn(),
      }
      const receiver = new CapturePcmReceiver(vi.fn())
      receiver.attach('one', listener)
      expect(() =>
        receiver.receive(frame('one', failure === 'gap' ? 2 : 1))
      ).not.toThrow()
      expect(listener.ended).toHaveBeenCalledExactlyOnceWith('backpressure')
      receiver.receive(frame('one', 3))
      receiver.close()
      expect(listener.ended).toHaveBeenCalledOnce()
    }
  )

  it('does not close a new listener if the prior listener replaces itself and throws', () => {
    const receiver = new CapturePcmReceiver(vi.fn())
    const second = { pcm: vi.fn(() => true), ended: vi.fn() }
    receiver.attach('one', {
      pcm: () => {
        receiver.attach('two', second)
        throw new Error('old failure')
      },
      ended: vi.fn(),
    })
    receiver.receive(frame())
    receiver.receive(frame('two'))
    expect(second.pcm).toHaveBeenCalledOnce()
    expect(second.ended).not.toHaveBeenCalled()
  })
})

describe('real worklet message paths', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('continues the original five-second recording after tap overflow', async () => {
    const events: Array<{ kind: string; pcm?: Int16Array }> = []
    let Processor: new () => {
      port: { onmessage: (event: { data: object }) => void }
      process: (input: Float32Array[][]) => boolean
    }
    vi.stubGlobal(
      'AudioWorkletProcessor',
      class {
        port = {
          onmessage: () => {},
          postMessage: (data: { kind: string; pcm?: Int16Array }) =>
            events.push(data),
        }
      }
    )
    vi.stubGlobal(
      'registerProcessor',
      (_name: string, constructor: typeof Processor) => {
        Processor = constructor
      }
    )
    vi.stubGlobal('sampleRate', 16000)
    await import('./capture.worklet')
    const processor = new Processor!()
    processor.port.onmessage({ data: { kind: 'start' } })
    processor.port.onmessage({ data: { kind: 'tap_start', generation: 'one' } })
    for (let i = 0; i < CHUNK_FRAMES / 128; i++)
      expect(processor.process([[new Float32Array(128).fill(0.5)]])).toBe(true)
    expect(events.filter((event) => event.kind === 'tap_end')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'failed')).toHaveLength(0)
    expect(events.find((event) => event.kind === 'pcm')?.pcm?.length).toBe(
      CHUNK_FRAMES
    )
  })
})

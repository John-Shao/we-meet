import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationPlayback } from './translationPlayback'

type Node = {
  buffer: unknown
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}
class Context {
  static last: Context
  state = 'running'
  currentTime = 0
  destination = {}
  buffers: Float32Array[] = []
  nodes: Node[] = []
  constructor() {
    Context.last = this
  }
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  createBuffer(_channels: number, length: number, rate: number) {
    expect(rate).toBe(24000)
    const samples = new Float32Array(length)
    this.buffers.push(samples)
    return { getChannelData: () => samples }
  }
  createBufferSource(): Node {
    const node = {
      buffer: null as unknown,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    }
    this.nodes.push(node)
    return node
  }
}
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  vi.stubGlobal('AudioContext', Context)
  const player = new TranslationPlayback()
  return { player, context: Context.last }
}
describe('Transient translation playback', () => {
  it('copies PCM before caller erasure and zeroes completed output', async () => {
    const { player, context } = fixture()
    await player.unlock()
    const input = new Int16Array(2400).fill(16384)
    player.play(input)
    input.fill(0)
    expect(context.buffers[0][0]).toBe(0.5)
    context.nodes[0].onended!()
    expect(context.buffers[0].every((value) => value === 0)).toBe(true)
    player.close()
  })
  it('limits queued audio to three seconds without reconnect or replay', () => {
    const { player, context } = fixture()
    for (let i = 0; i < 3; i++) player.play(new Int16Array(24000))
    expect(() => player.play(new Int16Array(24))).toThrow('backpressure')
    expect(context.nodes).toHaveLength(3)
    player.close()
    expect(
      context.nodes.every((node) => node.stop.mock.calls.length === 1)
    ).toBe(true)
  })
  it('mute clears queued speech, drops incoming output and resumes only future audio', () => {
    const { player, context } = fixture()
    player.play(new Int16Array(24000).fill(200))
    player.mute(true)
    player.play(new Int16Array(24000))
    expect(context.nodes).toHaveLength(1)
    expect(context.buffers[0].every((value) => value === 0)).toBe(true)
    player.mute(false)
    player.play(new Int16Array(24))
    expect(context.nodes[1].start).toHaveBeenCalledWith(0)
    player.close()
  })
  it('fails on suspended output and clears resources exactly once', () => {
    const { player, context } = fixture()
    context.state = 'suspended'
    expect(() => player.play(new Int16Array(24))).toThrow('backpressure')
    player.close()
    player.close()
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(() => player.play(new Int16Array(24))).toThrow('closed')
  })
})

/** Copies transient 24 kHz PCM into a bounded output-only graph. Never feeds capture. */
export class TranslationPlayback {
  private context: AudioContext
  private nodes = new Map<AudioBufferSourceNode, AudioBuffer>()
  private until = 0
  private closed = false
  private muted = false

  constructor() {
    this.context = new AudioContext({ sampleRate: 24000 })
  }

  async unlock() {
    await this.context.resume()
    if (this.closed || this.context.state !== 'running')
      throw new Error('translation_playback_unavailable')
  }

  play(samples: Int16Array) {
    if (this.closed) throw new Error('translation_playback_closed')
    if (this.muted) return
    const start = Math.max(this.until, this.context.currentTime)
    const duration = samples.length / 24000
    if (
      this.context.state !== 'running' ||
      !samples.length ||
      duration > 1 ||
      start + duration - this.context.currentTime > 3 ||
      this.nodes.size >= 32
    )
      throw new Error('translation_playback_backpressure')
    const buffer = this.context.createBuffer(1, samples.length, 24000)
    const channel = buffer.getChannelData(0)
    samples.forEach((value, index) => {
      channel[index] = value / 32768
    })
    const node = this.context.createBufferSource()
    node.buffer = buffer
    node.connect(this.context.destination)
    this.nodes.set(node, buffer)
    node.onended = () => {
      channel.fill(0)
      this.nodes.delete(node)
      node.disconnect()
    }
    node.start(start)
    this.until = start + duration
  }

  mute(value: boolean) {
    this.muted = value
    if (value) this.clear()
  }

  private clear() {
    this.nodes.forEach((buffer, node) => {
      node.onended = null
      try {
        node.stop()
      } catch {
        /* Already stopped. */
      }
      node.disconnect()
      buffer.getChannelData(0).fill(0)
    })
    this.nodes.clear()
    this.until = 0
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clear()
    void this.context.close().catch(() => undefined)
  }
}

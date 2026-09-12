import { describe, expect, it, vi } from 'vitest'
import type {
  ApiCaptureSession,
  CaptureCommand,
} from '../api/ApiCaptureSession'
import type { LocalAudioChunk, LocalCapture } from './journal'
import { RecordingController } from './controller'
import type { CaptureTransport } from './transport'

function fixture() {
  let local: LocalCapture | undefined
  const chunks: LocalAudioChunk[] = []
  const journal = {
    list: vi.fn(async () => (local ? [structuredClone(local)] : [])),
    create: vi.fn(async (title: string) => {
      local = {
        id: 'local',
        createdAt: '2026-09-13',
        createKey: 'stable-create',
        create: {
          title,
          device_id: 'device',
          lease_key: 'lease',
          retention_mode: 'media',
        },
        nextSequence: 1,
        pendingBytes: 0,
        durationMs: 0,
        closed: false,
        sealed: false,
      }
      return structuredClone(local)
    }),
    update: vi.fn(
      async (_id: string, change: (value: LocalCapture) => LocalCapture) => {
        local = change(structuredClone(local!))
        return structuredClone(local)
      }
    ),
    append: vi.fn(async (_id: string, pcm: Int16Array) => {
      const chunk = {
        captureId: 'local',
        sequence: local!.nextSequence++,
        start_ms: local!.durationMs,
        duration_ms: pcm.length / 16,
        checksum: 'verified',
        byte_size: pcm.byteLength,
        audio: new ArrayBuffer(pcm.byteLength),
      }
      local!.durationMs += chunk.duration_ms
      local!.pendingBytes += chunk.byte_size
      chunks.push(chunk)
      return chunk
    }),
    chunks: vi.fn(async () => structuredClone(chunks)),
    acknowledge: vi.fn(async (_id, receipt) => {
      const chunk = chunks.find((row) => row.sequence === receipt.sequence)!
      if (chunk.audio) local!.pendingBytes -= chunk.byte_size
      chunk.audio = undefined
      chunk.receipt = receipt
    }),
  }
  let remote: ApiCaptureSession = {
    id: 'remote',
    record_id: 'record',
    device_id: 'device',
    status: 'preparing',
    revision: 1,
    started_at: '2026-09-13',
    ended_at: null,
    media_status: 'not_connected',
    captured_duration_ms: null,
    last_acked_sequence: 0,
    missing_ranges: null,
    coverage_status: 'unverified',
  }
  const effects: CaptureCommand[] = []
  const receipts = new Map<string, ApiCaptureSession>()
  const transport: CaptureTransport = {
    create: vi.fn(async () => ({
      operation_id: 'create',
      replayed: false,
      capture: { ...remote },
      result: { ...remote },
    })),
    read: vi.fn(async () => ({ ...remote })),
    receipts: vi.fn(async () => ({ results: [], next_after_sequence: null })),
    command: vi.fn(async (capture: LocalCapture) => {
      const intent = capture.command!
      if (!receipts.has(intent.key)) {
        effects.push(intent.body.command)
        const statuses = {
          start: 'recording',
          resume: 'recording',
          pause: 'paused',
          interrupt: 'interrupted',
          stop: 'stopping',
          finalize: 'stopped',
        } as const
        remote = {
          ...remote,
          status: statuses[intent.body.command],
          revision: remote.revision + 1,
        }
        receipts.set(intent.key, { ...remote })
      }
      return {
        operation_id: intent.key,
        replayed: false,
        capture: { ...remote },
        result: receipts.get(intent.key)!,
      }
    }),
    upload: vi.fn(async (_capture, chunk) => ({
      id: 'chunk',
      sequence: chunk.sequence,
      start_ms: chunk.start_ms,
      duration_ms: chunk.duration_ms,
      checksum: chunk.checksum,
      byte_size: chunk.byte_size,
      stored: true,
    })),
    seal: vi.fn(async (capture) => ({
      final_sequence: capture.nextSequence - 1,
      outcome: 'saved' as const,
      duration_ms: capture.durationMs,
      missing_sequences: [],
      gaps: [],
      coverage_status: 'unverified' as const,
    })),
  }
  let sink: (pcm: Int16Array) => Promise<void>
  const mic = {
    start: vi.fn(),
    pause: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    close: vi.fn(),
  }
  const open = vi.fn(async (onPcm: typeof sink) => {
    sink = onPcm
    return mic
  })
  const controller = new RecordingController(journal, transport, vi.fn(), open)
  return {
    controller,
    journal,
    transport,
    mic,
    open,
    effects,
    emit: () => sink(new Int16Array(16000)),
    local: () => local!,
    remote: () => remote,
  }
}

describe('recording lifecycle and durable retries', () => {
  it('opens the microphone only on user start and seals after acknowledged upload', async () => {
    const f = fixture()
    await f.controller.load()
    expect(f.open).not.toHaveBeenCalled()
    await f.controller.start('Interview')
    await f.emit()
    await f.controller.finish()
    expect(f.local().pendingBytes).toBe(0)
    expect(f.local().sealed).toBe(true)
    expect(f.effects).toEqual(['start', 'stop', 'finalize'])
    expect(f.transport.upload).toHaveBeenCalledTimes(1)
    expect(f.transport.seal).toHaveBeenCalledWith(
      expect.objectContaining({
        closed: true,
        sealIntent: { final_sequence: 1, client_interrupted: false },
      })
    )
    expect(f.mic.stop).toHaveBeenCalledTimes(1)
  })

  it('retains an unknown command key across recovery and never repeats its server effect', async () => {
    const f = fixture()
    const original = f.transport.command
    f.transport.command = vi.fn(async (capture) => {
      const result = await original(capture)
      if (capture.command!.body.command === 'start')
        throw new Error('lost response')
      return result
    })
    await f.controller.start('Interview')
    const originalKey = f.local().command!.key
    expect(f.mic.start).not.toHaveBeenCalled()
    f.transport.command = original
    const recovered = new RecordingController(
      f.journal,
      f.transport,
      vi.fn(),
      f.open
    )
    await recovered.load()
    expect(f.local().interrupted).toBe(true)
    await recovered.start('Ignored title')
    expect(original).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ key: originalKey }),
      })
    )
    expect(f.effects).toEqual(['start', 'interrupt', 'resume'])
    expect(f.transport.create).toHaveBeenCalledTimes(1)
    expect(f.local().command).toBeUndefined()
  })

  it('does not finalize after upload failure unless the user explicitly accepts missing chunks', async () => {
    const f = fixture()
    f.transport.upload = vi.fn(async () => {
      throw new Error('offline')
    })
    await f.controller.start('Interview')
    await f.emit()
    await f.controller.finish()
    expect(f.local().pendingBytes).toBeGreaterThan(0)
    expect(f.local().sealed).toBe(false)
    expect(f.transport.seal).not.toHaveBeenCalled()
    await f.controller.finish(true)
    expect(f.local().sealed).toBe(true)
    expect(f.local().pendingBytes).toBeGreaterThan(0)
    expect(f.transport.seal).toHaveBeenCalledTimes(1)
  })

  it('reconciles saved receipts before re-uploading after a lost acknowledgement', async () => {
    const f = fixture()
    f.transport.upload = vi.fn(async () => {
      throw new Error('lost response')
    })
    await f.controller.start('Interview')
    await f.emit()
    await f.controller.retryUploads()
    const chunk = (await f.journal.chunks())[0]
    f.transport.receipts = vi.fn(async () => ({
      results: [{ ...chunk, id: 'saved', stored: true }],
      next_after_sequence: null,
    }))
    const attempts = vi.mocked(f.transport.upload).mock.calls.length
    await f.controller.finish()
    expect(f.local().sealed).toBe(true)
    expect(f.local().pendingBytes).toBe(0)
    expect(f.transport.upload).toHaveBeenCalledTimes(attempts)
  })

  it('closes a late microphone permission result after leaving the page', async () => {
    const f = fixture()
    let resolve!: (value: typeof f.mic) => void
    const controller = new RecordingController(
      f.journal,
      f.transport,
      vi.fn(),
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const starting = controller.start('Interview')
    controller.dispose()
    resolve(f.mic)
    await starting
    expect(f.mic.close).toHaveBeenCalled()
    expect(f.transport.create).not.toHaveBeenCalled()
  })
})

import { ApiError } from '@/api/ApiError'
import type { CaptureCommand } from '../api/ApiCaptureSession'
import { CaptureJournal, type LocalCapture } from './journal'
import { CaptureMicrophone } from './microphone'
import type { CaptureTransport } from './transport'

export interface CaptureViewState {
  local?: LocalCapture
  history: LocalCapture[]
  mode: 'ready' | 'recording' | 'paused' | 'recoverable' | 'saved'
  busy: boolean
  error?: 'operationFailed' | 'microphoneFailed' | 'uploadFailed'
}

type Microphone = Pick<CaptureMicrophone, 'start' | 'pause' | 'stop' | 'close'>
type OpenMicrophone = (
  sink: (pcm: Int16Array) => Promise<void>,
  failed: () => void
) => Promise<Microphone>

/** Single-tab controller. Durable command keys survive every uncertain network response. */
export class RecordingController {
  state: CaptureViewState = { history: [], mode: 'ready', busy: false }
  private microphone?: Microphone
  private uploading?: Promise<void>
  private disposed = false

  constructor(
    private journal: Pick<
      CaptureJournal,
      'update' | 'list' | 'create' | 'append' | 'chunks' | 'acknowledge'
    >,
    private transport: CaptureTransport,
    private changed: (state: CaptureViewState) => void,
    private openMicrophone: OpenMicrophone = CaptureMicrophone.open
  ) {}

  private publish(patch: Partial<CaptureViewState> = {}) {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.changed(this.state)
  }

  private async update(change: (local: LocalCapture) => LocalCapture) {
    const local = await this.journal.update(this.state.local!.id, change)
    this.publish({ local })
    return local
  }

  async load(id?: string) {
    const history = (await this.journal.list()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    const local =
      history.find((row) => (id ? row.id === id : !row.sealed)) ?? history[0]
    this.publish({
      history,
      local,
      mode: local ? (local.sealed ? 'saved' : 'recoverable') : 'ready',
    })
    if (local && !local.closed && !local.sealed)
      await this.update((current) => ({
        ...current,
        interrupted: true,
        closed: true,
      }))
  }

  private async operation(run: () => Promise<void>) {
    if (this.state.busy || this.disposed) return
    this.publish({ busy: true, error: undefined })
    try {
      await run()
    } catch {
      this.publish({ error: this.state.error ?? 'operationFailed' })
    } finally {
      this.publish({ busy: false })
    }
  }

  private async remote() {
    if (this.disposed) throw new Error('disposed')
    if (!this.state.local!.remote) {
      const response = await this.transport.create(this.state.local!)
      await this.update((local) => ({ ...local, remote: response.capture }))
    }
    if (this.state.local!.command) await this.pendingCommand()
    const remote = await this.transport.read(this.state.local!)
    await this.update((local) => ({ ...local, remote }))
    const chunks = await this.journal.chunks(this.state.local!.id)
    const pending = new Set(
      chunks.filter((chunk) => chunk.audio).map((chunk) => chunk.sequence)
    )
    if (pending.size) {
      let after = 0
      for (let page = 0; page < 44; page++) {
        const receipts = await this.transport.receipts(this.state.local!, after)
        for (const receipt of receipts.results) {
          if (receipt.stored && pending.has(receipt.sequence))
            await this.journal.acknowledge(this.state.local!.id, receipt)
        }
        if (receipts.next_after_sequence === null) break
        if (receipts.next_after_sequence <= after)
          throw new Error('invalid_audio_cursor')
        after = receipts.next_after_sequence
      }
      await this.update((local) => local)
    }
  }

  private async pendingCommand() {
    if (this.disposed) throw new Error('disposed')
    try {
      const response = await this.transport.command(this.state.local!)
      await this.update((local) => ({
        ...local,
        remote: response.capture,
        command: undefined,
      }))
    } catch (error) {
      // A rejected CAS did not execute. Unknown results retain the exact key and body.
      if (error instanceof ApiError && error.statusCode === 409)
        await this.update((local) => ({ ...local, command: undefined }))
      throw error
    }
  }

  private async command(command: CaptureCommand) {
    if (this.state.local!.command) await this.pendingCommand()
    await this.update((local) => ({
      ...local,
      command: {
        key: crypto.randomUUID(),
        body: {
          command,
          device_id: local.create.device_id,
          expected_revision: local.remote!.revision,
        },
      },
    }))
    await this.pendingCommand()
  }

  async start(title: string) {
    await this.operation(async () => {
      try {
        this.microphone = await this.openMicrophone(
          async (pcm) => {
            if (this.disposed || !this.state.local) throw new Error('disposed')
            await this.journal.append(this.state.local.id, pcm)
            // Read the committed counters without overwriting a concurrent control operation.
            await this.update((local) => local)
            void this.upload().catch(() =>
              this.publish({ error: 'uploadFailed' })
            )
          },
          () => {
            this.microphone = undefined
            this.publish({ mode: 'recoverable', error: 'microphoneFailed' })
            if (this.state.local)
              void this.update((local) => ({
                ...local,
                interrupted: true,
              })).catch(() => undefined)
          }
        )
        if (this.disposed) throw new Error('disposed')
        if (!this.state.local || this.state.local.sealed) {
          const local = await this.journal.create(title)
          this.publish({ local })
        }
        await this.remote()
        if (this.state.local!.remote!.status === 'recording')
          await this.command('interrupt')
        const status = this.state.local!.remote!.status
        if (
          status !== 'preparing' &&
          status !== 'paused' &&
          status !== 'interrupted'
        )
          throw new Error('capture_ended')
        await this.command(status === 'preparing' ? 'start' : 'resume')
        await this.update((local) => ({ ...local, closed: false }))
        this.microphone!.start()
        this.publish({ mode: 'recording' })
      } catch (error) {
        this.microphone?.close()
        this.microphone = undefined
        this.publish({ mode: 'recoverable' })
        throw error
      }
    })
  }

  async pause() {
    await this.operation(async () => {
      try {
        await this.microphone?.stop()
      } finally {
        this.microphone = undefined
      }
      // Stopping the hardware also releases the browser's microphone indicator while paused.
      this.publish({ mode: 'paused' })
      await this.update((local) => ({ ...local, closed: true }))
      await this.remote()
      if (this.state.local!.remote!.status === 'recording')
        await this.command('pause')
    })
  }

  private upload(): Promise<void> {
    if (this.uploading) return this.uploading
    this.uploading = (async () => {
      if (this.disposed || !this.state.local?.remote || this.state.local.sealed)
        return
      // Snapshot one bounded batch; new live chunks trigger the next pass.
      const id = this.state.local.id
      for (const chunk of await this.journal.chunks(id)) {
        if (!chunk.audio) continue
        if (this.disposed) throw new Error('disposed')
        const receipt = await this.transport.upload(this.state.local!, chunk)
        await this.journal.acknowledge(id, receipt)
        await this.update((local) => local)
      }
    })().finally(() => {
      this.uploading = undefined
    })
    return this.uploading
  }

  async retryUploads() {
    await this.operation(async () => {
      await this.remote()
      await this.upload()
      await this.update((local) => local)
    })
  }

  async finish(allowMissing = false) {
    await this.operation(async () => {
      try {
        await this.microphone?.stop()
      } finally {
        this.microphone = undefined
      }
      this.publish({ mode: 'recoverable' })
      await this.update((local) => ({ ...local, closed: true }))
      await this.remote()
      const status = this.state.local!.remote!.status
      if (status !== 'stopping' && status !== 'stopped')
        await this.command('stop')
      // Let an in-flight upload finish before sealing. Failed writes remain locally recoverable.
      if (allowMissing) await this.uploading?.catch(() => undefined)
      else {
        await this.upload()
        // A last worklet tail may have arrived while an earlier upload snapshot was running.
        if (this.state.local!.pendingBytes) await this.upload()
        if (this.state.local!.pendingBytes) throw new Error('pending_audio')
      }
      await this.update((local) => ({
        ...local,
        sealIntent: local.sealIntent ?? {
          final_sequence: local.nextSequence - 1,
          client_interrupted: !!local.interrupted,
        },
      }))
      await this.transport.seal(this.state.local!)
      if (this.state.local!.remote!.status !== 'stopped')
        await this.command('finalize')
      await this.update((local) => ({ ...local, sealed: true }))
      this.publish({ mode: 'saved' })
      await this.load(this.state.local!.id)
    })
  }

  async localAudio() {
    return (await this.journal.chunks(this.state.local!.id)).filter(
      (chunk) => chunk.audio
    )
  }

  dispose() {
    this.disposed = true
    this.microphone?.close()
    this.microphone = undefined
  }
}

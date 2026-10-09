import { assertAuthSession } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import {
  VoiceprintClient,
  errorKey,
  type Deletion,
  type Enrollment,
  type Permission,
  type Sample,
  type Settings,
} from './api'
import { validateWav, VoiceprintRecorder } from './recording'

export type VoiceprintState = {
  loading: boolean
  busy: boolean
  conflict: boolean
  error?: string
  settings?: Settings
  samples: Sample[]
  nextOffset: number | null
  deletions: Deletion[]
  deletionOffset: number | null
  enrollment?: Enrollment
  clip?: Blob
  clipUrl?: string
  preview?: {
    id: string
    url: string
    expiresAt: number
    listened: boolean
    selfConfirmed: boolean
  }
  phase: 'idle' | 'requesting' | 'recording' | 'preparing'
  elapsed: number
  deleteTarget?: string
}
const empty = (): VoiceprintState => ({
  loading: true,
  busy: false,
  conflict: false,
  samples: [],
  nextOffset: null,
  deletions: [],
  deletionOffset: null,
  phase: 'idle',
  elapsed: 0,
})

/** Ephemeral private state. No query cache, localStorage, or background capture. */
export class VoiceprintController {
  private state = empty()
  private listeners = new Set<() => void>()
  private lifetime = new AbortController()
  private dead = false
  private refreshing = 0
  private loadingSequence?: number
  private firstPageIds = new Set<string>()
  private recorder?: VoiceprintRecorder
  private recordStarted = 0
  private beginKey?: { key: string; version: number; locale: string }
  private uploadAttempt?: {
    id: string
    slot: number
    clip: Blob
    enrollment: Enrollment
  }
  private removal?: { id: string; key: string; version: number }
  constructor(readonly client: VoiceprintClient) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(patch: Partial<VoiceprintState>) {
    if (this.dead) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  private valid() {
    if (this.dead) return false
    try {
      assertAuthSession(this.client.auth)
      return true
    } catch {
      this.dispose()
      return false
    }
  }
  private clearMedia() {
    this.recorder?.cancel()
    this.recorder = undefined
    if (this.state.clipUrl) URL.revokeObjectURL(this.state.clipUrl)
    if (this.state.preview) URL.revokeObjectURL(this.state.preview.url)
    this.uploadAttempt = undefined
    this.publish({
      clip: undefined,
      clipUrl: undefined,
      preview: undefined,
      phase: 'idle',
      elapsed: 0,
    })
  }
  dispose() {
    if (this.dead) return
    this.lifetime.abort()
    this.clearMedia()
    this.dead = true
    this.state = { ...empty(), loading: false, error: 'unavailable' }
    this.listeners.forEach((listener) => listener())
    this.listeners.clear()
  }
  tick() {
    if (!this.valid()) return
    if (this.state.phase === 'recording')
      this.publish({
        elapsed: Math.min(
          10,
          Math.floor((Date.now() - this.recordStarted) / 1000)
        ),
      })
    if (
      this.state.enrollment &&
      Date.parse(this.state.enrollment.expires_at) <= Date.now()
    ) {
      this.clearMedia()
      this.publish({ enrollment: undefined })
      this.beginKey = undefined
    }
    if (this.state.preview && this.state.preview.expiresAt <= Date.now()) {
      URL.revokeObjectURL(this.state.preview.url)
      this.publish({ preview: undefined })
    }
  }
  private fail(error: unknown) {
    if (!this.valid()) return
    if (this.state.preview) {
      URL.revokeObjectURL(this.state.preview.url)
      this.publish({ preview: undefined })
    }
    const code = errorKey(error)
    if (
      code === 'conflict' ||
      code === 'unavailable' ||
      (error instanceof Error &&
        error.message === 'voiceprint_response_invalid')
    ) {
      this.clearMedia()
      this.publish({ enrollment: undefined, conflict: true })
    }
    this.publish({ error: code, loading: false })
  }
  async refresh(manual = false, force = false) {
    if (this.loadingSequence !== undefined && !manual && !force) return
    if (
      !this.valid() ||
      (this.state.busy && this.state.phase === 'idle' && !force) ||
      (this.state.conflict && !manual)
    )
      return
    const sequence = ++this.refreshing
    this.loadingSequence = sequence
    if (manual) {
      this.clearMedia()
      this.beginKey = undefined
      this.removal = undefined
      this.publish({ conflict: false, error: undefined, enrollment: undefined })
    }
    try {
      const settings = await this.client.settings(this.lifetime.signal)
      const [samples, deletions] = await Promise.all([
        this.client.samples(0, this.lifetime.signal),
        this.client.deletions(0, this.lifetime.signal),
      ])
      if (!this.valid() || sequence !== this.refreshing) return
      const profiles = new Set(
        settings.profiles
          .filter(
            (p) =>
              p.status !== 'deleted' && p.generation === settings.generation
          )
          .map((p) => p.id)
      )
      if (samples.results.some((row) => !profiles.has(row.profile_id)))
        throw new Error('voiceprint_response_invalid')
      const changed = !!(
        this.state.settings &&
        (this.state.settings.version !== settings.version ||
          this.state.settings.generation !== settings.generation ||
          this.state.settings.available !== settings.available)
      )
      if (changed) {
        this.clearMedia()
        this.beginKey = undefined
        this.publish({ enrollment: undefined })
      }
      // Preserve older loaded pages. Refresh an actively playing older item
      // separately, so permission changes and deleted audio revoke its URL.
      const older =
        !changed && !manual && samples.next_offset !== null
          ? this.state.samples.filter(
              (row) =>
                !this.firstPageIds.has(row.id) && profiles.has(row.profile_id)
            )
          : []
      let visible = [
        ...new Map(
          [...older, ...samples.results].map((row) => [row.id, row])
        ).values(),
      ]
      visible = [
        ...samples.results,
        ...visible.filter(
          (row) => !samples.results.some((fresh) => fresh.id === row.id)
        ),
      ]
      const preview = this.state.preview
      if (preview) {
        let current = samples.results.find((row) => row.id === preview.id)
        if (!current && older.some((row) => row.id === preview.id)) {
          try {
            current = await this.client.sample(preview.id, this.lifetime.signal)
            if (!profiles.has(current.profile_id))
              throw new Error('voiceprint_response_invalid')
            visible = visible.map((row) =>
              row.id === preview.id ? current! : row
            )
          } catch (error) {
            if (!(error instanceof ApiError) || error.statusCode !== 404)
              throw error
            visible = visible.filter((row) => row.id !== preview.id)
          }
        }
        if (!this.valid() || sequence !== this.refreshing) return
        if (
          !current?.audio_available ||
          Date.parse(current.expires_at) <= Date.now()
        ) {
          URL.revokeObjectURL(preview.url)
          this.publish({ preview: undefined })
        } else
          this.publish({
            preview: {
              ...preview,
              expiresAt: Math.min(
                preview.expiresAt,
                Date.parse(current.expires_at)
              ),
            },
          })
      }
      const nextOffset =
        older.length && this.state.nextOffset !== null
          ? Math.max(this.state.nextOffset, samples.next_offset ?? 0)
          : samples.next_offset
      this.firstPageIds = new Set(samples.results.map((row) => row.id))
      this.publish({
        settings,
        samples: visible,
        nextOffset,
        deletions: deletions.results,
        deletionOffset: deletions.next_offset,
        loading: false,
      })
      const enrollment = this.state.enrollment
      if (enrollment) {
        const result = await this.client.enrollment(
          enrollment.id,
          this.lifetime.signal
        )
        if (
          !this.valid() ||
          sequence !== this.refreshing ||
          this.state.enrollment?.id !== enrollment.id
        )
          return
        if (
          result.status === 'expired' ||
          result.status === 'canceled' ||
          result.consent_version !== settings.version
        ) {
          this.clearMedia()
          this.publish({ enrollment: undefined })
        } else this.publish({ enrollment: result })
      }
    } catch (error) {
      if (sequence === this.refreshing) this.fail(error)
    } finally {
      if (this.loadingSequence === sequence) this.loadingSequence = undefined
    }
  }
  private async run(action: () => Promise<void>) {
    if (!this.valid() || this.state.busy || this.state.conflict) return
    ++this.refreshing
    this.publish({ busy: true, error: undefined })
    try {
      await action()
    } catch (error) {
      this.fail(error)
    } finally {
      if (this.valid()) this.publish({ busy: false, phase: 'idle' })
    }
  }
  private settings() {
    if (!this.state.settings) throw new Error('voiceprint_response_invalid')
    return this.state.settings
  }
  async change(permission: Permission, enabled: boolean) {
    await this.run(async () => {
      const settings = this.settings()
      if (enabled && !settings.available) return
      this.clearMedia()
      this.publish({ enrollment: undefined })
      await this.client.change(
        permission,
        enabled,
        settings.version,
        this.lifetime.signal
      )
      if (this.valid()) await this.refresh(false, true)
    })
  }
  async policy(enabled: boolean, version: number) {
    await this.run(async () => {
      this.clearMedia()
      this.publish({ enrollment: undefined })
      await this.client.policy(enabled, version, this.lifetime.signal)
      if (this.valid()) await this.refresh(false, true)
    })
  }
  async begin(locale: string) {
    await this.run(async () => {
      const settings = this.settings()
      if (!settings.available || !settings.allow_enrollment) return
      this.clearMedia()
      if (!this.beginKey || this.beginKey.version !== settings.version)
        this.beginKey = {
          key: crypto.randomUUID(),
          version: settings.version,
          locale,
        }
      const result = await this.client.begin(
        this.beginKey.version,
        this.beginKey.key,
        this.beginKey.locale,
        this.lifetime.signal
      )
      if (!this.valid()) return
      this.publish({ enrollment: result })
      await this.refresh(false, true)
    })
  }
  slot() {
    if (
      this.uploadAttempt &&
      this.uploadAttempt.id === this.state.enrollment?.id &&
      this.uploadAttempt.clip === this.state.clip
    )
      return this.uploadAttempt.slot
    return (
      [0, 1, 2, 3, 4, 5].find(
        (slot) => !this.state.enrollment?.uploaded_slots.includes(slot)
      ) ?? -1
    )
  }
  canRecord() {
    const { settings, enrollment } = this.state
    return (
      !!settings?.available &&
      settings.allow_enrollment &&
      !!enrollment &&
      enrollment.status === 'open' &&
      enrollment.consent_version === settings.version &&
      enrollment.generation === settings.generation &&
      !!enrollment.upload_token &&
      Date.parse(enrollment.expires_at) > Date.now() &&
      this.slot() >= 0
    )
  }
  async record() {
    await this.run(async () => {
      if (!this.canRecord()) return
      this.clearMedia()
      const recorder = (this.recorder = new VoiceprintRecorder())
      this.publish({ phase: 'requesting' })
      try {
        const blob = await recorder.start(
          this.lifetime.signal,
          () => {
            if (this.valid()) {
              this.recordStarted = Date.now()
              this.publish({ phase: 'recording' })
            }
          },
          () => {
            if (this.valid()) this.publish({ phase: 'preparing' })
          }
        )
        if (!this.valid() || !this.canRecord()) return
        this.publish({
          clip: blob,
          clipUrl: URL.createObjectURL(blob),
          phase: 'idle',
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') return
        this.publish({
          error:
            error instanceof Error && error.message === 'duration'
              ? 'duration'
              : error instanceof Error &&
                  (error.message === 'audio' || error.name === 'EncodingError')
                ? 'voiceprint_audio_format_invalid'
                : 'microphone',
        })
      } finally {
        if (this.recorder === recorder) this.recorder = undefined
      }
    })
  }
  finishRecording() {
    this.recorder?.finish()
  }
  cancelRecording() {
    this.recorder?.cancel()
  }
  discard() {
    if (!this.state.busy) this.clearMedia()
  }
  endEnrollment() {
    if (!this.state.busy) {
      this.clearMedia()
      this.beginKey = undefined
      this.publish({ enrollment: undefined })
    }
  }
  async file(blob: Blob) {
    await this.run(async () => {
      if (!this.canRecord()) return
      await validateWav(blob)
      if (!this.valid() || !this.canRecord()) return
      this.clearMedia()
      this.publish({ clip: blob, clipUrl: URL.createObjectURL(blob) })
    })
  }
  async upload() {
    await this.run(async () => {
      if (!this.canUpload() || !this.state.clip || !this.state.enrollment)
        return
      const enrollment =
          this.uploadAttempt?.enrollment || this.state.enrollment,
        clip = this.state.clip,
        slot = this.slot()
      this.uploadAttempt = { id: enrollment.id, slot, clip, enrollment }
      await this.client.upload(enrollment, slot, clip, this.lifetime.signal)
      if (!this.valid()) return
      this.clearMedia()
      await this.refresh(false, true)
    })
  }
  canUpload() {
    const retry = this.uploadAttempt
    const settings = this.state.settings
    if (
      retry &&
      retry.clip === this.state.clip &&
      retry.id === this.state.enrollment?.id &&
      settings
    ) {
      return (
        settings.available &&
        settings.allow_enrollment &&
        retry.enrollment.consent_version === settings.version &&
        retry.enrollment.generation === settings.generation &&
        Date.parse(retry.enrollment.expires_at) > Date.now()
      )
    }
    return this.canRecord()
  }
  async preview(sample: Sample) {
    await this.run(async () => {
      const current = this.state.samples.find((row) => row.id === sample.id)
      if (
        !current?.audio_available ||
        Date.parse(current.expires_at) <= Date.now()
      )
        return
      if (this.state.preview) {
        URL.revokeObjectURL(this.state.preview.url)
        this.publish({ preview: undefined })
      }
      const blob = await this.client.audio(sample.id, this.lifetime.signal)
      if (!this.valid()) return
      if (this.state.preview) URL.revokeObjectURL(this.state.preview.url)
      this.publish({
        preview: {
          id: sample.id,
          url: URL.createObjectURL(blob),
          expiresAt: Date.parse(current.expires_at),
          listened: false,
          selfConfirmed: false,
        },
      })
    })
  }
  listened(id: string) {
    if (this.valid() && this.state.preview?.id === id)
      this.publish({ preview: { ...this.state.preview, listened: true } })
  }
  confirmSelf(id: string, selected: boolean) {
    if (this.valid() && this.state.preview?.id === id)
      this.publish({
        preview: { ...this.state.preview, selfConfirmed: selected },
      })
  }
  async decide(sample: Sample, accepted: boolean) {
    await this.run(async () => {
      const current = this.state.samples.find((row) => row.id === sample.id)
      if (
        !current?.audio_available ||
        !this.settings().allow_enrollment ||
        Date.parse(current.expires_at) <= Date.now()
      )
        return
      if (
        accepted &&
        (!current.confirmable ||
          this.state.preview?.id !== sample.id ||
          !this.state.preview.listened ||
          !this.state.preview.selfConfirmed)
      )
        return
      this.clearMedia()
      await this.client.decide(
        sample.id,
        accepted,
        this.settings().version,
        this.lifetime.signal
      )
      if (this.valid()) await this.refresh(false, true)
    })
  }
  requestRemoval(id: string | undefined) {
    if (this.valid() && !this.state.busy && !this.state.conflict)
      this.publish({ deleteTarget: id })
  }
  async remove() {
    await this.run(async () => {
      const id = this.state.deleteTarget
      if (!id) return
      if (!this.removal || this.removal.id !== id)
        this.removal = {
          id,
          key: crypto.randomUUID(),
          version: this.settings().version,
        }
      this.clearMedia()
      await this.client.remove(
        id,
        this.removal.version,
        this.removal.key,
        this.lifetime.signal
      )
      if (!this.valid()) return
      this.publish({ deleteTarget: undefined, enrollment: undefined })
      this.beginKey = undefined
      await this.refresh(false, true)
    })
  }
  async more(kind: 'samples' | 'deletions') {
    await this.run(async () => {
      const offset =
        kind === 'samples' ? this.state.nextOffset : this.state.deletionOffset
      if (offset === null) return
      if (kind === 'samples') {
        const settings = await this.client.settings(this.lifetime.signal)
        if (!this.valid()) return
        if (
          settings.version !== this.settings().version ||
          settings.generation !== this.settings().generation ||
          settings.available !== this.settings().available
        ) {
          await this.refresh(false, true)
          return
        }
        const page = await this.client.samples(offset, this.lifetime.signal)
        const profiles = new Set(
          settings.profiles
            .filter(
              (p) =>
                p.status !== 'deleted' && p.generation === settings.generation
            )
            .map((p) => p.id)
        )
        if (page.results.some((row) => !profiles.has(row.profile_id)))
          throw new Error('voiceprint_response_invalid')
        if (this.valid())
          this.publish({
            samples: [
              ...new Map(
                [...this.state.samples, ...page.results].map((row) => [
                  row.id,
                  row,
                ])
              ).values(),
            ],
            nextOffset: page.next_offset,
          })
      } else {
        const page = await this.client.deletions(offset, this.lifetime.signal)
        if (this.valid())
          this.publish({
            deletions: [
              ...new Map(
                [...this.state.deletions, ...page.results].map((row) => [
                  row.id,
                  row,
                ])
              ).values(),
            ],
            deletionOffset: page.next_offset,
          })
      }
    })
  }
}

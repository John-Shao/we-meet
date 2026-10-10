import { fetchApi } from '@/api/fetchApi'
import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import { privateVoiceprintRequest } from '@/features/voiceprint/privateRequest'

export type DiarizationJob = {
  id: string
  generation: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  source_transcription_id: string
  source_revision: number
  published_count: number
}
export type DiarizationState = {
  available: boolean
  can_start: boolean
  record_revision: number
  source_transcription_id: string | null
  active_job_id: string | null
  results: DiarizationJob[]
}
export type DiarizationIntent = { key: string; expected_revision: number }
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
const integer = (value: unknown, min = 0) =>
  Number.isSafeInteger(value) && Number(value) >= min
const invalid = () => new Error('capture_diarization_response_invalid')
const jobValid = (value: DiarizationJob) =>
  value &&
  uuid(value.id) &&
  integer(value.generation, 1) &&
  ['queued', 'running', 'succeeded', 'failed', 'canceled'].includes(
    value.status
  ) &&
  uuid(value.source_transcription_id) &&
  integer(value.source_revision, 1) &&
  integer(value.published_count) &&
  value.published_count <= 20000
export const clearDiarizationIntents = () => {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith('capture-diarization:')) sessionStorage.removeItem(key)
}

/** Exact owner and login fences; only nonce/revision survive reloads in this tab. */
export class DiarizationClient {
  readonly auth = getAuthSnapshot()
  readonly path: string
  readonly storageKey: string
  constructor(
    readonly ownerId: string,
    readonly captureId: string
  ) {
    if (!uuid(ownerId) || !uuid(captureId)) throw invalid()
    this.path = `capture-sessions/${captureId}/diarization/`
    this.storageKey = `capture-diarization:${this.auth.session}:${ownerId}:${captureId}`
  }
  private assert() {
    if (!sameAuthSession(this.auth)) throw new Error('authentication_changed')
  }
  private request<T>(
    path: string,
    options: Parameters<typeof fetchApi>[1] = {},
    signal?: AbortSignal
  ) {
    return privateVoiceprintRequest(
      this.auth,
      (bounded) =>
        fetchApi<T>(path, {
          ...options,
          headers: { ...options?.headers, 'X-Voiceprint-Owner': this.ownerId },
          signal: bounded,
          cache: 'no-store',
        }),
      signal
    )
  }
  intent(): DiarizationIntent | undefined {
    this.assert()
    for (const key of Object.keys(sessionStorage)) {
      if (
        key.startsWith('capture-diarization:') &&
        !key.startsWith(`capture-diarization:${this.auth.session}:`)
      )
        sessionStorage.removeItem(key)
    }
    const raw = sessionStorage.getItem(this.storageKey)
    if (!raw) return
    const value = JSON.parse(raw)
    if (
      !value ||
      !uuid(value.key) ||
      !integer(value.expected_revision, 1) ||
      Object.keys(value).length !== 2
    )
      throw invalid()
    return value
  }
  remember(value: DiarizationIntent) {
    this.assert()
    const previous = this.intent()
    if (
      previous &&
      (previous.key !== value.key ||
        previous.expected_revision !== value.expected_revision)
    )
      throw invalid()
    if (
      !previous &&
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith('capture-diarization:')
      ).length >= 20
    )
      throw invalid()
    if (!uuid(value.key) || !integer(value.expected_revision, 1))
      throw invalid()
    sessionStorage.setItem(this.storageKey, JSON.stringify(value))
  }
  acknowledge(key: string) {
    this.assert()
    if (this.intent()?.key === key) sessionStorage.removeItem(this.storageKey)
  }
  async state(signal: AbortSignal) {
    const value = await this.request<DiarizationState>(this.path, {}, signal)
    if (
      !value ||
      typeof value.available !== 'boolean' ||
      typeof value.can_start !== 'boolean' ||
      !integer(value.record_revision, 1) ||
      !(
        value.source_transcription_id === null ||
        uuid(value.source_transcription_id)
      ) ||
      !(value.active_job_id === null || uuid(value.active_job_id)) ||
      !Array.isArray(value.results) ||
      value.results.length > 20 ||
      !value.results.every(jobValid) ||
      new Set(value.results.map((job) => job.id)).size !==
        value.results.length ||
      (value.active_job_id !== null &&
        value.results.some(
          (job) =>
            job.id === value.active_job_id &&
            (job.status !== 'succeeded' ||
              job.source_transcription_id !== value.source_transcription_id)
        ))
    )
      throw invalid()
    return value
  }
  async submit(intent: DiarizationIntent, signal: AbortSignal) {
    this.remember(intent)
    const result = await this.request<{
      job: DiarizationJob
      created: boolean
    }>(
      this.path,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': intent.key },
        meetingCommand: {
          key: intent.key,
          scope: { capture_id: this.captureId },
        },
        body: JSON.stringify({ expected_revision: intent.expected_revision }),
      },
      signal
    )
    if (
      !jobValid(result?.job) ||
      typeof result.created !== 'boolean' ||
      result.job.source_revision !== intent.expected_revision
    )
      throw invalid()
    this.acknowledge(intent.key)
    return result.job
  }
  async cancel(job: DiarizationJob, revision: number, signal: AbortSignal) {
    if (!jobValid(job) || !integer(revision, 1)) throw invalid()
    const result = await this.request<{ job: DiarizationJob }>(
      `${this.path}${job.id}/cancel/`,
      { method: 'POST', body: JSON.stringify({ expected_revision: revision }) },
      signal
    )
    if (
      !jobValid(result?.job) ||
      result.job.id !== job.id ||
      result.job.status !== 'canceled'
    )
      throw invalid()
  }
}

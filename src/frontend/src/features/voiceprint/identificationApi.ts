import { fetchApi } from '@/api/fetchApi'
import {
  getAuthSnapshot,
  type AuthSnapshot,
} from '@/features/auth/utils/tokenStorage'
import { privateVoiceprintRequest } from './privateRequest'
import type { ApiRecordSpeaker } from '@/features/meetings/api/ApiMeetingRecord'

export type IdentityPerson = { id: string; name: string }
export type IdentityScope = IdentityPerson & { enabled: boolean }
export type IdentityPage<T> = { results: T[]; next_offset: number | null }
export type IdentityOptions = {
  record_revision: number
  required_organization_id: string | null
  personal_allowed: boolean
  targets: IdentityPerson[]
  scopes: IdentityPage<IdentityScope>
}
export type IdentityCandidates = IdentityPage<IdentityPerson> & {
  record_revision: number
  organization_id: string | null
}
export type IdentityInterval = { start_ms: number; end_ms: number }
export type IdentitySuggestion = {
  id: string
  state: 'pending' | 'confirmed' | 'rejected' | 'invalidated'
  result:
    | 'suggested'
    | 'unknown'
    | 'mixed_speaker'
    | 'ambiguous'
    | 'insufficient_audio'
    | 'unavailable'
  reason: string
  clip_count: number
  speech_ms: number
  query_intervals: IdentityInterval[]
  can_confirm: boolean
  verification_unavailable: boolean
  candidate: IdentityPerson | null
}
export type IdentityJob = {
  id: string
  speaker_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'
  retryable: boolean
  suggestion: IdentitySuggestion | null
}
export type IdentityBatch = {
  id: string
  request_key: string
  organization_id: string | null
  source_revision: number
  created_at: string
  processing: boolean
  jobs: IdentityJob[]
}
export type IdentityResponse = {
  record_revision: number
  request: IdentityBatch | null
}
export type IdentitySubmission = {
  request_key: string
  expected_revision: number
  organization_id: string | null
  user_ids: string[]
  speaker_ids: string[]
}

const invalid = () => new Error('voiceprint_response_invalid')
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
const id = (value: string) => {
  if (!uuid(value)) throw invalid()
  return value
}
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const scope = (value: unknown) => value === null || uuid(value)
const person = (value: unknown): value is IdentityPerson =>
  object(value) &&
  uuid(value.id) &&
  typeof value.name === 'string' &&
  !!value.name.trim() &&
  value.name.length <= 512
const identifiers = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every(uuid) &&
  new Set(value).size === value.length
const page = <T extends IdentityPerson>(
  value: IdentityPage<T>,
  offset: number
) => {
  if (
    !object(value) ||
    !Array.isArray(value.results) ||
    value.results.length > 25 ||
    value.results.some((row) => !person(row)) ||
    new Set(value.results.map((row) => row.id)).size !== value.results.length ||
    !(
      value.next_offset === null ||
      integer(value.next_offset, offset + 1, 10000)
    )
  )
    throw invalid()
}

export class IdentificationClient {
  constructor(
    readonly recordId: string,
    readonly ownerId: string,
    readonly auth: AuthSnapshot = getAuthSnapshot()
  ) {
    id(recordId)
    id(ownerId)
  }
  private send<T>(path: string, options: RequestInit = {}) {
    return privateVoiceprintRequest(
      this.auth,
      (signal) =>
        fetchApi<T>(`meeting-records/${this.recordId}/${path}`, {
          ...options,
          signal,
          cache: 'no-store',
          redirect: 'error',
          headers: { 'X-Voiceprint-Owner': this.ownerId },
        }),
      options.signal
    )
  }
  private query(revision: number, offset: number) {
    if (!integer(revision, 1) || !integer(offset, 0, 10000)) throw invalid()
    return new URLSearchParams({
      expected_revision: String(revision),
      offset: String(offset),
    })
  }
  async options(revision: number, offset = 0, signal?: AbortSignal) {
    const result = await this.send<IdentityOptions>(
      `speaker-identification-options/?${this.query(revision, offset)}`,
      { signal }
    )
    if (
      !object(result) ||
      result.record_revision !== revision ||
      !scope(result.required_organization_id) ||
      typeof result.personal_allowed !== 'boolean' ||
      !Array.isArray(result.targets) ||
      !result.targets.every(person) ||
      !identifiers(result.targets.map((row) => row.id)) ||
      result.personal_allowed !== (result.required_organization_id === null)
    )
      throw invalid()
    page(result.scopes, offset)
    if (
      result.scopes.results.some(
        (row) =>
          typeof row.enabled !== 'boolean' ||
          (result.required_organization_id !== null &&
            row.id !== result.required_organization_id)
      )
    )
      throw invalid()
    return result
  }
  async candidates(
    organization: string | null,
    revision: number,
    query = '',
    offset = 0,
    signal?: AbortSignal
  ) {
    if (!scope(organization) || query.length > 80) throw invalid()
    const parameters = this.query(revision, offset)
    parameters.set('organization_id', organization ?? 'personal')
    parameters.set('q', query)
    const result = await this.send<IdentityCandidates>(
      `speaker-identification-candidates/?${parameters}`,
      { signal }
    )
    if (
      !object(result) ||
      result.record_revision !== revision ||
      result.organization_id !== organization
    )
      throw invalid()
    page(result, offset)
    if (
      organization === null &&
      result.results.some((row) => row.id !== this.ownerId)
    )
      throw invalid()
    return result
  }
  private response(result: IdentityResponse, requestKey?: string) {
    if (!object(result) || !integer(result.record_revision, 1)) throw invalid()
    const batch = result.request
    if (batch === null) {
      if (requestKey) throw invalid()
      return result
    }
    if (
      !object(batch) ||
      !uuid(batch.id) ||
      !uuid(batch.request_key) ||
      (requestKey && batch.request_key !== requestKey) ||
      !scope(batch.organization_id) ||
      !integer(batch.source_revision, 1, result.record_revision) ||
      typeof batch.created_at !== 'string' ||
      !Number.isFinite(Date.parse(batch.created_at)) ||
      typeof batch.processing !== 'boolean' ||
      !Array.isArray(batch.jobs) ||
      batch.jobs.length < 1 ||
      batch.jobs.length > 50
    )
      throw invalid()
    const jobIds = new Set<string>(),
      speakers = new Set<string>()
    for (const job of batch.jobs) {
      if (
        !object(job) ||
        !uuid(job.id) ||
        !uuid(job.speaker_id) ||
        jobIds.has(job.id) ||
        speakers.has(job.speaker_id) ||
        ![
          'queued',
          'running',
          'succeeded',
          'failed',
          'canceled',
          'expired',
        ].includes(job.status) ||
        typeof job.retryable !== 'boolean'
      )
        throw invalid()
      jobIds.add(job.id)
      speakers.add(job.speaker_id)
      const row = job.suggestion
      if (row === null) continue
      if (
        !object(row) ||
        !uuid(row.id) ||
        !['pending', 'confirmed', 'rejected', 'invalidated'].includes(
          row.state
        ) ||
        ![
          'suggested',
          'unknown',
          'mixed_speaker',
          'ambiguous',
          'insufficient_audio',
          'unavailable',
        ].includes(row.result) ||
        typeof row.reason !== 'string' ||
        !/^[a-z][a-z0-9_]{0,127}$/.test(row.reason) ||
        !integer(row.clip_count, 0, 12) ||
        !integer(row.speech_ms, 0, 120000) ||
        typeof row.can_confirm !== 'boolean' ||
        typeof row.verification_unavailable !== 'boolean' ||
        !(row.candidate === null || person(row.candidate)) ||
        !Array.isArray(row.query_intervals) ||
        row.query_intervals.length > row.clip_count ||
        row.speech_ms > row.clip_count * 10000
      )
        throw invalid()
      let lastEnd = 0
      for (const interval of row.query_intervals) {
        if (
          !object(interval) ||
          !integer(interval.start_ms, lastEnd, 7200000) ||
          !integer(
            interval.end_ms,
            interval.start_ms + 3000,
            Math.min(7200000, interval.start_ms + 10000)
          )
        )
          throw invalid()
        lastEnd = interval.end_ms
      }
      if (
        (row.can_confirm &&
          (batch.processing ||
            row.state !== 'pending' ||
            row.result !== 'suggested' ||
            row.candidate === null ||
            job.status !== 'succeeded')) ||
        (row.candidate !== null &&
          (row.state !== 'pending' ||
            row.result !== 'suggested' ||
            job.status !== 'succeeded')) ||
        (row.verification_unavailable &&
          (row.candidate !== null ||
            row.can_confirm ||
            row.query_intervals.length > 0)) ||
        (row.state !== 'pending' &&
          (row.candidate !== null ||
            row.can_confirm ||
            row.query_intervals.length > 0))
      )
        throw invalid()
    }
    return result
  }
  async submit(input: IdentitySubmission, signal?: AbortSignal) {
    id(input.request_key)
    if (
      !integer(input.expected_revision, 1) ||
      !scope(input.organization_id) ||
      !identifiers(input.user_ids) ||
      input.user_ids.length < 1 ||
      !identifiers(input.speaker_ids) ||
      input.speaker_ids.length < 1
    )
      throw invalid()
    const result = this.response(
      await this.send<IdentityResponse>('speaker-identification/', {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      }),
      input.request_key
    )
    if (
      result.request!.organization_id !== input.organization_id ||
      result.request!.source_revision !== input.expected_revision ||
      result.request!.jobs.length !== input.speaker_ids.length ||
      result.request!.jobs.some(
        (job) => !input.speaker_ids.includes(job.speaker_id)
      )
    )
      throw invalid()
    return result
  }
  async read(requestKey?: string, signal?: AbortSignal) {
    return this.response(
      await this.send<IdentityResponse>(
        `speaker-identification/${requestKey ? `?request_key=${id(requestKey)}` : ''}`,
        { signal }
      ),
      requestKey
    )
  }
  async cancel(requestKey: string, revision: number, signal?: AbortSignal) {
    if (!integer(revision, 1)) throw invalid()
    return this.response(
      await this.send<IdentityResponse>('speaker-identification/', {
        method: 'DELETE',
        body: JSON.stringify({
          request_key: id(requestKey),
          expected_revision: revision,
        }),
        signal,
      }),
      requestKey
    )
  }
  async decide(
    speakerId: string,
    suggestionId: string,
    action: 'confirm_suggestion' | 'reject_suggestion',
    revision: number,
    signal?: AbortSignal
  ) {
    if (
      !integer(revision, 1) ||
      !['confirm_suggestion', 'reject_suggestion'].includes(action)
    )
      throw invalid()
    const result = await this.send<ApiRecordSpeaker>(
      `speakers/${id(speakerId)}/identity-decision/`,
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          suggestion_id: id(suggestionId),
          expected_revision: revision,
        }),
        signal,
      }
    )
    if (
      !object(result) ||
      result.id !== speakerId ||
      !integer(result.record_revision, revision) ||
      typeof result.display_name !== 'string' ||
      result.display_name.length > 512
    )
      throw invalid()
    return result
  }
}

import { ApiError } from '@/api/ApiError'
import { fetchApi, fetchApiBlob } from '@/api/fetchApi'
import { privateVoiceprintRequest } from './privateRequest'
import {
  getAuthSnapshot,
  type AuthSnapshot,
} from '@/features/auth/utils/tokenStorage'

export const MAX_WAV_BYTES = 484096
export const permissions = [
  'allow_enrollment',
  'allow_accumulation',
  'allow_identification',
] as const
export type Permission = (typeof permissions)[number]
export type Scope = {
  id: string
  name: string
  can_manage_policy: boolean
  policy: Policy
}
export type Policy = { enabled: boolean; version: number }
export type Profile = {
  id: string
  status: 'pending' | 'active' | 'paused' | 'deleted'
  generation: number
  confirmed_at: string | null
  last_updated_at: string | null
}
export type Settings = Record<Permission, boolean> & {
  organization_id: string | null
  available: boolean
  version: number
  generation: number
  profiles: Profile[]
}
export type Page<T> = { results: T[]; next_offset: number | null }
export type Enrollment = {
  id: string
  organization_id: string | null
  profile_id: string | null
  status: 'open' | 'closed' | 'expired' | 'canceled'
  expires_at: string
  consent_version: number
  generation: number
  challenges: string[]
  max_clips: number
  uploaded_slots: number[]
  sample_rate: number
  channels: number
  format: string
  clip_duration_ms: { minimum: number; maximum: number }
  upload_token: string | null
}
export type Sample = {
  id: string
  profile_id: string
  status:
    | 'pending'
    | 'processing'
    | 'quality_pending'
    | 'ready'
    | 'confirmed'
    | 'rejected'
    | 'expired'
    | 'deleted'
  source_type: 'enrollment' | 'call'
  duration_ms: number
  expires_at: string
  confirmable: boolean
  audio_available: boolean
}
export type Deletion = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  revoked_generation: number
  finished_at: string | null
  error_code: string | null
}

const uuid = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0
const optionalDate = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && Number.isFinite(Date.parse(value)))
const invalid = () => new Error('voiceprint_response_invalid')
const pathId = (id: string) => {
  if (!uuid(id)) throw invalid()
  return id
}

/** One UI lifetime and scope; never move a private request to a new login. */
export class VoiceprintClient {
  constructor(
    readonly organizationId: string | null,
    readonly ownerId: string,
    readonly auth: AuthSnapshot = getAuthSnapshot()
  ) {
    if (organizationId !== null) pathId(organizationId)
    pathId(ownerId)
  }
  private async send<T>(path: string, options?: RequestInit) {
    return this.request(
      (signal) =>
        fetchApi<T>(`voiceprint/${path}`, {
          cache: 'no-store',
          ...options,
          headers: {
            ...Object.fromEntries(new Headers(options?.headers)),
            'X-Voiceprint-Owner': this.ownerId,
          },
          signal,
        }),
      options?.signal
    )
  }
  private async request<T>(
    action: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal | null
  ): Promise<T> {
    return privateVoiceprintRequest(this.auth, action, external)
  }
  private scopeQuery(offset = 0) {
    if (!integer(offset) || offset > 10000) throw invalid()
    const query = new URLSearchParams({ offset: String(offset) })
    if (this.organizationId) query.set('organization_id', this.organizationId)
    return query.toString()
  }
  async scopes(offset = 0, signal?: AbortSignal) {
    if (!integer(offset) || offset > 10000) throw invalid()
    const page = await this.send<Page<Scope>>(`scopes/?offset=${offset}`, {
      signal,
    })
    this.page(page, offset)
    if (
      page.results.some(
        (row) =>
          !row ||
          !uuid(row.id) ||
          typeof row.name !== 'string' ||
          typeof row.can_manage_policy !== 'boolean' ||
          !row.policy ||
          typeof row.policy.enabled !== 'boolean' ||
          !integer(row.policy.version)
      )
    )
      throw invalid()
    return page
  }
  async settings(signal?: AbortSignal) {
    const query = this.organizationId
      ? `?organization_id=${this.organizationId}`
      : ''
    const value = await this.send<Settings>(`settings/${query}`, { signal })
    return this.checkSettings(value)
  }
  private checkSettings(value: Settings) {
    if (
      !value ||
      value.organization_id !== this.organizationId ||
      typeof value.available !== 'boolean' ||
      !integer(value.version) ||
      !integer(value.generation) ||
      permissions.some((key) => typeof value[key] !== 'boolean') ||
      !Array.isArray(value.profiles) ||
      value.profiles.some(
        (p) =>
          !p ||
          !uuid(p.id) ||
          !integer(p.generation) ||
          !optionalDate(p.confirmed_at) ||
          !optionalDate(p.last_updated_at) ||
          !['pending', 'active', 'paused', 'deleted'].includes(p.status)
      )
    )
      throw invalid()
    return value
  }
  async change(
    permission: Permission,
    enabled: boolean,
    version: number,
    signal?: AbortSignal
  ) {
    const result = await this.send<Settings>('settings/', {
      method: 'PATCH',
      signal,
      body: JSON.stringify({
        organization_id: this.organizationId,
        expected_version: version,
        [permission]: enabled,
      }),
    })
    return this.checkSettings(result)
  }
  async policy(enabled: boolean, version: number, signal?: AbortSignal) {
    if (!this.organizationId) throw invalid()
    const result = await this.send<Policy>(
      `organizations/${pathId(this.organizationId)}/settings/`,
      {
        method: 'PATCH',
        signal,
        body: JSON.stringify({ enabled, expected_version: version }),
      }
    )
    if (
      !result ||
      typeof result.enabled !== 'boolean' ||
      !integer(result.version)
    )
      throw invalid()
    return result
  }
  async begin(
    version: number,
    requestKey: string,
    locale: string,
    signal?: AbortSignal
  ) {
    const result = await this.send<Enrollment>('enrollments/', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        organization_id: this.organizationId,
        expected_version: version,
        request_key: pathId(requestKey),
        locale,
      }),
    })
    return this.checkEnrollment(result)
  }
  async enrollment(id: string, signal?: AbortSignal) {
    const result = await this.send<Enrollment>(`enrollments/${pathId(id)}/`, {
      signal,
    })
    if (result?.id !== id) throw invalid()
    return this.checkEnrollment(result)
  }
  private checkEnrollment(value: Enrollment) {
    if (
      !value ||
      !uuid(value.id) ||
      value.organization_id !== this.organizationId ||
      (value.profile_id !== null && !uuid(value.profile_id)) ||
      !['open', 'closed', 'expired', 'canceled'].includes(value.status) ||
      !Number.isFinite(Date.parse(value.expires_at)) ||
      !integer(value.consent_version) ||
      !integer(value.generation) ||
      value.max_clips !== 6 ||
      !Array.isArray(value.challenges) ||
      value.challenges.length !== 6 ||
      value.challenges.some((p) => typeof p !== 'string' || p.length > 1000) ||
      !Array.isArray(value.uploaded_slots) ||
      new Set(value.uploaded_slots).size !== value.uploaded_slots.length ||
      value.uploaded_slots.some((s) => !integer(s) || s > 5) ||
      value.sample_rate !== 24000 ||
      value.channels !== 1 ||
      value.format !== 'pcm16_wav' ||
      value.clip_duration_ms?.minimum !== 3000 ||
      value.clip_duration_ms?.maximum !== 10000 ||
      (value.upload_token !== null &&
        !/^[A-Za-z0-9_-]{43}$/.test(value.upload_token))
    )
      throw invalid()
    return value
  }
  async upload(
    enrollment: Enrollment,
    slot: number,
    wav: Blob,
    signal?: AbortSignal
  ) {
    if (
      !integer(slot) ||
      slot > 5 ||
      !enrollment.upload_token ||
      enrollment.organization_id !== this.organizationId ||
      wav.size < 44 ||
      wav.size > MAX_WAV_BYTES
    )
      throw invalid()
    const result = await this.send<Sample>(
      `enrollments/${pathId(enrollment.id)}/clips/${slot}/`,
      {
        method: 'PUT',
        signal,
        headers: {
          'Content-Type': 'audio/wav',
          'X-Voiceprint-Upload-Token': enrollment.upload_token,
        },
        body: wav,
      }
    )
    this.checkSample(result)
    if (result.profile_id !== enrollment.profile_id) throw invalid()
    return result
  }
  async samples(offset = 0, signal?: AbortSignal) {
    const value = await this.send<Page<Sample>>(
      `samples/?${this.scopeQuery(offset)}`,
      { signal }
    )
    this.page(value, offset)
    value.results.forEach((row) => this.checkSample(row))
    return value
  }
  private page<T>(value: Page<T>, offset: number) {
    if (
      !value ||
      !Array.isArray(value.results) ||
      value.results.length > 25 ||
      (value.next_offset !== null &&
        (!integer(value.next_offset) ||
          value.next_offset > 10000 ||
          value.next_offset <= offset ||
          value.results.length === 0))
    )
      throw invalid()
  }
  async sample(id: string, signal?: AbortSignal) {
    const query = this.organizationId
      ? `?organization_id=${this.organizationId}`
      : ''
    const row = await this.send<Sample>(`samples/${pathId(id)}/${query}`, {
      signal,
    })
    this.checkSample(row)
    if (row.id !== id) throw invalid()
    return row
  }
  private checkSample(row: Sample) {
    if (
      !row ||
      !uuid(row.id) ||
      !uuid(row.profile_id) ||
      ![
        'pending',
        'processing',
        'quality_pending',
        'ready',
        'confirmed',
        'rejected',
        'expired',
        'deleted',
      ].includes(row.status) ||
      !['enrollment', 'call'].includes(row.source_type) ||
      !integer(row.duration_ms) ||
      row.duration_ms < 3000 ||
      row.duration_ms > 10000 ||
      !Number.isFinite(Date.parse(row.expires_at)) ||
      typeof row.confirmable !== 'boolean' ||
      typeof row.audio_available !== 'boolean' ||
      (row.confirmable && (row.status !== 'ready' || !row.audio_available))
    )
      throw invalid()
  }
  async audio(id: string, signal?: AbortSignal) {
    const blob = await this.request(
      (boundedSignal) =>
        fetchApiBlob(
          `voiceprint/samples/${pathId(id)}/audio/`,
          {
            signal: boundedSignal,
            cache: 'no-store',
            headers: { 'X-Voiceprint-Owner': this.ownerId },
          },
          MAX_WAV_BYTES
        ),
      signal
    )
    if (blob.type.split(';')[0] !== 'audio/wav' || blob.size < 44)
      throw invalid()
    return blob
  }
  async decide(
    id: string,
    accepted: boolean,
    version: number,
    signal?: AbortSignal
  ) {
    const result = await this.send<Sample>(`samples/${pathId(id)}/decision/`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ accepted, expected_version: version }),
    })
    this.checkSample(result)
    if (
      result.id !== id ||
      result.status !== (accepted ? 'confirmed' : 'rejected')
    )
      throw invalid()
    return result
  }
  async remove(id: string, version: number, key: string, signal?: AbortSignal) {
    const result = await this.send<Deletion>(`profiles/${pathId(id)}/`, {
      method: 'DELETE',
      signal,
      body: JSON.stringify({
        expected_version: version,
        request_key: pathId(key),
      }),
    })
    return this.checkDeletion(result)
  }
  async deletion(id: string, signal?: AbortSignal) {
    const result = await this.send<Deletion>(`deletions/${pathId(id)}/`, {
      signal,
    })
    if (result?.id !== id) throw invalid()
    return this.checkDeletion(result)
  }
  async deletions(offset = 0, signal?: AbortSignal) {
    const result = await this.send<Page<Deletion>>(
      `deletions/?${this.scopeQuery(offset)}`,
      { signal }
    )
    this.page(result, offset)
    result.results.forEach((row) => this.checkDeletion(row))
    return result
  }
  private checkDeletion(value: Deletion) {
    if (
      !value ||
      !uuid(value.id) ||
      !['queued', 'running', 'succeeded', 'failed'].includes(value.status) ||
      !integer(value.revoked_generation) ||
      !optionalDate(value.finished_at) ||
      (value.error_code !== null && typeof value.error_code !== 'string')
    )
      throw invalid()
    return value
  }
}

export function errorKey(error: unknown) {
  if (error instanceof Error && error.message === 'duration') return 'duration'
  if (error instanceof Error && error.message === 'audio')
    return 'voiceprint_audio_format_invalid'
  if (error instanceof ApiError) {
    const code = (error.body as { code?: unknown } | null)?.code
    if (code === 'voiceprint_wav_invalid')
      return 'voiceprint_audio_format_invalid'
    if (
      typeof code === 'string' &&
      [
        'voiceprint_enrollment_quota',
        'voiceprint_duplicate_audio',
        'voiceprint_audio_format_invalid',
        'voiceprint_quality_pending',
        'voiceprint_upload_expired',
        'voiceprint_key_unavailable',
      ].includes(code)
    )
      return code
    if (error.statusCode === 409) return 'conflict'
    if (
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      error.statusCode === 404
    )
      return 'unavailable'
  }
  return 'failed'
}

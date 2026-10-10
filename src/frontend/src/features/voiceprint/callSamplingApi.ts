import { fetchApi } from '@/api/fetchApi'
import {
  getAuthSnapshot,
  type AuthSnapshot,
} from '@/features/auth/utils/tokenStorage'
import { VoiceprintClient } from './api'
import { privateVoiceprintRequest } from './privateRequest'

export const callDeviceGroups = ['headset', 'handset', 'computer'] as const
export type CallDeviceGroup = (typeof callDeviceGroups)[number]
export const controlStates = [
  'ready',
  'disabled',
  'disconnected',
  'source_removed',
  'authorization_required',
  'paused',
  'shared_microphone',
  'device_required',
] as const
export const runtimeStates = [
  'stopped',
  'waiting',
  'starting',
  'sampling',
  'uploading',
  'unavailable',
] as const
export const runtimeReasons = [
  '',
  ...controlStates,
  'microphone_unavailable',
  'quota_exhausted',
  'sampling_dispatch_unavailable',
] as const
export type SamplingControl = {
  session_id: string
  participant_sid: string
  revision: number
  paused: boolean
  shared_microphone: boolean
  device_group: '' | CallDeviceGroup
  state: (typeof controlStates)[number]
  stop_reason: '' | 'mixed_speaker'
  runtime: {
    state: (typeof runtimeStates)[number]
    reason: (typeof runtimeReasons)[number]
    updated_at: string | null
    remaining_ms?: { session_ms: number; daily_ms: number }
  }
}
export type SamplingConnection = {
  room_sid: string
  organization_id: string | null
  organization_name: string | null
  observed_at: string
  limits: {
    clip_ms: number
    session_ms: number
    daily_ms: number
    candidate_retention_seconds: number
  }
  permission: {
    available: boolean
    version: number
    allow_enrollment: boolean
    allow_accumulation: boolean
  }
  control: SamplingControl
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
const rtcSid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
const invalid = () => new Error('voiceprint_sampling_response_invalid')

/** No join token, participant name, audio, raw device ID or cache is required. */
export class CallSamplingClient {
  private connection?: { sessionId: string; organizationId: string | null }
  constructor(
    readonly ownerId: string,
    readonly roomSid: string,
    readonly participantSid: string,
    readonly auth: AuthSnapshot = getAuthSnapshot()
  ) {
    if (!uuid(ownerId) || !rtcSid(roomSid) || !rtcSid(participantSid))
      throw invalid()
  }
  private send<T>(path: string, options?: RequestInit) {
    return privateVoiceprintRequest(
      this.auth,
      (signal) =>
        fetchApi<T>(`voiceprint/${path}`, {
          cache: 'no-store',
          ...options,
          signal,
          headers: { 'X-Voiceprint-Owner': this.ownerId },
        }),
      options?.signal
    )
  }
  async read(signal?: AbortSignal) {
    const value = await this.send<SamplingConnection>(
      `sampling-connection/?${new URLSearchParams({ room_sid: this.roomSid, participant_sid: this.participantSid })}`,
      { signal }
    )
    if (
      !value ||
      value.room_sid !== this.roomSid ||
      (value.organization_id !== null && !uuid(value.organization_id)) ||
      (value.organization_id === null
        ? value.organization_name !== null
        : typeof value.organization_name !== 'string' ||
          value.organization_name.length > 255) ||
      !date(value.observed_at) ||
      !value.limits ||
      !value.permission ||
      !integer(value.limits.clip_ms) ||
      value.limits.clip_ms < 3000 ||
      value.limits.clip_ms > 10000 ||
      !integer(value.limits.session_ms) ||
      value.limits.session_ms < 3000 ||
      value.limits.session_ms > 60000 ||
      !integer(value.limits.daily_ms) ||
      value.limits.daily_ms < 3000 ||
      value.limits.daily_ms > 120000 ||
      !integer(value.limits.candidate_retention_seconds) ||
      value.limits.candidate_retention_seconds < 1 ||
      value.limits.candidate_retention_seconds > 86400 ||
      !integer(value.permission.version) ||
      ['available', 'allow_enrollment', 'allow_accumulation'].some(
        (key) =>
          typeof value.permission[key as keyof typeof value.permission] !==
          'boolean'
      )
    )
      throw invalid()
    this.checkControl(value.control)
    if (
      this.connection &&
      (this.connection.sessionId !== value.control.session_id ||
        this.connection.organizationId !== value.organization_id)
    )
      throw invalid()
    const runtime = value.control.runtime
    if (
      (runtime.state === 'sampling' || runtime.state === 'uploading') &&
      (!value.permission.available ||
        !value.permission.allow_accumulation ||
        value.control.state !== 'ready' ||
        runtime.updated_at === null ||
        Date.parse(runtime.updated_at) > Date.parse(value.observed_at) ||
        Date.parse(value.observed_at) - Date.parse(runtime.updated_at) >= 5000)
    )
      throw invalid()
    this.connection = {
      sessionId: value.control.session_id,
      organizationId: value.organization_id,
    }
    return value
  }
  private checkSnapshot(snapshot: SamplingConnection) {
    if (
      !this.connection ||
      snapshot.room_sid !== this.roomSid ||
      snapshot.organization_id !== this.connection.organizationId ||
      !integer(snapshot.permission?.version)
    )
      throw invalid()
    this.checkControl(snapshot.control, this.connection.sessionId)
  }
  private checkControl(value: SamplingControl, sessionId?: string) {
    if (
      !value ||
      !uuid(value.session_id) ||
      (sessionId && value.session_id !== sessionId) ||
      value.participant_sid !== this.participantSid ||
      !integer(value.revision) ||
      typeof value.paused !== 'boolean' ||
      typeof value.shared_microphone !== 'boolean' ||
      !['', ...callDeviceGroups].includes(value.device_group) ||
      !controlStates.includes(value.state) ||
      !['', 'mixed_speaker'].includes(value.stop_reason) ||
      !value.runtime ||
      !runtimeStates.includes(value.runtime.state) ||
      !runtimeReasons.includes(value.runtime.reason) ||
      (value.runtime.updated_at !== null && !date(value.runtime.updated_at)) ||
      (value.state === 'ready' &&
        (value.paused ||
          value.shared_microphone ||
          value.device_group === '')) ||
      (value.state !== 'ready' && value.runtime.state !== 'stopped') ||
      (value.runtime.remaining_ms &&
        (!integer(value.runtime.remaining_ms.session_ms) ||
          value.runtime.remaining_ms.session_ms > 60000 ||
          !integer(value.runtime.remaining_ms.daily_ms) ||
          value.runtime.remaining_ms.daily_ms > 120000))
    )
      throw invalid()
    return value
  }
  async declare(
    snapshot: SamplingConnection,
    changes: Pick<
      SamplingControl,
      'paused' | 'shared_microphone' | 'device_group'
    >,
    signal?: AbortSignal
  ) {
    this.checkSnapshot(snapshot)
    if (
      typeof changes.paused !== 'boolean' ||
      typeof changes.shared_microphone !== 'boolean' ||
      !['', ...callDeviceGroups].includes(changes.device_group)
    )
      throw invalid()
    const result = await this.send<SamplingControl>('sampling-control/', {
      method: 'PATCH',
      signal,
      body: JSON.stringify({
        session_id: snapshot.control.session_id,
        participant_sid: this.participantSid,
        expected_revision: snapshot.control.revision,
        paused: changes.paused,
        shared_microphone: changes.shared_microphone,
        device_group: changes.device_group,
      }),
    })
    return this.checkControl(result, snapshot.control.session_id)
  }
  async disableAccumulation(
    snapshot: SamplingConnection,
    signal?: AbortSignal
  ) {
    this.checkSnapshot(snapshot)
    return new VoiceprintClient(
      snapshot.organization_id,
      this.ownerId,
      this.auth
    ).change('allow_accumulation', false, snapshot.permission.version, signal)
  }
}

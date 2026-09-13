import { fetchApi } from '@/api/fetchApi'
import type { SummaryIntent } from '../hooks/useSummaryIntent'

export type TranslationLanguage = 'zh' | 'en'
export interface TranslationChoice {
  source_language: TranslationLanguage
  target_language: TranslationLanguage
  mode: 'simultaneous' | 'push_to_talk'
  audio: boolean
  save_translations: boolean
}
export interface TranslationConfiguration extends TranslationChoice {
  model: 'qwen3.5-livetranslate-flash-realtime'
  region: 'cn-beijing' | 'ap-southeast-1'
}
export interface CaptureTranslationRun {
  id: string
  capture_id: string
  generation: number
  source_revision: number
  configuration: TranslationConfiguration
  status: 'starting' | 'translating' | 'stopping' | 'stopped' | 'incomplete'
  deadline: string
  ended_at: string | null
  error_code: string
}
export interface CaptureTranslationState {
  source: {
    capture_id: string
    record_id: string
    revision: number
    status: string
  }
  available: boolean
  can_start: boolean
  can_stop: boolean
  can_save_translations: boolean
  current: CaptureTranslationRun | null
}
export interface CaptureTranslationPayload {
  device_id: string
  operation: 'start' | 'stop'
  expected_revision: number
  expected_run_id: string | null
  configuration: TranslationChoice | null
}
export interface CaptureTranslationSource {
  viewerId: string
  captureId: string
  recordId: string
  deviceId: string
  /** Ephemeral request credential; never write it into command storage or WS URLs. */
  leaseKey: string
}
export interface CaptureTranslationTicket {
  ticket: string
  gateway_url: string
  expires_at: string
  source: {
    run_id: string
    capture_id: string
    user_id: string
    device_id: string
    generation: number
    source_revision: number
  }
}
export interface CaptureTranslationReceipt {
  command: {
    key: string
    capture_id: string
    payload: CaptureTranslationPayload
    result: CaptureTranslationRun
  }
  current: CaptureTranslationState
  replayed: boolean
}

export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
export const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
const keys = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => field in value)
const oneOf = (value: unknown, choices: string[]) =>
  typeof value === 'string' && choices.includes(value)
const choiceFields = [
  'source_language',
  'target_language',
  'mode',
  'audio',
  'save_translations',
]
export function isChoice(
  value: unknown,
  frozen = false
): value is TranslationChoice {
  return (
    object(value) &&
    keys(value, frozen ? [...choiceFields, 'model', 'region'] : choiceFields) &&
    oneOf(value.source_language, ['zh', 'en']) &&
    oneOf(value.target_language, ['zh', 'en']) &&
    value.source_language !== value.target_language &&
    oneOf(value.mode, ['simultaneous', 'push_to_talk']) &&
    typeof value.audio === 'boolean' &&
    typeof value.save_translations === 'boolean'
  )
}
export const isConfiguration = (
  value: unknown
): value is TranslationConfiguration =>
  isChoice(value, true) &&
  object(value) &&
  value.model === 'qwen3.5-livetranslate-flash-realtime' &&
  oneOf(value.region, ['cn-beijing', 'ap-southeast-1'])
export const sameChoice = (one: TranslationChoice, two: TranslationChoice) =>
  one.source_language === two.source_language &&
  one.target_language === two.target_language &&
  one.mode === two.mode &&
  one.audio === two.audio &&
  one.save_translations === two.save_translations
export const sameConfiguration = (
  one: TranslationConfiguration,
  two: TranslationConfiguration
) =>
  sameChoice(one, two) && one.model === two.model && one.region === two.region
export const activeRun = (run: CaptureTranslationRun | null) =>
  !!run && ['starting', 'translating', 'stopping'].includes(run.status)

export function isCaptureTranslationPayload(
  value: unknown,
  device: string
): value is CaptureTranslationPayload {
  return (
    object(value) &&
    keys(value, [
      'device_id',
      'operation',
      'expected_revision',
      'expected_run_id',
      'configuration',
    ]) &&
    value.device_id === device &&
    !!device &&
    device.length <= 128 &&
    positive(value.expected_revision) &&
    (value.expected_run_id === null || uuid(value.expected_run_id)) &&
    ((value.operation === 'start' && isChoice(value.configuration)) ||
      (value.operation === 'stop' &&
        uuid(value.expected_run_id) &&
        value.configuration === null))
  )
}
export function isTranslationRun(
  value: unknown,
  captureId: string
): value is CaptureTranslationRun {
  return (
    object(value) &&
    uuid(value.id) &&
    value.capture_id === captureId &&
    positive(value.generation) &&
    positive(value.source_revision) &&
    isConfiguration(value.configuration) &&
    oneOf(value.status, [
      'starting',
      'translating',
      'stopping',
      'stopped',
      'incomplete',
    ]) &&
    date(value.deadline) &&
    (value.ended_at === null || date(value.ended_at)) &&
    ['stopped', 'incomplete'].includes(String(value.status)) ===
      (value.ended_at !== null) &&
    typeof value.error_code === 'string' &&
    value.error_code.length <= 64
  )
}
export function isTranslationState(
  value: unknown,
  source: CaptureTranslationSource
): value is CaptureTranslationState {
  if (
    !object(value) ||
    !object(value.source) ||
    value.source.capture_id !== source.captureId ||
    value.source.record_id !== source.recordId ||
    !positive(value.source.revision) ||
    !oneOf(value.source.status, [
      'preparing',
      'recording',
      'paused',
      'interrupted',
      'stopping',
      'stopped',
    ]) ||
    !['available', 'can_start', 'can_stop', 'can_save_translations'].every(
      (key) => typeof value[key] === 'boolean'
    ) ||
    !(
      value.current === null ||
      isTranslationRun(value.current, source.captureId)
    )
  )
    return false
  const run = value.current as CaptureTranslationRun | null
  if (
    run &&
    (run.source_revision > value.source.revision ||
      (activeRun(run) &&
        (run.source_revision !== value.source.revision ||
          value.source.status !== 'recording')))
  )
    return false
  return (
    (!value.can_start ||
      (value.available === true &&
        value.source.status === 'recording' &&
        !activeRun(run))) &&
    (!value.can_stop ||
      (!!run && ['starting', 'translating'].includes(run.status)))
  )
}
export function isTranslationReceipt(
  value: unknown,
  source: CaptureTranslationSource,
  intent: SummaryIntent<CaptureTranslationPayload>
): value is CaptureTranslationReceipt {
  if (
    !object(value) ||
    typeof value.replayed !== 'boolean' ||
    !object(value.command) ||
    value.command.key !== intent.key ||
    value.command.capture_id !== source.captureId ||
    !isCaptureTranslationPayload(value.command.payload, source.deviceId) ||
    !isTranslationRun(value.command.result, source.captureId) ||
    !isTranslationState(value.current, source)
  )
    return false
  const payload = value.command.payload
  if (
    payload.operation !== intent.payload.operation ||
    payload.expected_revision !== intent.payload.expected_revision ||
    payload.expected_run_id !== intent.payload.expected_run_id ||
    !(payload.configuration && intent.payload.configuration
      ? sameChoice(payload.configuration, intent.payload.configuration)
      : payload.configuration === intent.payload.configuration)
  )
    return false
  const result = value.command.result
  if (
    payload.operation === 'start'
      ? result.status !== 'starting' ||
        result.id === payload.expected_run_id ||
        result.source_revision !== payload.expected_revision ||
        !sameChoice(result.configuration, payload.configuration!)
      : result.id !== payload.expected_run_id ||
        !['stopping', 'stopped'].includes(result.status)
  )
    return false
  const current = value.current.current
  return (
    !!current &&
    current.generation >= result.generation &&
    (current.id === result.id
      ? current.generation === result.generation &&
        current.source_revision === result.source_revision &&
        sameConfiguration(current.configuration, result.configuration)
      : current.generation > result.generation)
  )
}
export function isTranslationTicket(
  value: unknown,
  source: CaptureTranslationSource,
  run: CaptureTranslationRun
): value is CaptureTranslationTicket {
  if (
    !object(value) ||
    !object(value.source) ||
    typeof value.ticket !== 'string' ||
    !value.ticket ||
    value.ticket.length > 4096 ||
    !date(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.now() ||
    Date.parse(value.expires_at) > Date.now() + 32000 ||
    typeof value.gateway_url !== 'string'
  )
    return false
  try {
    const url = new URL(value.gateway_url)
    if (
      url.protocol !== 'wss:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/capture-translation'
    )
      return false
  } catch {
    return false
  }
  return (
    value.source.run_id === run.id &&
    value.source.capture_id === source.captureId &&
    value.source.user_id === source.viewerId &&
    value.source.device_id === source.deviceId &&
    value.source.generation === run.generation &&
    value.source.source_revision === run.source_revision
  )
}

/** Current-source checks surround every awaited operation; 2xx alone never resolves intent. */
export function captureTranslationApi(
  source: CaptureTranslationSource,
  isCurrent: () => boolean,
  signal: AbortSignal
) {
  if (
    ![
      source.viewerId,
      source.captureId,
      source.recordId,
      source.leaseKey,
    ].every(uuid)
  )
    throw new Error('invalid_translation_source')
  const root = `capture-sessions/${source.captureId}/translation/`
  const request = async (path: string, body?: object) => {
    if (!isCurrent()) throw new Error('translation_source_changed')
    const result = await fetchApi<unknown>(root + path, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      cache: 'no-store',
      redirect: 'error',
      ...(body
        ? {
            method: 'POST',
            headers: { 'X-Capture-Lease': source.leaseKey },
            body: JSON.stringify(body),
          }
        : {}),
    })
    if (!isCurrent()) throw new Error('translation_source_changed')
    return result
  }
  return {
    read: async () => {
      const result = await request('')
      if (!isTranslationState(result, source))
        throw new Error('invalid_translation_state')
      return result
    },
    control: async (intent: SummaryIntent<CaptureTranslationPayload>) => {
      if (
        !uuid(intent.key) ||
        !isCaptureTranslationPayload(intent.payload, source.deviceId)
      )
        throw new Error('invalid_translation_intent')
      const result = await request('', { ...intent.payload, key: intent.key })
      if (!isTranslationReceipt(result, source, intent))
        throw new Error('invalid_translation_receipt')
      return result
    },
    ticket: async (run: CaptureTranslationRun) => {
      const result = await request('ticket/', {
        device_id: source.deviceId,
        run_id: run.id,
        generation: run.generation,
      })
      if (!isTranslationTicket(result, source, run))
        throw new Error('invalid_translation_ticket')
      return result
    },
  }
}

export type InterpretationLanguage = 'zh' | 'en'
export interface InterpretationChannel {
  id: string
  generation: number
  target: InterpretationLanguage
  state:
    | 'prepared'
    | 'starting'
    | 'translating'
    | 'stopping'
    | 'stopped'
    | 'incomplete'
  error_code: string
  archive_record_id?: string | null
}
export interface InterpretationSubscription {
  id: string
  channel_id: string
  participation_id: string
  revision: number
  active: boolean
  expires_at: string
  remaining_lease_seconds: number
}
export interface InterpretationStatus {
  available: boolean
  can_control: boolean
  languages: InterpretationLanguage[]
  channels: InterpretationChannel[]
  connections: { id: string; participant_sid: string }[]
  subscriptions: InterpretationSubscription[]
  listener_lease_seconds: number
  archive_available?: boolean
}
export interface InterpretationEvent {
  type: 'ready' | 'target_candidate' | 'target_final'
  channel_id: string
  generation: number
  target: InterpretationLanguage
  subscription_id: string
  subscription_revision: number
  source_participation_id: string
  source_participant_sid: string
  audio_track_sid: string
  response_id?: string
  item_id?: string
  text?: string
  stash?: string
}
export interface InterpretationRow {
  id: string
  sourceSid: string
  text: string
  stash: string
  final: boolean
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value
  ) &&
  value !== '00000000-0000-0000-0000-000000000000'
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128

export const isInterpretationAgent = (identity: string) =>
  identity.startsWith('interpretation-')

/** Start the deadline at request dispatch, never at a delayed response's arrival. */
export function interpretationDeadline(
  subscription: InterpretationSubscription,
  requestStartedAt: number
) {
  const seconds = subscription.remaining_lease_seconds
  return subscription.active &&
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= 20
    ? requestStartedAt + seconds * 1000
    : 0
}

export function decodeInterpretationEvent(
  payload: Uint8Array,
  sender: { identity: string; isAgent: boolean } | undefined,
  channel: InterpretationChannel,
  subscription: InterpretationSubscription
): InterpretationEvent | undefined {
  if (
    payload.byteLength > 14000 ||
    !sender?.isAgent ||
    !sender.identity.startsWith(`interpretation-${channel.id}-`) ||
    !['translating', 'stopping'].includes(channel.state) ||
    !subscription.active ||
    subscription.channel_id !== channel.id
  )
    return
  try {
    const data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payload)
    )
    if (
      !data ||
      data.channel_id !== channel.id ||
      data.generation !== channel.generation ||
      data.target !== channel.target ||
      data.subscription_id !== subscription.id ||
      data.subscription_revision !== subscription.revision ||
      !uuid(data.source_participation_id) ||
      typeof data.source_participant_sid !== 'string' ||
      !/^PA_[A-Za-z0-9_-]{1,61}$/.test(data.source_participant_sid) ||
      typeof data.audio_track_sid !== 'string' ||
      !/^TR_[A-Za-z0-9_-]{1,61}$/.test(data.audio_track_sid)
    )
      return
    if (data.type === 'ready') return data
    if (
      !['target_candidate', 'target_final'].includes(data.type) ||
      !identity(data.response_id) ||
      !identity(data.item_id) ||
      typeof data.text !== 'string' ||
      data.text.length > 20000 ||
      (data.stash !== undefined &&
        (typeof data.stash !== 'string' || data.stash.length > 20000))
    )
      return
    return data
  } catch {
    return
  }
}

export function updateInterpretationRows(
  rows: InterpretationRow[],
  event: InterpretationEvent
) {
  if (event.type === 'ready') return rows
  const id = `${event.source_participation_id}:${event.response_id}:${event.item_id}`
  const existing = rows.find((row) => row.id === id)
  if (existing?.final) return rows
  const row = {
    id,
    sourceSid: event.source_participant_sid,
    text: event.text!,
    stash: event.stash ?? '',
    final: event.type === 'target_final',
  }
  return (
    existing ? rows.map((old) => (old.id === id ? row : old)) : [...rows, row]
  ).slice(-60)
}

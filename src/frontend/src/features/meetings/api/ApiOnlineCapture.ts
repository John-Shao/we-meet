export interface CaptureRun {
  id: string
  record_id: string
  state: 'starting' | 'recording' | 'stopping' | 'stopped' | 'incomplete'
  error_code: string
  coverage: 'unverified'
  started_at: string | null
  ended_at: string | null
}
export interface CaptureState {
  available: boolean
  can_control: boolean
  current: CaptureRun | null
}
export interface CapturePayload {
  room_id: string
  livekit_room_sid: string
  operation: 'start' | 'stop'
  expected_run_id: string | null
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const date = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value)))
export const isCaptureSource = (room: string, sid: string) =>
  uuid(room) && /^RM_[A-Za-z0-9_-]{1,61}$/.test(sid)
export const isCapturePayload = (
  value: unknown,
  room: string,
  sid: string
): value is CapturePayload =>
  object(value) &&
  isCaptureSource(room, sid) &&
  Object.keys(value).every((key) =>
    ['room_id', 'livekit_room_sid', 'operation', 'expected_run_id'].includes(
      key
    )
  ) &&
  value.room_id === room &&
  value.livekit_room_sid === sid &&
  (value.operation === 'start' ||
    (value.operation === 'stop' && uuid(value.expected_run_id))) &&
  (value.expected_run_id === null || uuid(value.expected_run_id))
const isRun = (value: unknown): value is CaptureRun =>
  object(value) &&
  uuid(value.id) &&
  uuid(value.record_id) &&
  ['starting', 'recording', 'stopping', 'stopped', 'incomplete'].includes(
    String(value.state)
  ) &&
  typeof value.error_code === 'string' &&
  value.error_code.length <= 128 &&
  value.coverage === 'unverified' &&
  date(value.started_at) &&
  date(value.ended_at) &&
  (value.started_at === null ||
    value.ended_at === null ||
    Date.parse(value.started_at) <= Date.parse(value.ended_at))
export const isCaptureState = (value: unknown): value is CaptureState =>
  object(value) &&
  typeof value.available === 'boolean' &&
  typeof value.can_control === 'boolean' &&
  (value.current === null || isRun(value.current))
export const isCaptureReceipt = (
  value: unknown,
  payload: CapturePayload
): boolean => {
  if (
    !object(value) ||
    typeof value.replayed !== 'boolean' ||
    !isRun(value.result) ||
    !(value.current === null || isRun(value.current))
  )
    return false
  if (
    value.current !== null &&
    value.current.record_id !== value.result.record_id
  )
    return false
  return payload.operation === 'start'
    ? value.result.state === 'starting' &&
        value.result.id !== payload.expected_run_id
    : value.result.id === payload.expected_run_id &&
        ['stopping', 'stopped', 'incomplete'].includes(value.result.state)
}

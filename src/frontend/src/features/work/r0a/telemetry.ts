import { WorkApiError } from './api/client'

/**
 * D5 §10 telemetry: the nine Work events, and nothing else.
 *
 * The section names the events and the payload rule ("only org/subject/task/run
 * ids, state, duration and error code; never goal/background/body/title text") but
 * leaves the destination unadjudicated, so this module owns the shape and stays
 * sink-less until a destination is signed off. Wiring the call sites now is what
 * makes the content-free rule executable rather than a promise in a document;
 * swapping the transport later only replaces the sink.
 */
export const WORK_EVENTS = [
  'work_r0a_home_view',
  'composer_preview',
  'task_submit',
  'task_accept',
  'artifact_save',
  'task_retry',
  'task_cancel',
  'sse_resync',
  'inbox_open',
] as const

export type WorkEventName = (typeof WORK_EVENTS)[number]

export type WorkEventProps = {
  orgId?: string
  subjectId?: string
  taskId?: string
  runId?: string
  artifactId?: string
  state?: string
  displayState?: string
  errorCode?: string
  durationMs?: number
}

export type WorkEventPayload = Record<string, string | number>

export type WorkTelemetrySink = (
  name: WorkEventName,
  payload: WorkEventPayload
) => void

// Snake_case on the wire, so the payload reads the same as the design text and as
// any hosted analytics property.
const WORK_EVENT_KEYS: Record<keyof WorkEventProps, string> = {
  orgId: 'org_id',
  subjectId: 'subject_id',
  taskId: 'task_id',
  runId: 'run_id',
  artifactId: 'artifact_id',
  state: 'state',
  displayState: 'display_state',
  errorCode: 'error_code',
  durationMs: 'duration_ms',
}

// A state or code field is a short enum. Length is the only property that a caller
// can accidentally turn into prose, so it is bounded instead of trusted.
const MAX_EVENT_VALUE_LENGTH = 120

export const sanitizeWorkEvent = (props: WorkEventProps): WorkEventPayload => {
  const payload: WorkEventPayload = {}
  for (const [key, wireName] of Object.entries(WORK_EVENT_KEYS)) {
    const value = props[key as keyof WorkEventProps]
    if (value === undefined || value === null) continue
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) {
        payload[wireName] = Math.round(value)
      }
      continue
    }
    const text = String(value)
    if (text.length === 0 || text.length > MAX_EVENT_VALUE_LENGTH) continue
    payload[wireName] = text
  }
  return payload
}

/**
 * D5 §10:308 aggregates failures by code and counts unknown separately, so the code -
 * never the message, which can carry task prose - is what reaches the sink.
 */
export const workErrorCode = (error: unknown): string =>
  error instanceof WorkApiError ? error.code : 'unknown'

let sink: WorkTelemetrySink | null = null

export const setWorkTelemetrySink = (next: WorkTelemetrySink | null): void => {
  sink = next
}

/**
 * Returns whether the event reached a sink. With no sink configured the call is a
 * no-op by design: the absence of an adjudicated destination must not silently
 * become an outbound request, and must not throw into a user action either.
 */
export const trackWorkEvent = (
  name: WorkEventName,
  props: WorkEventProps = {}
): boolean => {
  if (!sink) return false
  sink(name, sanitizeWorkEvent(props))
  return true
}

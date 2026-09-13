import type {
  ApiSummaryRequest,
  SummaryRequestPayload,
} from './ApiMeetingRecord'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const errorCode = (value: unknown) =>
  typeof value === 'string' && value.length <= 512

/** A malformed 2xx has an unknown outcome; never discard its durable intent. */
export function summaryReceipt(
  value: unknown,
  payload: SummaryRequestPayload
): ApiSummaryRequest {
  if (!object(value)) throw new Error('invalid_summary_receipt')
  const job = value.job
  if (
    !uuid(value.request_id) ||
    typeof value.replayed !== 'boolean' ||
    typeof value.dispatch_state !== 'string' ||
    !['pending', 'sent', 'abandoned'].includes(value.dispatch_state) ||
    !object(job) ||
    !uuid(job.id) ||
    typeof job.status !== 'string' ||
    ![
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
      'canceled',
    ].includes(job.status) ||
    !integer(job.attempt, 1) ||
    !integer(job.generation, 1) ||
    !integer(job.input_revision, 1) ||
    typeof job.retryable !== 'boolean' ||
    typeof job.dispatch_pending !== 'boolean' ||
    !errorCode(job.error_code) ||
    typeof job.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(job.updated_at)) ||
    (job.stage ?? 'final') !== (payload.stage ?? 'final')
  )
    throw new Error('invalid_summary_receipt')
  const progress = job.chunk_progress
  if (
    progress != null &&
    (!object(progress) ||
      !integer(progress.completed, 0) ||
      !integer(progress.total, 0) ||
      Number(progress.completed) > Number(progress.total) ||
      Number(progress.total) > 32)
  ) {
    throw new Error('invalid_summary_receipt')
  }
  return value as unknown as ApiSummaryRequest
}

interface AutomationState {
  revision: number
  enabled: boolean
  state: 'off' | 'waiting' | 'generating' | 'completed' | 'needs_attention'
  error_code: string
}
const automationState = (value: unknown): value is AutomationState =>
  object(value) &&
  integer(value.revision, 0) &&
  typeof value.enabled === 'boolean' &&
  typeof value.state === 'string' &&
  ['off', 'waiting', 'generating', 'completed', 'needs_attention'].includes(
    value.state
  ) &&
  errorCode(value.error_code)

export function automationReceipt(
  value: unknown,
  payload: { enabled: boolean; expected_revision: number }
) {
  if (
    !object(value) ||
    !uuid(value.command_id) ||
    typeof value.replayed !== 'boolean' ||
    !automationState(value.result) ||
    !automationState(value.current) ||
    value.result.enabled !== payload.enabled ||
    value.result.revision !== payload.expected_revision + 1 ||
    value.current.revision < value.result.revision
  ) {
    throw new Error('invalid_automation_receipt')
  }
  // The frozen command result can differ from a newer current consent state.
  return value
}

import type { CaptureAudioRetention } from '../api/ApiCaptureSession'
import type { LocalCapture } from './journal'

const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))

export function isAudioRetention(
  value: unknown
): value is CaptureAudioRetention {
  if (!value || typeof value !== 'object') return false
  const row = value as CaptureAudioRetention
  if (
    !['media', 'text'].includes(row.mode) ||
    typeof row.expired !== 'boolean' ||
    !['not_started', 'pending', 'failed', 'complete'].includes(
      row.cleanup_status
    ) ||
    typeof row.cleanup_error !== 'string' ||
    row.cleanup_error.length > 64 ||
    (row.deleted_at !== null && !date(row.deleted_at)) ||
    (row.cleanup_status === 'complete') !== (row.deleted_at !== null)
  )
    return false
  if (row.mode === 'media')
    return (
      row.temporary_until === null && row.retry_until === null && !row.expired
    )
  return (
    date(row.temporary_until) &&
    date(row.retry_until) &&
    Date.parse(row.retry_until) <= Date.parse(row.temporary_until)
  )
}

/** Local wall-clock limit may shorten, but never extend, the server deadline. */
export function textAudioExpired(local: LocalCapture, now = Date.now()) {
  if (local.create.retention_mode !== 'text') return false
  const localDeadline = Date.parse(local.createdAt) + 24 * 60 * 60 * 1000
  const retention = local.remote?.audio_retention
  if (!Number.isFinite(localDeadline)) return true
  if (!local.remote) return now >= localDeadline
  if (!isAudioRetention(retention) || retention.mode !== 'text') return true
  return (
    retention.expired ||
    retention.cleanup_status !== 'not_started' ||
    now >= Math.min(localDeadline, Date.parse(retention.temporary_until!))
  )
}

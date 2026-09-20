import type { ApiMeetingRecord } from './api/ApiMeetingRecord'

export const validMediaDuration = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 43_200_000

export function mediaDuration(
  record: ApiMeetingRecord,
  playerDuration?: number | null
) {
  if (
    record.source_type === 'upload' &&
    record.capabilities.play_media &&
    validMediaDuration(playerDuration)
  )
    return playerDuration
  const timing = record.media_timing
  return timing &&
    ['original_audio', 'saved_audio'].includes(timing.basis) &&
    validMediaDuration(timing.duration_ms)
    ? timing.duration_ms
    : undefined
}

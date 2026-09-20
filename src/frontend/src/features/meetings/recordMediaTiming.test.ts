import { expect, it } from 'vitest'
import type { ApiMeetingRecord } from './api/ApiMeetingRecord'
import { mediaDuration, validMediaDuration } from './recordMediaTiming'

const record = {
  source_type: 'upload',
  capabilities: { play_media: true },
} as ApiMeetingRecord
it('uses prepared media metadata and rejects unknown or partial lengths', () => {
  expect(mediaDuration(record)).toBeUndefined()
  expect(mediaDuration(record, 5000)).toBe(5000)
  const partial = {
    ...record,
    media_timing: {
      basis: 'partial_audio',
      duration_ms: 2000,
      saved_duration_ms: 2000,
    },
  }
  expect(mediaDuration(partial)).toBeUndefined()
  expect(
    mediaDuration({
      ...partial,
      media_timing: { ...partial.media_timing, basis: 'saved_audio' },
    })
  ).toBe(2000)
  expect(
    mediaDuration(
      {
        ...record,
        capabilities: { ...record.capabilities, play_media: false },
      },
      5000
    )
  ).toBeUndefined()
})
it.each([null, undefined, 0, -1, NaN, Infinity, 1.5, 43_200_001, '5000'])(
  'rejects unusable duration %s',
  (value) => {
    expect(validMediaDuration(value)).toBe(false)
  }
)

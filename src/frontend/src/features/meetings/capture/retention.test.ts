import { describe, expect, it } from 'vitest'
import type { CaptureAudioRetention } from '../api/ApiCaptureSession'
import type { LocalCapture } from './journal'
import { isAudioRetention, textAudioExpired } from './retention'

const retained: CaptureAudioRetention = {
  mode: 'text',
  temporary_until: '2026-09-14T10:00:00Z',
  retry_until: '2026-09-13T12:30:00Z',
  expired: false,
  cleanup_status: 'not_started',
  cleanup_error: '',
  deleted_at: null,
}
const local = (retention: unknown) =>
  ({
    createdAt: '2026-09-13T10:00:00Z',
    create: { retention_mode: 'text' },
    remote: { audio_retention: retention },
  }) as LocalCapture

describe('temporary capture audio contract', () => {
  it('accepts separate retry and hard deadlines', () => {
    expect(isAudioRetention(retained)).toBe(true)
    expect(
      textAudioExpired(local(retained), Date.parse(retained.retry_until!))
    ).toBe(false)
    expect(
      textAudioExpired(local(retained), Date.parse(retained.temporary_until!))
    ).toBe(true)
  })
  it.each([
    undefined,
    {},
    { ...retained, mode: 'unknown' },
    { ...retained, retry_until: '2026-09-15T10:00:00Z' },
    { ...retained, temporary_until: null },
    { ...retained, expired: 'false' },
    { ...retained, deleted_at: '2026-09-13T14:00:00Z' },
    { ...retained, cleanup_status: 'complete' },
    { ...retained, cleanup_status: 'invalid' },
    { ...retained, temporary_until: '2026-09-14' },
  ])('rejects malformed text-audio state %j', (value) => {
    expect(isAudioRetention(value)).toBe(false)
    expect(
      textAudioExpired(local(value), Date.parse('2026-09-13T11:00:00Z'))
    ).toBe(true)
  })
  it('cleanup enrollment stops local audio even while remote deletion retries', () => {
    expect(
      textAudioExpired(
        local({
          ...retained,
          cleanup_status: 'failed',
          cleanup_error: 'storage_unavailable',
        }),
        Date.parse('2026-09-13T11:00:00Z')
      )
    ).toBe(true)
  })
  it('cannot extend the earlier local bound using a later server date', () => {
    expect(
      textAudioExpired(
        local({ ...retained, temporary_until: '2026-09-15T10:00:00Z' }),
        Date.parse('2026-09-14T10:00:00Z')
      )
    ).toBe(true)
  })
  it('does not apply a temporary deadline to media retention', () => {
    const capture = local(retained)
    capture.create.retention_mode = 'media'
    expect(textAudioExpired(capture, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

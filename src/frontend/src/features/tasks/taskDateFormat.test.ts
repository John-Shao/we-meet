import { describe, expect, it } from 'vitest'

import { formatTaskCreatedAt, formatTaskDate } from './taskDateFormat'

describe('task date formatting', () => {
  it('hides the year for start and due dates', () => {
    expect(formatTaskDate('2026-08-27', 'en-US')).toBe('Aug 27')
  })

  it('uses an ISO 8601 date for task creation timestamps', () => {
    const localTimestamp = new Date(2026, 7, 27, 14, 5).toISOString()

    expect(formatTaskCreatedAt(localTimestamp)).toBe('2026-08-27 14:05')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import { deleteCalendarEvent, transferCalendarEvent } from './fetchCalendar'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))

describe('deleteCalendarEvent', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset().mockResolvedValue(undefined)
  })

  it.each(['one', 'following', 'all'] as const)(
    'sends the explicit %s recurrence scope',
    async (scope) => {
      await deleteCalendarEvent('event/id', scope)

      expect(fetchApi).toHaveBeenCalledWith(
        `/calendar-events/event%2Fid/?scope=${scope}`,
        { method: 'DELETE' }
      )
    }
  )
})

describe('transferCalendarEvent', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset().mockResolvedValue({ id: 'event/id' })
  })

  it('posts the new organizer and original-organizer retention choice', async () => {
    await transferCalendarEvent('event/id', 'new-owner', false)

    expect(fetchApi).toHaveBeenCalledWith(
      '/calendar-events/event%2Fid/transfer/',
      {
        method: 'POST',
        body: JSON.stringify({
          new_organizer_id: 'new-owner',
          keep_original_organizer: false,
        }),
      }
    )
  })
})

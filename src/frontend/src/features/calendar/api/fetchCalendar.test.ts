import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import { deleteCalendarEvent } from './fetchCalendar'

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

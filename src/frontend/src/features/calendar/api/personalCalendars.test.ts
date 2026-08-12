import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchApi } from '@/api/fetchApi'

import {
  fetchPersonalCalendarEvents,
  saveCalendarGrant,
  subscribeCalendar,
  updatePersonalCalendar,
} from './personalCalendars'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))

describe('personal calendar sharing API', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset().mockResolvedValue(undefined)
  })

  it('updates the organization default permission explicitly', async () => {
    await updatePersonalCalendar('calendar/id', 'details')

    expect(fetchApi).toHaveBeenCalledWith(
      '/personal-calendars/calendar%2Fid/',
      {
        method: 'PATCH',
        body: JSON.stringify({ organization_default_access: 'details' }),
      }
    )
  })

  it('creates an explicit grant for a real account id', async () => {
    await saveCalendarGrant('user-1', 'free_busy')

    expect(fetchApi).toHaveBeenCalledWith('/calendar-access-grants/', {
      method: 'POST',
      body: JSON.stringify({
        grantee_user_id: 'user-1',
        permission: 'free_busy',
      }),
    })
  })

  it('keeps subscription separate from authorization', async () => {
    await subscribeCalendar('owner-1')

    expect(fetchApi).toHaveBeenCalledWith('/calendar-subscriptions/', {
      method: 'POST',
      body: JSON.stringify({ owner_user_id: 'owner-1' }),
    })
  })

  it('requests the subscribed calendar within the visible window', async () => {
    await fetchPersonalCalendarEvents('calendar/id', {
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-09-01T00:00:00.000Z',
    })

    expect(fetchApi).toHaveBeenCalledWith(
      '/personal-calendars/calendar%2Fid/events/?start=2026-08-01T00%3A00%3A00.000Z&end=2026-09-01T00%3A00%3A00.000Z'
    )
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnifiedCalendar } from '../api/calendars'
import { CalendarListManager } from './CalendarListManager'

const calendarApi = vi.hoisted(() => ({
  fetchCalendars: vi.fn(),
  setCalendarSubscription: vi.fn(),
  unsubscribeUnifiedCalendar: vi.fn(),
}))

vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({
    data: {
      calendar: {
        enabled: true,
        sharing_enabled: false,
        export_enabled: false,
      },
    },
  }),
}))

vi.mock('../api/calendars', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/calendars')>()),
  ...calendarApi,
}))

const managedCalendar: UnifiedCalendar = {
  id: 'calendar-1',
  kind: 'primary',
  name: 'work',
  display_name: 'Work',
  description: '',
  owner: null,
  meeting_room: null,
  organization_default_access: 'none',
  effective_role: 'admin',
  effective_permission: 'details',
  subscribed: true,
  enabled: true,
  color: '#3370ff',
  subscriber_count: 1,
  capabilities: {
    can_write: true,
    can_manage: true,
    can_share: false,
    can_export: false,
    can_delete: true,
  },
  deleted_at: null,
}

const renderManager = () => {
  calendarApi.fetchCalendars.mockResolvedValue([managedCalendar])
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <CalendarListManager onChanged={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('CalendarListManager menu', () => {
  it('closes on outside click and Escape', async () => {
    renderManager()
    const trigger = await screen.findByRole('button', { name: /Work/ })

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

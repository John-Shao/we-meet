import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnifiedCalendar } from '../api/calendars'
import { AddCalendarDialog } from './CalendarManagementDialogs'

const calendarApi = vi.hoisted(() => ({
  discoverCalendars: vi.fn(),
}))

vi.mock('../api/calendars', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/calendars')>()),
  ...calendarApi,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'unit.people' ? `${options?.count} people` : key,
  }),
}))

const roomCalendar: UnifiedCalendar = {
  id: 'calendar-room-1',
  kind: 'resource',
  name: 'Overlook',
  display_name: 'Overlook',
  description: '',
  owner: null,
  meeting_room: {
    id: 'room-1',
    name: 'Overlook',
    code: '1602',
    floor: '16F',
    capacity: 100,
    description: '',
    node: { id: 'building-1', name: 'Tencent Tower' },
    path_label: 'Shenzhen · Tencent Tower · 16F',
    timezone: 'Asia/Shanghai',
    facilities: [
      { id: 'facility-tv', code: 'tv', name: 'TV' },
      { id: 'facility-board', code: 'whiteboard', name: 'Whiteboard' },
      { id: 'facility-projector', code: 'projector', name: 'Projector' },
    ],
    is_active: true,
    requires_approval: false,
  },
  organization_default_access: 'free_busy',
  effective_role: 'free_busy',
  effective_permission: 'free_busy',
  subscribed: false,
  enabled: false,
  color: '#3370ff',
  subscriber_count: 0,
  capabilities: {
    can_write: false,
    can_manage: false,
    can_share: false,
    can_export: false,
    can_delete: false,
  },
  deleted_at: null,
}

describe('AddCalendarDialog room discovery', () => {
  it('uses the same room identity and resource summary as the timeline', async () => {
    calendarApi.discoverCalendars.mockImplementation((type: string) =>
      Promise.resolve(type === 'room' ? [roomCalendar] : [])
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: '会议室' }))
    expect(
      await screen.findByText('Tencent Tower-1602 (Overlook)')
    ).toBeVisible()
    expect(screen.getByText('100 people · TV · Whiteboard')).toBeVisible()
    expect(screen.queryByText('Projector')).not.toBeInTheDocument()
  })

  it('does not blank the page when the server still returns identity-only rooms', async () => {
    const legacyCalendar: UnifiedCalendar = {
      ...roomCalendar,
      meeting_room: { id: 'room-1', name: 'Overlook', code: '1602' },
    }
    calendarApi.discoverCalendars.mockImplementation((type: string) =>
      Promise.resolve(type === 'room' ? [legacyCalendar] : [])
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: '会议室' }))
    expect(await screen.findByText('1602 (Overlook)')).toBeVisible()
    expect(screen.getByRole('button', { name: '订阅' })).toBeEnabled()
  })
})

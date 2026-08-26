import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnifiedCalendar } from '../api/calendars'
import {
  AddCalendarDialog,
  CalendarSettingsDialog,
} from './CalendarManagementDialogs'

const calendarApi = vi.hoisted(() => ({
  createCalendar: vi.fn(),
  discoverCalendars: vi.fn(),
  fetchCalendarMembers: vi.fn(),
  setCalendarSubscription: vi.fn(),
  unsubscribeUnifiedCalendar: vi.fn(),
}))

vi.mock('./BulkAttendeeDialog', () => ({
  BulkAttendeeDialog: ({
    title,
    onConfirm,
  }: {
    title: string
    onConfirm: (
      selected: Map<string, string>,
      avatars: Map<string, string>
    ) => void
  }) => (
    <div role="dialog" aria-label={title}>
      <button
        type="button"
        onClick={() =>
          onConfirm(
            new Map([['member-alice', 'Alice']]),
            new Map([['member-alice', '/media/avatars/alice.jpg']])
          )
        }
      >
        确认选择共享人
      </button>
    </div>
  ),
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

describe('AddCalendarDialog calendar discovery', () => {
  it('closes the preset color palette without closing the calendar form', async () => {
    calendarApi.discoverCalendars.mockResolvedValue([])
    const onClose = vi.fn()
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={onClose} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'manage.tabCreate' }))
    fireEvent.click(screen.getByRole('button', { name: 'manage.color' }))
    const palette = await screen.findByRole('radiogroup', {
      name: 'color.pickerTitle',
    })

    fireEvent.keyDown(palette, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('radiogroup', { name: 'color.pickerTitle' })
      ).toBeNull()
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens the shared people picker and keeps per-person roles in the create payload', async () => {
    calendarApi.discoverCalendars.mockResolvedValue([])
    calendarApi.createCalendar.mockResolvedValue(undefined)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const { container } = render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'manage.tabCreate' }))
    expect(screen.getByText('manage.sharedMembers')).toBeVisible()
    expect(
      screen.queryByRole('dialog', { name: 'manage.addSharedMember' })
    ).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'manage.addSharedMember' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '确认选择共享人' })
    )
    expect(screen.getByText('Alice')).toBeVisible()
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/media/avatars/alice.jpg'
    )

    fireEvent.change(screen.getByLabelText('manage.name'), {
      target: { value: 'Team calendar' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'manage.save' }))

    await waitFor(() =>
      expect(calendarApi.createCalendar).toHaveBeenCalledWith({
        name: 'Team calendar',
        description: '',
        color: '#3370ff',
        organization_default_access: 'details',
        members: [{ user_id: 'member-alice', role: 'details' }],
      })
    )
  })

  it('shows member avatars in calendar settings', async () => {
    calendarApi.fetchCalendarMembers.mockResolvedValue([
      {
        id: 'grant-ting',
        user: {
          id: 'member-ting',
          full_name: 'Ting',
          avatar_url: '/media/avatars/ting.jpg',
        },
        role: 'details',
        external: false,
      },
    ])
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const manageableCalendar: UnifiedCalendar = {
      ...roomCalendar,
      kind: 'shared',
      meeting_room: null,
      capabilities: { ...roomCalendar.capabilities, can_manage: true },
    }

    const { container } = render(
      <QueryClientProvider client={client}>
        <CalendarSettingsDialog
          calendar={manageableCalendar}
          onClose={vi.fn()}
          onChanged={vi.fn()}
        />
      </QueryClientProvider>
    )

    expect(await screen.findByText('Ting')).toBeVisible()
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/media/avatars/ting.jpg'
    )
  })

  it('uses the directory avatar and profile details for contact rows', async () => {
    const contactCalendar: UnifiedCalendar = {
      ...roomCalendar,
      id: 'calendar-contact-profile',
      kind: 'primary',
      name: 'Ting',
      display_name: 'Ting',
      owner: {
        id: 'contact-1',
        full_name: 'Ting',
        avatar_url: '/media/avatars/ting.jpg',
        title: 'Designer',
        department: { id: 'department-1', name: 'Product' },
      },
      meeting_room: null,
    }
    calendarApi.discoverCalendars.mockImplementation((type: string) =>
      Promise.resolve(type === 'contact' ? [contactCalendar] : [])
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const { container } = render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    expect(await screen.findByText('Ting')).toBeVisible()
    expect(screen.getByText('Designer · Product')).toBeVisible()
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/media/avatars/ting.jpg'
    )
  })

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

    fireEvent.click(screen.getByRole('button', { name: 'manage.discoverRoom' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'manage.discoverRoom' }))
    expect(await screen.findByText('1602 (Overlook)')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'manage.subscribe' })
    ).toBeEnabled()
  })

  it('keeps contact rows visible while adding a subscription', async () => {
    const contactCalendar: UnifiedCalendar = {
      ...roomCalendar,
      id: 'calendar-contact-1',
      kind: 'shared',
      name: 'Ting',
      display_name: 'Ting',
      meeting_room: null,
    }
    let contactRequestCount = 0
    let finishRefresh: ((rows: UnifiedCalendar[]) => void) | undefined
    calendarApi.discoverCalendars.mockImplementation((type: string) => {
      if (type !== 'contact') return Promise.resolve([])
      contactRequestCount += 1
      if (contactRequestCount === 1) return Promise.resolve([contactCalendar])
      return new Promise<UnifiedCalendar[]>((resolve) => {
        finishRefresh = resolve
      })
    })
    calendarApi.setCalendarSubscription.mockResolvedValue(undefined)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    expect(await screen.findByText('Ting')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'manage.subscribe' }))
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
    expect(screen.getByText('Ting')).toBeVisible()
    expect(screen.queryByText('manage.searching')).not.toBeInTheDocument()

    await act(async () => {
      finishRefresh?.([{ ...contactCalendar, subscribed: true, enabled: true }])
    })
    expect(
      await screen.findByRole('button', { name: 'manage.unsubscribe' })
    ).toBeEnabled()
  })

  it('keeps room rows visible while removing a subscription', async () => {
    const subscribedCalendar: UnifiedCalendar = {
      ...roomCalendar,
      subscribed: true,
      enabled: true,
    }
    let roomRequestCount = 0
    let finishRefresh: ((rows: UnifiedCalendar[]) => void) | undefined
    calendarApi.discoverCalendars.mockImplementation((type: string) => {
      if (type !== 'room') return Promise.resolve([])
      roomRequestCount += 1
      if (roomRequestCount === 1) return Promise.resolve([subscribedCalendar])
      return new Promise<UnifiedCalendar[]>((resolve) => {
        finishRefresh = resolve
      })
    })
    calendarApi.unsubscribeUnifiedCalendar.mockResolvedValue(undefined)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AddCalendarDialog onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'manage.discoverRoom' }))
    const unsubscribeButton = await screen.findByRole('button', {
      name: 'manage.unsubscribe',
    })
    expect(unsubscribeButton).toBeEnabled()
    fireEvent.click(unsubscribeButton)

    await waitFor(() =>
      expect(calendarApi.unsubscribeUnifiedCalendar).toHaveBeenCalledWith(
        subscribedCalendar.id
      )
    )
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
    expect(screen.getByText('Tencent Tower-1602 (Overlook)')).toBeVisible()
    expect(screen.queryByText('manage.searching')).not.toBeInTheDocument()

    await act(async () => {
      finishRefresh?.([
        { ...subscribedCalendar, subscribed: false, enabled: false },
      ])
    })
    expect(
      await screen.findByRole('button', { name: 'manage.subscribe' })
    ).toBeEnabled()
  })
})

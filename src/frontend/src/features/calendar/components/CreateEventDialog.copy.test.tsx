import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnifiedCalendar } from '../api/calendars'
import type { CalendarEvent } from '../api/ApiCalendar'
import { CreateEventDialog } from './CreateEventDialog'

const mocks = vi.hoisted(() => ({
  createCalendarEvent: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({
    user: {
      id: 'copy-user',
      full_name: 'Copy User',
      email: 'copy@example.com',
      avatar_url: '',
    },
  }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ alert: vi.fn() }),
}))

vi.mock('@/features/meeting-rooms', () => ({
  MeetingRoomField: () => <div data-testid="meeting-room-field" />,
}))

vi.mock('./AttendeePicker', () => ({
  AttendeePicker: () => <div data-testid="attendee-picker" />,
}))

vi.mock('../hooks/useCalendarSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useCalendarSettings')>()),
  useCalendarSettings: () => ({
    defaultDurationMin: 60,
    defaultReminderMin: 10,
    calendarTimezone: 'Asia/Shanghai',
  }),
}))

vi.mock('../api/fetchCalendar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/fetchCalendar')>()),
  createCalendarEvent: mocks.createCalendarEvent,
}))

const source: CalendarEvent = {
  id: 'source-event',
  title: 'Design review',
  description: 'Review the proposal',
  location: 'Online',
  attachment_names: ['proposal.pdf'],
  start_at: '2026-08-20T11:30:00Z',
  end_at: '2026-08-20T12:15:00Z',
  timezone: 'Asia/Shanghai',
  all_day: false,
  status: 'confirmed',
  visibility: 'private',
  reminders: [15],
  organizer: { id: 'old-organizer', full_name: 'Old Organizer' },
  room: 'old-video-room',
  room_slug: '12345678',
  meeting_room: {
    id: 'physical-room',
    name: 'Room A',
    code: 'A',
    floor: '3F',
    capacity: 8,
    node: { id: 'node', name: 'HQ' },
    path_label: 'HQ · 3F',
    timezone: 'Asia/Shanghai',
    booking_status: 'confirmed',
  },
  attendees: [
    {
      id: 'old-organizer',
      full_name: 'Old Organizer',
      email: 'old@example.com',
      role: 'organizer',
      rsvp: 'accepted',
    },
    {
      id: 'copy-user',
      full_name: 'Copy User',
      email: 'copy@example.com',
      role: 'required',
      rsvp: 'accepted',
    },
    {
      id: 'optional-user',
      full_name: 'Optional User',
      email: 'optional@example.com',
      role: 'optional',
      rsvp: 'tentative',
    },
  ],
  my_rsvp: 'accepted',
  created_at: '2026-08-01T00:00:00Z',
  recurrence: 'FREQ=WEEKLY',
  recurrence_parent: null,
  display_calendar_id: 'read-only-calendar',
}

const writableCalendar: UnifiedCalendar = {
  id: 'primary-calendar',
  kind: 'primary',
  name: 'My calendar',
  display_name: 'My calendar',
  description: '',
  owner: null,
  meeting_room: null,
  organization_default_access: 'free_busy',
  effective_role: 'admin',
  effective_permission: 'details',
  subscribed: true,
  enabled: true,
  color: '#3366ff',
  subscriber_count: 1,
  capabilities: {
    can_write: true,
    can_manage: true,
    can_share: true,
    can_export: true,
    can_delete: false,
  },
  deleted_at: null,
}

describe('CreateEventDialog copy mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createCalendarEvent.mockResolvedValue({ ...source, id: 'new-event' })
  })

  it('creates an independent one-off event from the visible source fields', async () => {
    render(
      <CreateEventDialog
        copyEvent={source}
        calendars={[writableCalendar]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    expect(screen.getByTestId('event-title')).toHaveValue('Design review')
    expect(screen.getByTestId('event-description')).toHaveValue(
      'Review the proposal'
    )
    expect(screen.getByTestId('event-repeat')).toHaveTextContent(
      'form.repeatNone'
    )

    fireEvent.click(screen.getByTestId('event-create'))

    await waitFor(() => expect(mocks.createCalendarEvent).toHaveBeenCalled())
    expect(mocks.createCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Design review',
        description: 'Review the proposal',
        calendar_id: 'primary-calendar',
        recurrence: '',
        visibility: 'private',
        reminders: [15],
        meeting_room_id: '',
        with_video_meeting: true,
        location: 'Online',
        attachment_names: ['proposal.pdf'],
        attendee_entries: [
          { user_id: 'old-organizer', role: 'required' },
          { user_id: 'optional-user', role: 'optional' },
        ],
      })
    )
    expect(mocks.createCalendarEvent.mock.calls[0][0]).not.toHaveProperty(
      'source_conversation_id'
    )
  })
})

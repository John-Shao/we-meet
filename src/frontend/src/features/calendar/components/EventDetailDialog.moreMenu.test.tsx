import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CalendarEvent } from '../api/ApiCalendar'
import { EventDetailDialog } from './EventDetailDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'organizer-1' } }),
}))

vi.mock('@/features/meetings/api/fetchMeeting', () => ({
  useMeetingSummary: () => ({ data: null }),
}))

vi.mock('../hooks/useCalendarSettings', () => ({
  useCalendarSettings: () => ({ calendarTimezone: 'UTC' }),
  effectiveReminder: () => null,
  reminderOptionLabel: () => '',
}))

const event: CalendarEvent = {
  id: 'event-1',
  title: 'Project sync',
  description: '',
  start_at: '2026-08-20T02:15:00Z',
  end_at: '2026-08-20T03:15:00Z',
  timezone: 'UTC',
  all_day: false,
  status: 'confirmed',
  visibility: 'default',
  reminders: [],
  organizer: { id: 'organizer-1', full_name: 'Owner' },
  room: null,
  room_slug: null,
  meeting_room: null,
  attendees: [],
  my_rsvp: 'accepted',
  created_at: '2026-08-01T00:00:00Z',
  recurrence: '',
  recurrence_parent: null,
}

const renderDialog = () => {
  const onCopy = vi.fn()
  const onTransfer = vi.fn()
  render(
    <EventDetailDialog
      event={event}
      onRsvp={vi.fn()}
      onJoin={vi.fn()}
      onClose={vi.fn()}
      canCopy
      onCopy={onCopy}
      canTransfer
      onTransfer={onTransfer}
    />
  )
  return { onCopy, onTransfer }
}

describe('EventDetailDialog more menu', () => {
  it('closes when clicking a blank area inside the event detail dialog', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('detail-more'))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('dialog'))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes when focus leaves the menu controls', () => {
    renderDialog()
    const moreButton = screen.getByTestId('detail-more')
    const closeButton = screen.getByTestId('detail-close')
    fireEvent.click(moreButton)

    fireEvent.blur(moreButton, { relatedTarget: closeButton })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps menu item actions working and closes after selection', () => {
    const { onCopy } = renderDialog()
    fireEvent.click(screen.getByTestId('detail-more'))

    fireEvent.click(screen.getByRole('menuitem', { name: 'copyEvent.action' }))

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('detail-more'))

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CalendarEvent, EditScope } from '../api/ApiCalendar'
import { EventDetailHost } from './EventDetailHost'

const mocks = vi.hoisted(() => ({
  fetchCalendarEvent: vi.fn(),
  fetchCalendars: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('wouter', () => ({
  useLocation: () => ['/meeting', mocks.navigate],
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'organizer-1' } }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ alert: vi.fn(), confirm: vi.fn() }),
}))

vi.mock('../api/fetchCalendar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/fetchCalendar')>()),
  fetchCalendarEvent: mocks.fetchCalendarEvent,
}))

vi.mock('../api/calendars', () => ({
  fetchCalendars: mocks.fetchCalendars,
}))

vi.mock('./EventDetailDialog', () => ({
  EventDetailDialog: ({
    onEdit,
    onCopy,
    canCopy,
  }: {
    onEdit?: () => void
    onCopy?: () => void
    canCopy?: boolean
  }) => (
    <>
      <button type="button" data-testid="detail-edit" onClick={onEdit}>
        edit
      </button>
      {canCopy && (
        <button type="button" data-testid="detail-copy" onClick={onCopy}>
          copy
        </button>
      )}
    </>
  ),
}))

vi.mock('./CreateEventDialog', () => ({
  CreateEventDialog: ({
    editEvent,
    copyEvent,
    editScope,
    onClose,
    onCreated,
  }: {
    editEvent?: CalendarEvent
    copyEvent?: CalendarEvent
    editScope?: EditScope
    onClose: () => void
    onCreated: (event: CalendarEvent) => void
  }) => (
    <div
      data-testid="event-editor"
      data-edit-scope={editScope ?? ''}
      data-mode={copyEvent ? 'copy' : 'edit'}
    >
      <span>{(editEvent ?? copyEvent)?.title}</span>
      <button type="button" onClick={onClose}>
        cancel
      </button>
      <button
        type="button"
        onClick={() => onCreated((editEvent ?? copyEvent)!)}
      >
        save
      </button>
    </div>
  ),
}))

vi.mock('./EditScopeDialog', () => ({
  EditScopeDialog: ({
    onClose,
    onConfirm,
  }: {
    onClose: () => void
    onConfirm: (scope: EditScope) => void
  }) => (
    <div data-testid="edit-scope-dialog">
      <button type="button" onClick={onClose}>
        cancel scope
      </button>
      <button type="button" onClick={() => onConfirm('following')}>
        confirm scope
      </button>
    </div>
  ),
}))

vi.mock('./EventShareDialog', () => ({
  EventShareDialog: () => null,
}))

const event: CalendarEvent = {
  id: 'event-1',
  title: 'Weekly sync',
  description: '',
  start_at: '2026-08-14T08:00:00Z',
  end_at: '2026-08-14T09:00:00Z',
  timezone: 'Asia/Shanghai',
  all_day: false,
  status: 'confirmed',
  visibility: 'default',
  reminders: [5],
  organizer: { id: 'organizer-1', full_name: 'Owner' },
  room: 'room-1',
  room_slug: '12345678',
  meeting_room: null,
  attendees: [],
  my_rsvp: 'accepted',
  created_at: '2026-08-01T00:00:00Z',
  recurrence: '',
  recurrence_parent: null,
}

const renderHost = (
  options: { editMode?: 'calendar' | 'inline'; value?: CalendarEvent } = {}
) => {
  mocks.fetchCalendarEvent.mockResolvedValue(options.value ?? event)
  mocks.fetchCalendars.mockResolvedValue([])
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <EventDetailHost
        eventId={event.id}
        editMode={options.editMode}
        onClose={onClose}
      />
    </QueryClientProvider>
  )
  return { invalidate, onClose }
}

describe('EventDetailHost editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('edits inline without navigating away and returns to detail on cancel', async () => {
    renderHost({ editMode: 'inline' })

    fireEvent.click(await screen.findByTestId('detail-edit'))

    expect(screen.getByTestId('event-editor')).toHaveTextContent('Weekly sync')
    expect(mocks.navigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.getByTestId('detail-edit')).toBeInTheDocument()
  })

  it('refreshes meeting and calendar data after an inline save', async () => {
    const { invalidate, onClose } = renderHost({ editMode: 'inline' })
    fireEvent.click(await screen.findByTestId('detail-edit'))

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['scheduled-meetings'],
      })
    )
  })

  it('asks for scope before editing a recurring occurrence inline', async () => {
    renderHost({
      editMode: 'inline',
      value: { ...event, recurrence_parent: 'series-1' },
    })
    fireEvent.click(await screen.findByTestId('detail-edit'))

    expect(screen.getByTestId('edit-scope-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'confirm scope' }))

    expect(screen.getByTestId('event-editor')).toHaveAttribute(
      'data-edit-scope',
      'following'
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps calendar navigation as the default edit behavior', async () => {
    const { onClose } = renderHost()
    fireEvent.click(await screen.findByTestId('detail-edit'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).toHaveBeenCalledWith('/calendar')
  })

  it('opens the create form with the event as a copy seed', async () => {
    renderHost()

    fireEvent.click(await screen.findByTestId('detail-copy'))

    expect(screen.getByTestId('event-editor')).toHaveAttribute(
      'data-mode',
      'copy'
    )
    expect(screen.getByTestId('event-editor')).toHaveTextContent('Weekly sync')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('does not offer copying for a redacted event', async () => {
    renderHost({ value: { ...event, details_redacted: true } })

    await screen.findByTestId('detail-edit')
    expect(screen.queryByTestId('detail-copy')).not.toBeInTheDocument()
  })
})

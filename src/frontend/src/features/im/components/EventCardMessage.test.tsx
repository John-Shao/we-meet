import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { EventCardMessage } from './EventCardMessage'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

describe('EventCardMessage', () => {
  it('renders the recurrence range label', () => {
    render(
      <EventCardMessage
        system
        body={JSON.stringify({
          v: 1,
          kind: 'cancelled',
          event_id: 'event-1',
          title: 'Weekly review',
          start: '2026-08-12T02:00:00Z',
          end: '2026-08-12T03:00:00Z',
          recurrence_scope: 'all',
        })}
      />
    )

    expect(
      screen.getByTestId('im-msg-event-card-recurrence-scope')
    ).toHaveTextContent('calendar.card.recurrenceScope.all')
  })

  it('renders an RSVP response instead of degrading it to a created card', () => {
    render(
      <EventCardMessage
        system
        body={JSON.stringify({
          v: 1,
          kind: 'rsvp_changed',
          event_id: 'event-1',
          title: 'Weekly review',
          start: '2026-08-12T02:00:00Z',
          end: '2026-08-12T03:00:00Z',
          responder_name: 'Alice',
          rsvp_status: 'accepted',
        })}
      />
    )

    expect(screen.getByText('calendar.card.rsvpChanged')).toBeInTheDocument()
    expect(screen.getByText('calendar.card.rsvpReply')).toBeInTheDocument()
  })

  it('renders a private label without organizer or attendee metadata', () => {
    render(
      <EventCardMessage
        system
        body={JSON.stringify({
          v: 1,
          kind: 'created',
          event_id: 'event-private',
          title: '',
          start: '2026-08-12T02:00:00Z',
          end: '2026-08-12T03:00:00Z',
          attendee_count: 0,
          organizer_name: '',
          visibility: 'private',
        })}
      />
    )

    expect(screen.getByText('calendar.card.privateEvent')).toBeInTheDocument()
    expect(
      screen.queryByText('calendar.card.attendees')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('calendar.card.organizer')
    ).not.toBeInTheDocument()
  })
})

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
})

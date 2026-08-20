import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CalendarEvent } from '../api/ApiCalendar'
import { TransferEventDialog } from './TransferEventDialog'

const mocks = vi.hoisted(() => ({
  transferCalendarEvent: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/features/contacts', () => ({
  ContactPicker: ({
    onSelect,
  }: {
    onSelect: (member: Record<string, unknown>) => void
  }) => (
    <button
      type="button"
      data-testid="single-contact-picker"
      onClick={() =>
        onSelect({
          id: 'new-organizer',
          full_name: 'New organizer',
          short_name: null,
          email: 'new@example.com',
          avatar_url: '',
          title: 'Designer',
          department: { id: 'department-1', name: 'Product' },
        })
      }
    >
      choose
    </button>
  ),
  MemberAvatar: () => <span data-testid="member-avatar" />,
}))

vi.mock('../api/fetchCalendar', () => ({
  transferCalendarEvent: mocks.transferCalendarEvent,
}))

const event = {
  id: 'event-1',
  organizer: { id: 'organizer-1', full_name: 'Original organizer' },
} as CalendarEvent

describe('TransferEventDialog', () => {
  it('uses the shared single-contact picker before confirming the transfer', async () => {
    const transferred = { ...event, organizer: { id: 'new-organizer' } }
    mocks.transferCalendarEvent.mockResolvedValue(transferred)
    const onTransferred = vi.fn()

    render(
      <TransferEventDialog
        event={event}
        onClose={vi.fn()}
        onTransferred={onTransferred}
      />
    )

    fireEvent.click(screen.getByTestId('single-contact-picker'))

    expect(screen.getByTestId('transfer-event-target')).toHaveTextContent(
      'New organizer'
    )
    expect(screen.getByTestId('transfer-event-target')).toHaveTextContent(
      'Designer · Product'
    )

    fireEvent.click(screen.getByTestId('transfer-event-confirm'))

    await waitFor(() =>
      expect(mocks.transferCalendarEvent).toHaveBeenCalledWith(
        'event-1',
        'new-organizer',
        true
      )
    )
    expect(onTransferred).toHaveBeenCalledWith(transferred)
  })

  it('returns to the single-contact picker when changing the target', () => {
    render(
      <TransferEventDialog
        event={event}
        onClose={vi.fn()}
        onTransferred={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('single-contact-picker'))
    fireEvent.click(screen.getByTestId('transfer-event-target'))

    expect(screen.getByTestId('single-contact-picker')).toBeInTheDocument()
  })
})

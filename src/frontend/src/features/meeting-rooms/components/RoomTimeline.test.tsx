import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { RoomBooking, RoomTimelineEntry } from '../api/ApiMeetingRoom'
import { RoomTimeline } from './RoomTimeline'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

beforeAll(() => {
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { value: {} })
  if (!globalThis.CSS.escape) globalThis.CSS.escape = (value) => value
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as typeof PointerEvent
  }
})

const dayStart = new Date(2026, 7, 11, 9, 0)
const dayEnd = new Date(2026, 7, 11, 18, 0)

const booking = (overrides: Partial<RoomBooking> = {}): RoomBooking => ({
  id: 'booking-1',
  event_id: 'event-1',
  start: new Date(2026, 7, 11, 10, 0).toISOString(),
  end: new Date(2026, 7, 11, 11, 0).toISOString(),
  status: 'confirmed',
  source: 'event',
  title: 'Design review',
  is_private: false,
  is_mine: true,
  can_manage: true,
  can_move: true,
  organizer: { id: 'user-1', full_name: 'Alice' },
  ...overrides,
})

const room = (id: string, bookings: RoomBooking[] = []): RoomTimelineEntry => ({
  id,
  name: `Room ${id}`,
  code: id,
  floor: '1',
  capacity: 8,
  description: '',
  node: { id: 'building-1', name: 'Building 1' },
  path_label: 'Building 1',
  timezone: 'Asia/Shanghai',
  facilities: [],
  is_active: true,
  requires_approval: false,
  bookings,
})

const renderTimeline = (
  rooms: RoomTimelineEntry[],
  props: Partial<React.ComponentProps<typeof RoomTimeline>> = {}
) =>
  render(
    <RoomTimeline
      rooms={rooms}
      dayStart={dayStart}
      dayEnd={dayEnd}
      workingHours={{ startMin: 9 * 60, endMin: 18 * 60 }}
      timeRangeMode="work"
      {...props}
    />
  )

describe('RoomTimeline booking interactions', () => {
  it('opens another participant-visible event without selecting a draft slot', () => {
    const attendeeBooking = booking({
      is_mine: true,
      can_manage: false,
      can_move: false,
    })
    const onOpenBooking = vi.fn()
    const onSelectSlot = vi.fn()
    renderTimeline([room('a', [attendeeBooking])], {
      onOpenBooking,
      onSelectSlot,
    })

    fireEvent.click(screen.getByTestId('mr-timeline-block-booking-1'))

    expect(onOpenBooking).toHaveBeenCalledWith(attendeeBooking)
    expect(onSelectSlot).not.toHaveBeenCalled()
  })

  it('keeps a private outsider booking anonymous and non-interactive', () => {
    const privateBooking = booking({
      event_id: null,
      title: null,
      is_private: true,
      is_mine: false,
      can_manage: false,
      can_move: false,
    })
    const onOpenBooking = vi.fn()
    const onSelectSlot = vi.fn()
    renderTimeline([room('a', [privateBooking])], {
      onOpenBooking,
      onSelectSlot,
    })

    const block = screen.getByTestId('mr-timeline-block-booking-1')
    expect(block).not.toHaveAttribute('role')
    fireEvent.click(block)

    expect(onOpenBooking).not.toHaveBeenCalled()
    expect(onSelectSlot).not.toHaveBeenCalled()
  })

  it('shows resize handles and supports keyboard movement for owned events', async () => {
    const ownedBooking = booking()
    const onBookingChange = vi.fn().mockResolvedValue(undefined)
    renderTimeline([room('a', [ownedBooking])], { onBookingChange })

    const block = screen.getByTestId('mr-timeline-block-booking-1')
    expect(block.querySelectorAll('[data-booking-handle]')).toHaveLength(2)
    fireEvent.keyDown(block, { key: 'ArrowRight' })

    await waitFor(() => expect(onBookingChange).toHaveBeenCalledTimes(1))
    const [, targetRoom, start, end] = onBookingChange.mock.calls[0]
    expect(targetRoom.id).toBe('a')
    expect(start).toEqual(new Date(2026, 7, 11, 10, 15))
    expect(end).toEqual(new Date(2026, 7, 11, 11, 15))
  })

  it('drags an owned event across rooms and preserves its duration', async () => {
    const ownedBooking = booking()
    const onBookingChange = vi.fn().mockResolvedValue(undefined)
    renderTimeline([room('a', [ownedBooking]), room('b')], {
      onBookingChange,
    })

    const rowA = screen.getByTestId('mr-timeline-row-a')
    const rowB = screen.getByTestId('mr-timeline-row-b')
    vi.spyOn(rowA, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 50,
    } as DOMRect)
    vi.spyOn(rowB, 'getBoundingClientRect').mockReturnValue({
      top: 51,
      bottom: 100,
    } as DOMRect)

    fireEvent.pointerDown(screen.getByTestId('mr-timeline-block-booking-1'), {
      clientX: 100,
      clientY: 25,
    })
    fireEvent.pointerMove(window, { clientX: 164, clientY: 75 })
    fireEvent.pointerUp(window)

    await waitFor(() => expect(onBookingChange).toHaveBeenCalledTimes(1))
    const [, targetRoom, start, end] = onBookingChange.mock.calls[0]
    expect(targetRoom.id).toBe('b')
    expect(start).toEqual(new Date(2026, 7, 11, 10, 30))
    expect(end).toEqual(new Date(2026, 7, 11, 11, 30))
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '@/components/Modal'

import type {
  MeetingRoomAvailability,
  MeetingRoomBrief,
} from '../api/ApiMeetingRoom'
import {
  fetchMeetingRoomAvailability,
  fetchMeetingRoomFacilities,
  fetchMeetingRoomNodes,
  fetchMeetingRooms,
} from '../api/fetchMeetingRooms'
import { MeetingRoomField } from './MeetingRoomField'
import { MeetingRoomSelectModal } from './MeetingRoomSelectModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name?: string }) =>
      args?.name ? `${key}: ${args.name}` : key,
    i18n: { language: 'en' },
  }),
}))
vi.mock('../api/fetchMeetingRooms')

const makeRoom = (id: string, available = true): MeetingRoomAvailability => ({
  id,
  name: `Room ${id}`,
  code: id,
  floor: '12',
  capacity: 8,
  node: { id: 'building', name: 'Building' },
  path_label: 'Campus · Building · 12',
  timezone: 'Asia/Shanghai',
  description: '',
  facilities: [],
  is_active: true,
  requires_approval: false,
  is_available: available,
  busy: [],
})
const rooms = [makeRoom('1203'), makeRoom('1204'), makeRoom('1205', false)]
const start = new Date('2026-09-09T02:00:00Z')
const end = new Date('2026-09-09T03:00:00Z')
const slotProps = { start, end, timezone: 'Asia/Shanghai', attendeeCount: 3 }

const renderWithQueries = (ui: React.ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  }
}

const EventForm = ({
  initialRoom = null,
}: {
  initialRoom?: MeetingRoomBrief | null
}) => {
  const [value, setValue] = useState(initialRoom)
  return (
    <Modal ariaLabel="Event form" onClose={vi.fn()}>
      <input aria-label="Event title" defaultValue="Planning" />
      <MeetingRoomField
        {...slotProps}
        value={value}
        onChange={setValue}
        allDay={false}
        excludeEventId="editing-event"
      />
    </Modal>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchMeetingRoomNodes).mockResolvedValue([])
  vi.mocked(fetchMeetingRoomFacilities).mockResolvedValue([])
  vi.mocked(fetchMeetingRoomAvailability).mockImplementation(
    async (_start, _end, filters) =>
      rooms.filter((room) => !filters?.q || room.code.includes(filters.q))
  )
  vi.mocked(fetchMeetingRooms).mockResolvedValue({
    count: rooms.length,
    next: null,
    previous: null,
    results: rooms,
  })
})

describe('MeetingRoomSelectModal', () => {
  it('keeps a draft until confirmation, restores form focus, and supports removal', async () => {
    const user = userEvent.setup()
    renderWithQueries(<EventForm />)
    const trigger = screen.getByTestId('mr-picker-toggle')
    await user.click(trigger)
    expect(screen.getByTestId('mr-picker-search')).toHaveFocus()
    expect(screen.getByTestId('mr-picker-slot')).toHaveTextContent('10:00')
    expect(screen.getByTestId('mr-picker-slot')).toHaveTextContent(
      'Asia/Shanghai'
    )
    expect(screen.getByTestId('mr-picker-confirm')).toBeDisabled()
    await user.click(await screen.findByTestId('mr-picker-item-1203'))
    expect(screen.queryByTestId('mr-selected-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('mr-picker-item-1203')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await waitFor(() =>
      expect(screen.getByTestId('mr-picker-confirm')).toBeEnabled()
    )
    await user.click(screen.getByTestId('mr-picker-confirm'))
    expect(screen.queryByTestId('mr-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('mr-selected-chip')).toHaveTextContent('1203')
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Event title' })).toHaveValue(
      'Planning'
    )
    await user.click(screen.getByTestId('mr-clear'))
    expect(screen.queryByTestId('mr-selected-chip')).not.toBeInTheDocument()
  })

  it.each(['cancel', 'escape', 'backdrop', 'close'])(
    'discards a replacement via %s and preselects the original on reopening',
    async (dismiss) => {
      const user = userEvent.setup()
      renderWithQueries(<EventForm initialRoom={rooms[0]} />)
      await user.click(screen.getByTestId('mr-picker-toggle'))
      await user.click(await screen.findByTestId('mr-picker-item-1204'))
      if (dismiss === 'escape') await user.keyboard('{Escape}')
      else if (dismiss === 'backdrop')
        fireEvent.click(
          screen.getByRole('dialog', { name: 'picker.title' }).parentElement!
        )
      else {
        const buttons = screen.getAllByRole('button', { name: 'picker.cancel' })
        await user.click(buttons[dismiss === 'close' ? 0 : 1])
      }
      expect(screen.queryByTestId('mr-picker')).not.toBeInTheDocument()
      expect(
        screen.getByRole('dialog', { name: 'Event form' })
      ).toBeInTheDocument()
      expect(screen.getByTestId('mr-selected-chip')).toHaveTextContent('1203')
      await user.click(screen.getByTestId('mr-picker-toggle'))
      expect(await screen.findByTestId('mr-picker-item-1203')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(fetchMeetingRoomAvailability).toHaveBeenCalledWith(
        start.toISOString(),
        end.toISOString(),
        expect.any(Object),
        { excludeEventId: 'editing-event' }
      )
    }
  )

  it('preserves a draft outside the search results and disables busy rooms in all rooms', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    renderWithQueries(
      <MeetingRoomSelectModal
        {...slotProps}
        value={null}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    )
    await user.click(await screen.findByTestId('mr-picker-item-1203'))
    await user.type(screen.getByTestId('mr-picker-search'), '1204')
    await waitFor(() =>
      expect(
        screen.queryByTestId('mr-picker-item-1203')
      ).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(screen.getByTestId('mr-picker-confirm')).toBeEnabled()
    )
    await user.click(screen.getByTestId('mr-picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1203' })
    )
    await user.clear(screen.getByTestId('mr-picker-search'))
    await user.click(screen.getByTestId('mr-picker-tab-all'))
    expect(await screen.findByTestId('mr-picker-item-1205')).toBeDisabled()
  })

  it('blocks stale choices while a search loads and offers retry after failure', async () => {
    const user = userEvent.setup()
    renderWithQueries(
      <MeetingRoomSelectModal
        {...slotProps}
        value={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('mr-picker-item-1203')
    let rejectSearch!: (error: Error) => void
    vi.mocked(fetchMeetingRoomAvailability).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSearch = reject
        })
    )
    await user.type(screen.getByTestId('mr-picker-search'), 'x')
    expect(screen.getByTestId('mr-picker-item-1203')).toBeDisabled()
    await act(async () => rejectSearch(new Error('Network unavailable')))
    expect(await screen.findByRole('alert')).toHaveTextContent('pane.loadError')
    vi.mocked(fetchMeetingRoomAvailability).mockResolvedValue([rooms[1]])
    await user.click(screen.getByRole('button', { name: 'pane.retry' }))
    expect(await screen.findByTestId('mr-picker-item-1204')).toBeEnabled()
  })

  it('rechecks a preselected room on open and blocks confirmation if it was booked meanwhile', async () => {
    vi.mocked(fetchMeetingRoomAvailability).mockResolvedValue([
      makeRoom('1203', false),
    ])
    renderWithQueries(
      <MeetingRoomSelectModal
        {...slotProps}
        value={rooms[0]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('mr-picker-confirm')).toBeDisabled()
    expect(await screen.findByText('picker.unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('mr-picker-confirm')).toBeDisabled()
  })

  it('revalidates the committed room after the event time changes and clears the conflict on removal', async () => {
    const onConflictChange = vi.fn()
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const field = (slotStart: Date, value: MeetingRoomBrief | null) => (
      <QueryClientProvider client={client}>
        <MeetingRoomField
          {...slotProps}
          start={slotStart}
          end={new Date('2026-09-09T05:00:00Z')}
          value={value}
          onChange={vi.fn()}
          allDay={false}
          excludeEventId="editing-event"
          onConflictChange={onConflictChange}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(field(start, rooms[0]))
    await waitFor(() => expect(fetchMeetingRoomAvailability).toHaveBeenCalled())
    vi.mocked(fetchMeetingRoomAvailability).mockResolvedValue([
      makeRoom('1203', false),
    ])
    const newStart = new Date('2026-09-09T04:00:00Z')
    rerender(field(newStart, rooms[0]))
    expect(await screen.findByTestId('mr-conflict-warning')).toBeInTheDocument()
    expect(onConflictChange).toHaveBeenLastCalledWith(true)
    expect(fetchMeetingRoomAvailability).toHaveBeenLastCalledWith(
      newStart.toISOString(),
      '2026-09-09T05:00:00.000Z',
      {},
      { excludeEventId: 'editing-event' }
    )
    rerender(field(newStart, null))
    expect(screen.queryByTestId('mr-conflict-warning')).not.toBeInTheDocument()
    expect(onConflictChange).toHaveBeenLastCalledWith(false)
  })
})

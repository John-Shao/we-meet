import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MeetingDetailPanel, type MeetingSelection } from './MeetingDetailPanel'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn(), navigateTo: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('@/navigation/navigateTo', () => ({ navigateTo: mocks.navigateTo }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm: vi.fn() }),
}))
vi.mock('@/features/rooms/api/deleteRoom', () => ({
  useDeleteRoom: () => ({ mutate: vi.fn() }),
}))
vi.mock('./MeetingShareDialog', () => ({ MeetingShareDialog: () => null }))

const selection: MeetingSelection = {
  kind: 'recent',
  id: 'room-1',
  name: 'Meeting',
  slug: '10102269',
  timeIso: null,
  canManage: false,
}
const openRoom = { id: selection.id, slug: selection.slug, closed_at: '' }
const closedRoom = { ...openRoom, closed_at: '2026-09-04T15:37:00Z' }
let client: QueryClient

function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MeetingDetailPanel selection={selection} onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

beforeEach(() => vi.resetAllMocks())
afterEach(() => {
  client?.clear()
  vi.useRealTimers()
})

describe('meeting detail join availability', () => {
  it('disables ended meetings while keeping the summary available', async () => {
    mocks.fetchApi.mockResolvedValue(closedRoom)
    show()
    const button = await screen.findByRole('button', { name: 'ended.title' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(screen.getByTestId('meeting-detail-summary')).toBeEnabled()
  })

  it('keeps the button disabled until the room status is loaded', () => {
    mocks.fetchApi.mockReturnValue(new Promise(() => {}))
    show()
    expect(screen.getByTestId('meeting-detail-enter')).toBeDisabled()
  })

  it('rechecks the server before navigating to an open meeting', async () => {
    mocks.fetchApi.mockResolvedValue(openRoom)
    show()
    const button = await screen.findByRole('button', {
      name: 'home.enterMeeting',
    })
    fireEvent.click(button)
    await waitFor(() =>
      expect(mocks.navigateTo).toHaveBeenCalledWith('room', selection.slug)
    )
    expect(mocks.fetchApi).toHaveBeenCalledTimes(2)
  })

  it('stays on the details when the host closes the meeting just before joining', async () => {
    mocks.fetchApi.mockResolvedValueOnce(openRoom).mockResolvedValue(closedRoom)
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'home.enterMeeting' })
    )
    expect(
      await screen.findByRole('button', { name: 'ended.title' })
    ).toBeDisabled()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it('blocks joining with stale data after a failed recheck and allows retry', async () => {
    mocks.fetchApi
      .mockResolvedValueOnce(openRoom)
      .mockRejectedValue(new Error('offline'))
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'home.enterMeeting' })
    )
    await screen.findByRole('alert')
    expect(screen.getByTestId('meeting-detail-enter')).toBeDisabled()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    mocks.fetchApi.mockResolvedValue(closedRoom)
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }))
    expect(
      await screen.findByRole('button', { name: 'ended.title' })
    ).toBeDisabled()
  })

  it('refreshes a visible open meeting and stops polling once it ends', async () => {
    vi.useFakeTimers()
    mocks.fetchApi.mockResolvedValueOnce(openRoom).mockResolvedValue(closedRoom)
    show()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByTestId('meeting-detail-enter')).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001)
    })
    expect(screen.getByRole('button', { name: 'ended.title' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mocks.fetchApi).toHaveBeenCalledTimes(2)
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { RecentMeetingsList } from './RecentMeetingsList'
import { ScheduledMeetingsList } from './ScheduledMeetingsList'
import { MeetingRecordLinks } from './MeetingRecordLinks'
import { MeetingDetailPanel } from './MeetingDetailPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'viewer' } }),
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({ data: { meeting_records: { enabled: true } } }),
}))
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

const record = {
  id: 'record-1',
  has_summary: true,
  capabilities: { read_transcript: true, read_summary: true },
}
function show(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}
beforeEach(() => vi.resetAllMocks())

it('shows all pending rows, ten historical sessions, and the filtered More link', async () => {
  const row = {
    id: 'room',
    name: 'Video',
    slug: '12345678',
    started_at: '2026-09-15T00:00:00Z',
    scheduled_at: '2026-09-01T00:00:00Z',
    status: 'ended',
    is_owner: true,
  }
  vi.mocked(fetchApi).mockResolvedValue({
    scheduled: Array.from({ length: 52 }, (_, i) => ({
      ...row,
      id: `pending-${i}`,
      name: `Pending ${i}`,
    })),
    recent: Array.from({ length: 12 }, (_, i) => ({
      ...row,
      name: `History ${i}`,
      meeting_session_id: `session-${i}`,
    })),
  })
  const selected = vi.fn()
  show(
    <>
      <ScheduledMeetingsList enabled showEmpty onSelect={selected} />
      <RecentMeetingsList enabled showEmpty onSelect={selected} />
    </>
  )
  expect(await screen.findByText('Pending 51')).toBeInTheDocument()
  expect(screen.getByText('History 9')).toBeInTheDocument()
  expect(screen.queryByText('History 10')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'video.more' })).toHaveAttribute(
    'href',
    '/meeting/notes?source_type=meeting'
  )
  fireEvent.click(screen.getByText('History 2'))
  expect(selected).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'room',
      sessionId: 'session-2',
      sessionStatus: 'ended',
    })
  )
})

it('retains both empty sections', async () => {
  vi.mocked(fetchApi).mockResolvedValue({ scheduled: [], recent: [] })
  show(
    <>
      <ScheduledMeetingsList enabled showEmpty onSelect={vi.fn()} />
      <RecentMeetingsList enabled showEmpty onSelect={vi.fn()} />
    </>
  )
  await screen.findByText('home.scheduledEmpty')
  expect(screen.getByText('home.recentEmpty')).toBeInTheDocument()
})

it('resolves the exact session and links to separate views without loading bodies', async () => {
  vi.mocked(fetchApi).mockResolvedValue(record)
  show(<MeetingRecordLinks roomId="room-1" sessionId="session-1" />)
  expect(await screen.findByTestId('meeting-detail-notes')).toHaveAttribute(
    'href',
    '/meeting/records/record-1'
  )
  expect(screen.getByTestId('meeting-detail-minutes')).toHaveAttribute(
    'href',
    '/meeting/records/record-1?tab=summary'
  )
  expect(fetchApi).toHaveBeenCalledTimes(1)
  expect(vi.mocked(fetchApi).mock.calls[0][0]).toBe(
    'meeting-records/resolve/?room_id=room-1&meeting_session_id=session-1'
  )
})

it('does not offer joining an ended session in a reusable open room', async () => {
  vi.mocked(fetchApi).mockImplementation(async (path) =>
    path.includes('resolve')
      ? record
      : path.includes('video-session')
        ? { status: 'ended' }
        : { slug: '12345678', closed_at: '' }
  )
  show(
    <MeetingDetailPanel
      selection={{
        kind: 'recent',
        id: 'room-1',
        sessionId: 'session-1',
        sessionStatus: 'active',
        name: 'Meeting',
        slug: '12345678',
        timeIso: null,
        canManage: false,
      }}
      onClose={vi.fn()}
    />
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'ended.title' })).toBeDisabled()
  )
})

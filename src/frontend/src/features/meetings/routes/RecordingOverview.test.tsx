import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { RecordingOverview, RecordingHistory } from './RecordingOverview'
import { RecordingDetailContent } from './RecordingDetail'

const state = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'owner' }, isLoggedIn: true }),
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({
    data: {
      meeting_records: {
        enabled: state.enabled,
        capture_audio_enabled: state.enabled,
      },
    },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('../components/MeetingModuleShell', () => ({
  MeetingModuleShell: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('../components/RecordingUpload', () => ({
  RecordingUpload: () => <button>upload.open</button>,
  UploadedRecordingStatus: () => <span>upload.state</span>,
}))
vi.mock('../components/MeetingModuleNav', () => ({
  MeetingModuleNav: () => null,
}))

let client: QueryClient
const record = {
  id: 'record-1',
  title: 'Private recording',
  source_type: 'audio_recording',
  origin_at: '2026-09-16T02:00:00Z',
  retention_mode: 'media',
  has_summary: true,
  capabilities: { read_transcript: true, read_summary: true },
}
function show(children: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}
beforeEach(() => {
  state.enabled = true
  window.history.replaceState({}, '', '/meeting/recording')
  vi.mocked(fetchApi).mockResolvedValue({
    results: [record],
    next_cursor: null,
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
})

it('loads only completed recordings, limits history to twenty and links to second-level pages', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    results: Array.from({ length: 24 }, (_, index) => ({
      ...record,
      id: `id-${index}`,
      title: `Recording ${index}`,
    })),
    next_cursor: 'next',
  })
  show(<RecordingOverview />)
  expect(
    screen.getByRole('link', { name: 'recordingOverview.record' })
  ).toHaveAttribute('href', '/meeting/recording/capture')
  expect(
    await screen.findByRole('link', { name: /Recording 0 / })
  ).toHaveAttribute('href', '/meeting/recording/history/id-0')
  expect(screen.getAllByRole('listitem')).toHaveLength(20)
  expect(screen.queryByText('Recording 20')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'video.more' })).toHaveAttribute(
    'href',
    '/meeting/notes?source_type=recordings'
  )
  for (const [path] of vi.mocked(fetchApi).mock.calls) {
    const url = new URL(path, 'https://fixture.invalid')
    expect(url.pathname).toBe('/meeting-records/')
    expect(url.searchParams.get('source_type')).toBe('recordings')
    expect(url.searchParams.get('is_ongoing')).toBe('false')
    expect(url.searchParams.has('has_summary')).toBe(false)
  }
})

it('keeps capture accessible on history errors and retries to an empty state', async () => {
  vi.mocked(fetchApi)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ results: [], next_cursor: null })
  show(<RecordingOverview />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'library.loadError'
  )
  expect(
    screen.getByRole('link', { name: 'recordingOverview.record' })
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'library.refresh' }))
  expect(await screen.findByText('recordingOverview.empty')).toBeInTheDocument()
})

it('does not query or expose capture when the feature is disabled', () => {
  state.enabled = false
  show(<RecordingOverview />)
  expect(
    screen.queryByRole('link', { name: 'recordingOverview.record' })
  ).not.toBeInTheDocument()
  expect(fetchApi).not.toHaveBeenCalled()
})

it('does not reuse another viewer history while a new request is pending', async () => {
  const view = show(<RecordingHistory viewerId="owner" enabled />)
  await screen.findByText('Private recording')
  vi.mocked(fetchApi).mockImplementation(() => new Promise(() => {}))
  view.rerender(
    <QueryClientProvider client={client}>
      <RecordingHistory viewerId="other" enabled />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.queryByText('Private recording')).not.toBeInTheDocument()
  )
})

it('details read metadata only and link to original and summary workspaces', async () => {
  vi.mocked(fetchApi).mockResolvedValue(record)
  show(<RecordingDetailContent viewerId="owner" recordId={record.id} />)
  expect(
    await screen.findByRole('link', { name: 'video.viewRecord' })
  ).toHaveAttribute('href', '/meeting/records/record-1')
  expect(
    screen.getByRole('link', { name: 'detail.viewSummary' })
  ).toHaveAttribute('href', '/meeting/records/record-1?tab=summary')
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.every(([path]) => path === 'meeting-records/record-1/')
  ).toBe(true)
})

it('hides material links when read capabilities are absent', async () => {
  vi.mocked(fetchApi).mockResolvedValue({ ...record, capabilities: {} })
  show(<RecordingDetailContent viewerId="owner" recordId={record.id} />)
  await screen.findByText(record.title)
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

it('rejects non-recording metadata on recording details', async () => {
  vi.mocked(fetchApi).mockResolvedValue({ ...record, source_type: 'meeting' })
  show(<RecordingDetailContent viewerId="owner" recordId={record.id} />)
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.queryByText(record.title)).not.toBeInTheDocument()
})

it('shows imported video and its processing state in history', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    results: [
      {
        ...record,
        source_type: 'upload',
        upload: {
          media_type: 'video',
          name: 'Demo.mp4',
          size: 1024,
          status: 'running',
        },
      },
    ],
    next_cursor: null,
  })
  show(<RecordingOverview />)
  expect(await screen.findByText(/upload.video/)).toBeInTheDocument()
  expect(screen.getByText(/upload.status.running/)).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'upload.open' })
  ).toBeInTheDocument()
})
it('opens imported video metadata and retains native workspace links', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    ...record,
    source_type: 'upload',
    upload: {
      media_type: 'video',
      name: 'Demo.mp4',
      size: 1024,
      status: 'failed',
    },
  })
  show(<RecordingDetailContent viewerId="owner" recordId={record.id} />)
  expect(await screen.findByText(/upload.video/)).toBeInTheDocument()
  expect(screen.getByText(/Demo.mp4/)).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'video.viewRecord' })
  ).toHaveAttribute('href', '/meeting/records/record-1')
})

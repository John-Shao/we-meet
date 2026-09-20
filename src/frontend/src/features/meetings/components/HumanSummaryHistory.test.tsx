import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import {
  HumanSummaryHistory,
  HumanSummaryRevision,
} from './HumanSummaryHistory'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { revision: number }) =>
      values ? `${key} ${values.revision}` : key,
  }),
}))
let client: QueryClient
const source = {
  segment_id: 'segment',
  segment_revision: 1,
  start_ms: 1000,
  end_ms: 2000,
}
const onSource = vi.fn()
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <HumanSummaryHistory
        recordId="record"
        viewerId="user"
        currentId="current"
        onSource={onSource}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetchApi.mockImplementation(async (url: string) =>
    url.endsWith('/old/')
      ? {
          id: 'old',
          revision: 1,
          input_snapshot_id: 'old-snapshot',
          content: {
            overview: 'Old human text',
            decisions: [{ text: 'Old decision', source_refs: [source] }],
            chapters: [],
            action_items: [],
            open_questions: [],
          },
        }
      : {
          results: [{ id: 'old', revision: 1, created_at: '2026-09-13' }],
          next_before: null,
        }
  )
})
afterEach(() => client?.clear())

function exact(
  viewerId = 'user',
  versionId = 'old',
  canReadTranscript = false
) {
  return (
    <QueryClientProvider client={client}>
      <HumanSummaryRevision
        recordId="record"
        viewerId={viewerId}
        versionId={versionId}
        canReadTranscript={canReadTranscript}
        linked
      />
    </QueryClientProvider>
  )
}

it('opens an exact export revision without reading current or paginating history', async () => {
  client = new QueryClient()
  render(exact())
  await screen.findByText('Old human text')
  expect(
    mocks.fetchApi.mock.calls.some(
      ([path]) => path === 'meeting-records/record/human-summary/history/old/'
    )
  ).toBe(true)
  expect(
    mocks.fetchApi.mock.calls.some(
      ([path]) => path.endsWith('/human-summary/') || path.endsWith('/history/')
    )
  ).toBe(false)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'recordAi.source 1s' })
  ).toBeNull()
  expect(
    screen.getByRole('link', { name: 'summaryNotice.allVersions' })
  ).toHaveAttribute('href', '/meeting/records/record?tab=summary')
})

it('hides the old body after a revoked read and never falls back to latest', async () => {
  client = new QueryClient()
  render(exact())
  await screen.findByText('Old human text')
  mocks.fetchApi.mockRejectedValue(new ApiError(404, {}))
  await client.invalidateQueries({ queryKey: ['human-summary-history-detail'] })
  await screen.findByText('humanReview.unavailable')
  expect(screen.queryByText('Old human text')).toBeNull()
})

it('does not reuse an old viewer or version body', async () => {
  client = new QueryClient()
  const view = render(exact())
  await screen.findByText('Old human text')
  mocks.fetchApi.mockRejectedValue(new ApiError(404, {}))
  view.rerender(exact('reader', 'missing'))
  expect(screen.queryByText('Old human text')).toBeNull()
  await screen.findByText('humanReview.unavailable')
})

it('does not turn an empty version selector into a history-list read', async () => {
  client = new QueryClient()
  render(exact('user', ''))
  await screen.findByText('humanReview.unavailable')
  expect(mocks.fetchApi).not.toHaveBeenCalled()
})

it('resolves the selected historical snapshot instead of current transcript text', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((path: string) =>
    path.includes('transcript-versions/old-snapshot/')
      ? Promise.resolve({ segments: [{ ...source, text: 'Frozen original' }] })
      : fallback(path)
  )
  client = new QueryClient()
  render(exact('user', 'old', true))
  fireEvent.click(
    await screen.findByRole('button', { name: 'recordAi.source 1s' })
  )
  await screen.findByText('Frozen original')
  expect(
    mocks.fetchApi.mock.calls.some(([path]) =>
      path.endsWith('/transcript-versions/old-snapshot/')
    )
  ).toBe(true)
})

it('loads on demand and cites the immutable historical snapshot', async () => {
  show()
  expect(mocks.fetchApi).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.history' }))
  fireEvent.click(
    await screen.findByRole('button', { name: /humanReview.historyVersion 1/ })
  )
  await screen.findByText('Old human text')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'recordAi.source 1s' }))
  expect(onSource).toHaveBeenCalledWith('old-snapshot', source)
})

it('does not render a selected historical revision after an access failure', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url: string) =>
    url.endsWith('/old/')
      ? Promise.reject(new ApiError(404, {}))
      : fallback(url)
  )
  show()
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.history' }))
  fireEvent.click(
    await screen.findByRole('button', { name: /humanReview.historyVersion 1/ })
  )
  await screen.findByText('humanReview.unavailable')
  expect(screen.queryByText('Old human text')).not.toBeInTheDocument()
})

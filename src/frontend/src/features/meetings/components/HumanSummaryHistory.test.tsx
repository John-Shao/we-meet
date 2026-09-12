import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { HumanSummaryHistory } from './HumanSummaryHistory'

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

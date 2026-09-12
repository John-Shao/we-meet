import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import type { ApiRecordSummaryVersion } from '../api/ApiMeetingRecord'
import { HumanSummaryPanel } from './HumanSummaryPanel'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const content = {
  overview: 'Original overview',
  decisions: [],
  chapters: [],
  action_items: [],
  open_questions: [],
}
const current = {
  id: 'human',
  revision: 1,
  base_summary_id: 'ai',
  input_snapshot_id: 'source',
  content,
}
const versions: ApiRecordSummaryVersion[] = [
  {
    id: 'ai',
    stage: 'final',
    created_at: '2026-09-13',
    content,
    coverage_status: 'unverified',
    delivery_status: 'complete',
    input_snapshot_id: 'source',
    input_revision: 1,
    is_current: true,
    model_used: 'qwen3.8-flash',
  },
]
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <HumanSummaryPanel
        recordId="record"
        viewerId="viewer"
        versions={versions}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetchApi.mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? {
          current: {
            ...current,
            revision: 2,
            content: JSON.parse(options.body).content,
          },
        }
      : { current, can_edit: true }
  )
})
afterEach(() => client?.clear())

it('saves a separate human revision with the captured optimistic revision', async () => {
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'humanReview.edit' })
  )
  fireEvent.change(screen.getByLabelText('humanReview.overview'), {
    target: { value: 'Human correction' },
  })
  expect(posts()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.save' }))
  await screen.findByText('humanReview.saved')
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({
    expected_revision: 1,
    base_summary_id: 'ai',
    replace_base: false,
    content: { overview: 'Human correction' },
  })
  expect(content.overview).toBe('Original overview')
})

it('keeps a draft on conflict instead of rebasing it silently', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST'
      ? Promise.reject(new ApiError(409, {}))
      : fallback(url, options)
  )
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'humanReview.edit' })
  )
  fireEvent.change(screen.getByLabelText('humanReview.overview'), {
    target: { value: 'Keep this draft' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.save' }))
  await screen.findByText('humanReview.conflict')
  expect(screen.getByLabelText('humanReview.overview')).toHaveValue(
    'Keep this draft'
  )
  expect(
    screen.getByRole('button', { name: 'humanReview.cancel' })
  ).toBeEnabled()
})

it('retries an uncertain save with an identical intent and frozen draft', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  let failed = false
  mocks.fetchApi.mockImplementation((url, options) => {
    if (options?.method === 'POST' && !failed) {
      failed = true
      return Promise.reject(new TypeError('lost response'))
    }
    return fallback(url, options)
  })
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'humanReview.edit' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.save' }))
  await screen.findByText('humanReview.uncertain')
  expect(screen.getByLabelText('humanReview.overview')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'humanReview.retry' }))
  await screen.findByText('humanReview.saved')
  expect(posts()[0][1].body).toBe(posts()[1][1].body)
})

it('shows saved content but no editing actions to a reader', async () => {
  mocks.fetchApi.mockResolvedValue({ current, can_edit: false })
  show()
  await screen.findByText('Original overview')
  expect(
    screen.queryByRole('button', { name: 'humanReview.edit' })
  ).not.toBeInTheDocument()
  expect(posts()).toHaveLength(0)
})

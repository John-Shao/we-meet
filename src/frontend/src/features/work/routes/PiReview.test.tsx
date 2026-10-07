import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import * as reviews from '../api/reviews'
import * as tasks from '../api/tasks'
import { PiReview } from './PiReview'

vi.mock('../api/reviews', () => ({
  listReviews: vi.fn(),
  createReview: vi.fn(),
  cancelReview: vi.fn(),
}))
vi.mock('../api/tasks', () => ({ listRunFiles: vi.fn() }))

const file = { name: 'report.md', sha256: 'a'.repeat(64) }
const review: reviews.WorkReview = {
  id: 'review-1',
  source_run_id: 'run-1',
  status: 'succeeded',
  error_code: '',
  model: 'deepseek-flash',
  selection: [file],
  snapshot: [file],
  reserved_tokens: 100,
  input_tokens: 80,
  output_tokens: 20,
  report: {
    verdict: 'needs_changes',
    summary: '核对金额',
    findings: [
      {
        severity: 'error',
        message: '金额不符',
        evidence: [
          {
            file: 'result-01.md',
            sha256: file.sha256,
            quote: '<script>unsafe()</script>',
          },
        ],
      },
    ],
    missing_information: [],
  },
}

function mount(enabled = true) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <PiReview ownerId="owner" runId="run-1" enabled={enabled} />
    </QueryClientProvider>
  )
  return { ...view, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tasks.listRunFiles).mockResolvedValue([file])
  vi.mocked(reviews.listReviews).mockResolvedValue([])
  vi.mocked(reviews.createReview).mockResolvedValue(review)
})

it('requires a selected hashed file and explicit upload consent, retaining the key on transport failure', async () => {
  vi.mocked(reviews.createReview).mockRejectedValue(
    new ApiError(503, { code: 'review_unavailable' })
  )
  mount()
  const start = await screen.findByRole('button', { name: '开启本次复核' })
  expect(start).toBeDisabled()
  fireEvent.click(await screen.findByLabelText('report.md'))
  expect(start).toBeDisabled()
  fireEvent.click(
    screen.getByLabelText('同意将选定成果和本任务已授权材料发送至复核模型')
  )
  await waitFor(() => expect(start).not.toBeDisabled())
  fireEvent.click(start)
  await screen.findByRole('alert')
  fireEvent.click(start)
  await waitFor(() => expect(reviews.createReview).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(reviews.createReview).mock.calls
  expect(calls[0].slice(0, 2)).toEqual(['run-1', [file]])
  expect(calls[0][2]).toEqual(calls[1][2])
})

it('preserves history with the feature disabled and renders evidence as text', async () => {
  vi.mocked(reviews.listReviews).mockResolvedValue([review])
  mount(false)
  expect(
    await screen.findByText('金额不符', { exact: false })
  ).toBeInTheDocument()
  expect(screen.getByText('<script>unsafe()</script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  expect(
    screen.queryByRole('button', { name: '开启本次复核' })
  ).not.toBeInTheDocument()
})

it('cancels only the review while its status is active', async () => {
  vi.mocked(reviews.listReviews).mockResolvedValue([
    { ...review, status: 'running', report: {} },
  ])
  vi.mocked(reviews.cancelReview).mockResolvedValue({
    ...review,
    status: 'canceled',
    report: {},
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '取消复核' }))
  await waitFor(() =>
    expect(reviews.cancelReview).toHaveBeenCalledWith('run-1', 'review-1')
  )
  expect(reviews.createReview).not.toHaveBeenCalled()
})

it.each(['files', 'reviews'] as const)(
  'hides cached file identities and reports when the %s permission check fails',
  async (resource) => {
    vi.mocked(reviews.listReviews).mockResolvedValue([review])
    const { client } = mount()
    await screen.findByText('<script>unsafe()</script>')
    fireEvent.click(screen.getByLabelText('report.md'))
    fireEvent.click(
      screen.getByLabelText('同意将选定成果和本任务已授权材料发送至复核模型')
    )
    const denied = new ApiError(409, { code: 'source_unavailable' })
    if (resource === 'files')
      vi.mocked(tasks.listRunFiles).mockRejectedValue(denied)
    else vi.mocked(reviews.listReviews).mockRejectedValue(denied)
    await client.invalidateQueries({
      queryKey: ['work', 'owner', resource, 'run-1'],
    })
    await screen.findByRole('alert')
    expect(screen.queryByText('<script>unsafe()</script>')).toBeNull()
    expect(screen.queryByLabelText('report.md')).toBeNull()
    expect(screen.getByRole('button', { name: '开启本次复核' })).toBeDisabled()

    vi.mocked(tasks.listRunFiles).mockResolvedValue([file])
    vi.mocked(reviews.listReviews).mockResolvedValue([review])
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByText('<script>unsafe()</script>')
    // Restored access must require a new selection and sending consent.
    expect(screen.getByLabelText('report.md')).not.toBeChecked()
    expect(
      screen.getByLabelText('同意将选定成果和本任务已授权材料发送至复核模型')
    ).not.toBeChecked()
  }
)

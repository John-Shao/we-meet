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
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        })
      }
    >
      <PiReview ownerId="owner" runId="run-1" enabled={enabled} />
    </QueryClientProvider>
  )
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

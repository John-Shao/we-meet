import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiRecordSummaryVersion } from '../api/ApiMeetingRecord'
import { RecordQuestionPanel } from './RecordQuestionPanel'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const ref = {
  segment_id: 'segment',
  segment_revision: 2,
  start_ms: 1000,
  end_ms: 2000,
}
const result = {
  id: 'question-id',
  snapshot_id: 'snapshot',
  question: 'What happened?',
  status: 'succeeded',
  content: { answerable: true, answer: 'Grounded answer', source_refs: [ref] },
  error_code: '',
}
const versions: ApiRecordSummaryVersion[] = [
  {
    id: 'version',
    input_snapshot_id: 'snapshot',
    input_revision: 2,
    stage: 'final',
    created_at: '2026-09-13',
    coverage_status: 'unverified',
    delivery_status: 'complete',
    is_current: true,
    model_used: 'qwen3.8-flash',
    content: {
      overview: 'Summary',
      decisions: [],
      chapters: [],
      action_items: [],
      open_questions: [],
    },
  },
]
const onSource = vi.fn()
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordQuestionPanel
        recordId="record"
        viewerId="user"
        versions={versions}
        onSource={onSource}
      />
    </QueryClientProvider>
  )
}
async function fill() {
  fireEvent.change(await screen.findByLabelText('recordQuestion.source'), {
    target: { value: 'snapshot' },
  })
  fireEvent.change(screen.getByLabelText('recordQuestion.question'), {
    target: { value: 'What happened?' },
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetchApi.mockImplementation(async (url, options) =>
    options?.method === 'POST' || url.endsWith('/question-id/')
      ? result
      : { available: true }
  )
})
afterEach(() => client?.clear())

it('requires a selected source and opens citations against the answered snapshot', async () => {
  show()
  expect(
    await screen.findByRole('button', { name: 'recordQuestion.ask' })
  ).toBeDisabled()
  expect(posts()).toHaveLength(0)
  await fill()
  fireEvent.click(screen.getByRole('button', { name: 'recordQuestion.ask' }))
  await screen.findByText('Grounded answer')
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({
    snapshot_id: 'snapshot',
    question: 'What happened?',
  })
  fireEvent.click(screen.getByRole('button', { name: 'recordAi.source 1s' }))
  expect(onSource).toHaveBeenCalledWith('snapshot', ref)
})

it('checks the same intent after a lost response', async () => {
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
  await fill()
  fireEvent.click(screen.getByRole('button', { name: 'recordQuestion.ask' }))
  await screen.findByText('recordQuestion.uncertain')
  expect(screen.getByLabelText('recordQuestion.question')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'recordQuestion.retry' }))
  await screen.findByText('Grounded answer')
  expect(posts()[0][1].body).toBe(posts()[1][1].body)
})

it('renders an explicit no-evidence state without model speculation', async () => {
  const fallback = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST' || url.endsWith('/question-id/')
      ? Promise.resolve({
          ...result,
          content: {
            answerable: false,
            answer: 'Speculation',
            source_refs: [],
          },
        })
      : fallback(url, options)
  )
  show()
  await fill()
  fireEvent.click(screen.getByRole('button', { name: 'recordQuestion.ask' }))
  await screen.findByText('recordQuestion.noEvidence')
  expect(screen.queryByText('Speculation')).not.toBeInTheDocument()
})

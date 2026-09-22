import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { RecordOverviewPanel } from './RecordOverviewPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const id = '11111111-1111-4111-8111-111111111111'
const job = {
  id,
  status: 'queued',
  attempt: 1,
  generation: 1,
  input_revision: 1,
  retryable: false,
  error_code: '',
  dispatch_pending: false,
  updated_at: '2026-09-22T00:00:00Z',
}
const version = {
  id: 'overview',
  created_at: '2026-09-22T00:00:00Z',
  is_current: true,
  asr_status: 'finished',
  content: { synopsis: 'Independent overview', topics: [] },
}
let client: QueryClient
let state: Record<string, unknown>
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordOverviewPanel viewerId="owner" recordId="record" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  state = {
    revision: 1,
    available: true,
    can_generate: true,
    generation_ready: true,
    job: null,
    version: null,
  }
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      expect(path).toBe('meeting-records/record/overview-requests/')
      state = { ...state, job }
      return { request_id: id, replayed: false, dispatch_state: 'sent', job }
    }
    expect(path).toBe('meeting-records/record/overview/')
    return state
  })
})
afterEach(() => {
  client?.clear()
  vi.clearAllMocks()
  sessionStorage.clear()
})

it('generates only on explicit action and renders its separate result', async () => {
  show()
  const generate = await screen.findByRole('button', {
    name: 'recordOverview.generate',
  })
  await waitFor(() => expect(generate).toBeEnabled())
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
  fireEvent.click(generate)
  await screen.findByText('recordOverview.generating')
  expect(
    screen.getByRole('button', { name: 'recordOverview.regenerate' })
  ).toBeDisabled()
  state = { ...state, job: { ...job, status: 'succeeded' }, version }
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('Independent overview')
  expect(
    vi.mocked(fetchApi).mock.calls.every(([path]) => !path.includes('summary-'))
  ).toBe(true)
})

it('preserves the idempotency key after an uncertain response and a remount', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  let fail = true
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'POST' && fail) throw new TypeError('network lost')
    return baseline(path, options, ...rest)
  })
  const first = show()
  const generate = await screen.findByRole('button', {
    name: 'recordOverview.generate',
  })
  await waitFor(() => expect(generate).toBeEnabled())
  fireEvent.click(generate)
  await screen.findByText('recordOverview.uncertain')
  first.unmount()
  client.clear()
  fail = false
  show()
  const recover = await screen.findByRole('button', {
    name: 'recordOverview.resubmit',
  })
  await waitFor(() => expect(recover).toBeEnabled())
  fireEvent.click(recover)
  await screen.findByText('recordOverview.accepted')
  const posts = vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[0][1]?.headers).toEqual(posts[1][1]?.headers)
  expect(posts[0][1]?.body).toEqual(posts[1][1]?.body)
})

it('keeps the previous overview visible on generation failure and offers explicit retry', async () => {
  state = {
    ...state,
    job: { ...job, status: 'failed', retryable: true },
    version,
  }
  show()
  await screen.findByText('Independent overview')
  const retry = screen.getByRole('button', { name: 'recordOverview.retry' })
  await waitFor(() => expect(retry).toBeEnabled())
  fireEvent.click(retry)
  await screen.findByText('recordOverview.accepted')
  const body = vi
    .mocked(fetchApi)
    .mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body
  expect(JSON.parse(String(body))).toMatchObject({
    operation: 'retry',
    expected_job_id: id,
    expected_attempt: 1,
  })
})

it('summary readers cannot generate and stale data disappears on a refused refresh', async () => {
  state = { ...state, can_generate: false, version }
  show()
  await screen.findByText('Independent overview')
  expect(
    screen.queryByRole('button', { name: 'recordOverview.generate' })
  ).toBeNull()
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(403, {}))
  await act(async () => {
    await client.invalidateQueries()
  })
  await screen.findByText('library.loadError')
  expect(screen.queryByText('Independent overview')).toBeNull()
})

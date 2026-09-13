import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { SummaryNotificationPanel } from './SummaryNotificationPanel'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const noticeId = 'f9a2cd03-14d0-461a-9311-5aeeac3ce756'
const base = {
  id: noticeId,
  summary_id: 'version-1',
  status: 'uncertain',
  attempt: 2,
  error_code: '',
  created_at: '2026-09-13T08:00:00Z',
}
let notice: typeof base
let available: boolean
let readError: boolean
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show(viewerId = 'owner', summaryId?: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SummaryNotificationPanel
        viewerId={viewerId}
        recordId="record"
        summaryId={summaryId}
      />
    </QueryClientProvider>
  )
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryNotice.title' })
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  notice = { ...base }
  available = true
  readError = false
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      notice = { ...notice, status: 'queued', attempt: 3 }
      return { notification: notice }
    }
    if (readError) throw new ApiError(403, {})
    return {
      available,
      strategy: 'owner',
      legacy_delivery_unchanged: true,
      future_recipients: [{ id: 'owner', name: 'Meeting owner' }],
      results: [notice],
    }
  })
})
afterEach(() => {
  client.clear()
  sessionStorage.clear()
})

it('shows delivery policy and exact-version link without sending', async () => {
  show('owner', 'version-1')
  await open()
  expect(screen.getByText('Meeting owner')).toBeInTheDocument()
  expect(screen.getByText('summaryNotice.strategy.owner')).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'summaryNotice.openVersion' })
  ).toHaveAttribute('href', '/meeting/records/record?summary=version-1')
  expect(mocks.fetchApi.mock.calls[0][0]).toBe(
    'meeting-records/record/summary-notifications/?summary_id=version-1'
  )
  expect(posts()).toHaveLength(0)
})

it('persists retry identity before POST and resumes same attempt after remount', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let fail = true
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      expect(sessionStorage.getItem(sessionStorage.key(0)!)).toContain(
        options.headers['Idempotency-Key']
      )
      if (fail) throw new TypeError('lost response')
    }
    return normal(url, options)
  })
  const first = show()
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'summaryNotice.retry' }))
  await screen.findByText('summaryNotice.uncertainRequest')
  const original = posts()[0]
  first.unmount()
  client.clear()
  fail = false
  show()
  await open()
  fireEvent.click(
    screen.getByRole('button', { name: 'summaryNotice.resubmit' })
  )
  await screen.findByText('summaryNotice.accepted')
  expect(posts()[1][0]).toBe(
    `meeting-records/record/summary-notifications/${noticeId}/retry/`
  )
  expect(posts()[1][1].body).toBe(original[1].body)
  expect(JSON.parse(posts()[1][1].body)).toEqual({ expected_attempt: 2 })
  expect(posts()[1][1].headers).toEqual(original[1].headers)
  expect(sessionStorage.length).toBe(0)
})

it.each(['queued', 'running', 'delivered', 'unavailable'])(
  'never retries terminal or active %s notifications',
  async (status) => {
    notice.status = status
    show()
    await open()
    expect(
      screen.queryByRole('button', { name: 'summaryNotice.retry' })
    ).toBeNull()
    expect(posts()).toHaveLength(0)
  }
)

it('hides stale recipients, links and retry actions after access failure', async () => {
  show()
  await open()
  await screen.findByText('Meeting owner')
  readError = true
  await client.invalidateQueries()
  await screen.findByText('summaryNotice.loadError')
  expect(screen.queryByText('Meeting owner')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'summaryNotice.retry' })
  ).toBeNull()
})

it('does not reuse another account recovery marker', async () => {
  sessionStorage.setItem(
    `meeting-summary-notice:other:record:${noticeId}`,
    JSON.stringify({ key: crypto.randomUUID(), expected_attempt: 1 })
  )
  show('owner')
  await open()
  expect(
    screen.queryByRole('button', { name: 'summaryNotice.resubmit' })
  ).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'summaryNotice.retry' }))
  await screen.findByText('summaryNotice.accepted')
  expect(JSON.parse(posts()[0][1].body)).toEqual({ expected_attempt: 2 })
})

it('clears rejected intent on a changed attempt and refreshes server status', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST'
      ? Promise.reject(new ApiError(409, {}))
      : normal(url, options)
  )
  show()
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'summaryNotice.retry' }))
  await screen.findByText('summaryNotice.conflict')
  expect(sessionStorage.length).toBe(0)
  await waitFor(() =>
    expect(mocks.fetchApi.mock.calls.length).toBeGreaterThan(2)
  )
})

it('keeps status visible while rollout is disabled but offers no new retry', async () => {
  available = false
  show()
  await open()
  expect(screen.getByText('summaryNotice.paused')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'summaryNotice.retry' })
  ).toBeNull()
})

it.each(['{', '{}', ''])(
  'blocks a corrupt recovery marker without replacing it: %s',
  async (raw) => {
    const key = `meeting-summary-notice:owner:record:${noticeId}`
    sessionStorage.setItem(key, raw)
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'summaryNotice.title' })
    )
    await screen.findByText('summaryNotice.storageUnavailable')
    expect(posts()).toHaveLength(0)
    expect(sessionStorage.getItem(key)).toBe(raw)
  }
)

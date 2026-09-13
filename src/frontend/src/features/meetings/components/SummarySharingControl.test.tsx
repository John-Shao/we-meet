import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { SummarySharingControl } from './SummarySharingControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const peer = {
  id: 'f9a2cd03-14d0-461a-9311-5aeeac3ce756',
  name: 'Invited colleague',
  read_summary: true,
  read_transcript: false,
  active: true,
}
const preview = {
  title: 'Product meeting',
  preview_hash: 'a'.repeat(64),
  recipients: [
    {
      ...peer,
      after_effective_summary: true,
      inherited_summary: false,
      effective_transcript: false,
    },
  ],
}
const mutations = () =>
  mocks.fetchApi.mock.calls.filter(
    ([url, options]) => options?.method === 'POST' && !url.endsWith('/preview/')
  )
let client: QueryClient
let available: boolean
let manager: boolean
let grants: (typeof peer)[]
let failRead: boolean
function show(viewerId = 'owner') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SummarySharingControl recordId="record" viewerId={viewerId} online />
    </QueryClientProvider>
  )
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'summarySharing.title' })
  )
  await screen.findByText('summarySharing.scope')
}
async function inspect() {
  fireEvent.click(await screen.findByRole('checkbox', { name: peer.name }))
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.preview' })
  )
  await screen.findByRole('button', { name: 'summarySharing.confirm' })
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  available = true
  manager = true
  grants = []
  failRead = false
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (failRead) throw new ApiError(403, {})
    if (url.endsWith('/preview/')) return preview
    if (options?.method === 'POST') {
      grants = [peer]
      return { replayed: false, applied_preview: preview }
    }
    if (url.includes('/candidates/'))
      return { results: [peer], next_cursor: null }
    return {
      available,
      can_manage: manager,
      results: grants,
      next_cursor: null,
    }
  })
})
afterEach(() => {
  client.clear()
  sessionStorage.clear()
})

it('requires selection and reviewed scope before any permission mutation', async () => {
  show()
  await open()
  expect(screen.getByText('summarySharing.scope')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'summarySharing.confirm' })
  ).toBeNull()
  await inspect()
  expect(mutations()).toHaveLength(0)
  expect(
    mocks.fetchApi.mock.calls.some(([url]) =>
      url.includes('scope=participants')
    )
  ).toBe(true)
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(mutations()).toHaveLength(1)
  expect(JSON.parse(mutations()[0][1].body)).toEqual({
    user_ids: [peer.id],
    operation: 'grant',
    expected_hash: preview.preview_hash,
  })
})

it('recovers the original permission request after a lost response and remount', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let fail = true
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (options?.method === 'POST' && !url.endsWith('/preview/')) {
      expect(sessionStorage.getItem(sessionStorage.key(0)!)).toContain(
        options.headers['Idempotency-Key']
      )
      if (fail) throw new TypeError('response lost')
    }
    return normal(url, options)
  })
  const first = show()
  await open()
  await inspect()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.uncertain')
  const original = mutations()[0][1]
  first.unmount()
  client.clear()
  fail = false
  show()
  await open()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.resubmit' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(mutations()[1][1].headers).toEqual(original.headers)
  expect(mutations()[1][1].body).toEqual(original.body)
})

it('does not allow a changed preview to be confirmed again', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST' && !url.endsWith('/preview/')
      ? Promise.reject(new ApiError(409, {}))
      : normal(url, options)
  )
  show()
  await open()
  await inspect()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.conflict')
  expect(
    screen.queryByRole('button', { name: 'summarySharing.confirm' })
  ).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it('previews inherited access that remains after revoking a direct grant', async () => {
  grants = [peer]
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    url.endsWith('/preview/')
      ? Promise.resolve({
          ...preview,
          recipients: [
            {
              ...preview.recipients[0],
              inherited_summary: true,
              effective_transcript: true,
            },
          ],
        })
      : normal(url, options)
  )
  show()
  await open()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summarySharing.revoke' })
  )
  await screen.findByText('summarySharing.inherited')
  expect(screen.getByText('summarySharing.originalAccess')).toBeInTheDocument()
  expect(mutations()).toHaveLength(0)
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(JSON.parse(mutations()[0][1].body).operation).toBe('revoke')
})

it('removes the private preview and all write controls on permission failure', async () => {
  show()
  await open()
  await inspect()
  failRead = true
  await client.invalidateQueries()
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'summarySharing.confirm' })
    ).toBeNull()
  )
  expect(screen.queryByText(peer.name)).toBeNull()
  expect(mutations()).toHaveLength(0)
})

it('never exposes management to shared readers or reuses a different account marker', async () => {
  sessionStorage.setItem(
    'meeting-summary-sharing:other:record',
    JSON.stringify({
      key: crypto.randomUUID(),
      expected_hash: 'a'.repeat(64),
      user_ids: [peer.id],
      operation: 'grant',
    })
  )
  manager = false
  const first = show('reader')
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
  expect(
    screen.queryByRole('button', { name: 'summarySharing.title' })
  ).toBeNull()
  first.unmount()
  client.clear()
  manager = true
  show()
  await open()
  expect(
    screen.queryByRole('button', { name: 'summarySharing.resubmit' })
  ).toBeNull()
})

it('turning off sharing retains existing grants without new actions', async () => {
  available = false
  grants = [peer]
  show()
  await open()
  await screen.findByText(peer.name)
  expect(screen.getByText('summarySharing.paused')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'summarySharing.revoke' })
  ).toBeNull()
  expect(mutations()).toHaveLength(0)
})

it.each(['{', '{}', ''])(
  'blocks a corrupt recovery marker without replacing it: %s',
  async (raw) => {
    const key = `meeting-summary-sharing:owner:record`
    sessionStorage.setItem(key, raw)
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'summarySharing.title' })
    )
    await screen.findByText('summarySharing.storageUnavailable')
    expect(mutations()).toHaveLength(0)
    expect(sessionStorage.getItem(key)).toBe(raw)
  }
)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { SummaryExportControl } from './SummaryExportControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const exportId = 'f9a2cd03-14d0-461a-9311-5aeeac3ce756'
const documentId = 'b9a2cd03-14d0-461a-9311-5aeeac3ce756'
const receipt = {
  id: exportId,
  source_kind: 'ai',
  source_id: 'version',
  language: 'en',
  status: 'queued',
  attempt: 1,
  document_id: null,
  can_open: false,
  error_code: '',
}
const preview = {
  title: 'Frozen meeting',
  markdown: '# Literal source\n\nMinutes copy',
  payload_hash: 'a'.repeat(64),
}
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
let results: (typeof receipt)[]
let available: boolean
function show(viewerId = 'owner', sourceId = 'version') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SummaryExportControl
        viewerId={viewerId}
        recordId="record"
        sourceId={sourceId}
        sourceKind="ai"
      />
    </QueryClientProvider>
  )
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryExport.open' })
  )
  await screen.findByRole('button', { name: 'summaryExport.preview' })
}
async function inspect() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryExport.preview' })
  )
  await screen.findByText('Frozen meeting')
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  results = []
  available = true
  mocks.fetchApi.mockImplementation(
    async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        results = [receipt]
        return { export: receipt }
      }
      if (url.includes('/preview/')) return preview
      if (url.endsWith('/retry/')) return { ...preview, export: results[0] }
      return { available, results }
    }
  )
})
afterEach(() => {
  client?.clear()
  sessionStorage.clear()
})

it('requires an exact preview and explicit confirmation, then polls the receipt', async () => {
  show()
  await open()
  expect(posts()).toHaveLength(0)
  expect(
    screen.queryByRole('button', { name: 'summaryExport.confirm' })
  ).toBeNull()
  await inspect()
  expect(screen.getByLabelText('summaryExport.content')).toHaveTextContent(
    'Literal source'
  )
  fireEvent.click(screen.getByRole('button', { name: 'summaryExport.confirm' }))
  await screen.findByText('summaryExport.status.queued')
  expect(posts()).toHaveLength(1)
  expect(JSON.parse(posts()[0][1].body)).toEqual({
    source_kind: 'ai',
    source_id: 'version',
    language: 'en',
    expected_hash: preview.payload_hash,
  })
  expect(sessionStorage.length).toBe(0)
  expect(posts()[0][1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
})

it('persists the original key before POST and recovers it after remount', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let fail = true
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      expect(sessionStorage.getItem(sessionStorage.key(0)!)).toContain(
        options.headers['Idempotency-Key']
      )
      if (fail) throw new TypeError('network lost')
    }
    return normal(url, options)
  })
  const first = show()
  await open()
  await inspect()
  fireEvent.click(screen.getByRole('button', { name: 'summaryExport.confirm' }))
  await screen.findByText('summaryExport.uncertain')
  const original = posts()[0][1]
  first.unmount()
  client.clear()
  fail = false
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryExport.open' })
  )
  fireEvent.click(
    await screen.findByRole('button', { name: 'summaryExport.resubmit' })
  )
  await screen.findByText('summaryExport.accepted')
  expect(posts()[1][1].body).toBe(original.body)
  expect(posts()[1][1].headers).toEqual(original.headers)
})

it('discards a stale preview on conflict and requires preview again', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST'
      ? Promise.reject(new ApiError(409, {}))
      : normal(url, options)
  )
  show()
  await open()
  await inspect()
  fireEvent.click(screen.getByRole('button', { name: 'summaryExport.confirm' }))
  await screen.findByText('summaryExport.conflict')
  expect(
    screen.queryByRole('button', { name: 'summaryExport.confirm' })
  ).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it('previews the original frozen copy before an explicit retry with attempt fencing', async () => {
  results = [{ ...receipt, status: 'uncertain', attempt: 3 }]
  show()
  await open()
  await inspect()
  fireEvent.click(
    screen.getByRole('button', { name: 'summaryExport.confirmRetry' })
  )
  await screen.findByText('summaryExport.accepted')
  expect(posts()[0][0]).toBe(
    `meeting-records/record/document-exports/${exportId}/retry/`
  )
  expect(JSON.parse(posts()[0][1].body)).toEqual({
    expected_attempt: 3,
    expected_hash: preview.payload_hash,
  })
})

it('never creates automatically for ready or unavailable receipts', async () => {
  results = [
    {
      ...receipt,
      status: 'ready',
      document_id: documentId,
      can_open: true,
    } as unknown as typeof receipt,
  ]
  show()
  await open()
  await inspect()
  expect(
    screen.getByRole('link', { name: 'summaryExport.openDocument' })
  ).toHaveAttribute('href', `/docs/${documentId}`)
  expect(
    screen.queryByRole('button', { name: 'summaryExport.confirmRetry' })
  ).toBeNull()
  results = [{ ...receipt, status: 'unavailable' }]
  await client.invalidateQueries()
  await screen.findByText('summaryExport.status.unavailable')
  expect(screen.queryByRole('link')).toBeNull()
  expect(posts()).toHaveLength(0)
})

it('hides document links after destination changes and hides preview on permission failure', async () => {
  results = [
    {
      ...receipt,
      status: 'ready',
      document_id: documentId,
      can_open: false,
    } as unknown as typeof receipt,
  ]
  show()
  await open()
  await inspect()
  expect(screen.queryByRole('link')).toBeNull()
  mocks.fetchApi.mockRejectedValue(new ApiError(403, {}))
  await client.invalidateQueries()
  await waitFor(() => expect(screen.queryByText('Frozen meeting')).toBeNull())
  expect(posts()).toHaveLength(0)
})

it('does not reuse an unconfirmed intent for another viewer or selected source', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST'
      ? Promise.reject(new TypeError())
      : normal(url, options)
  )
  const first = show()
  await open()
  await inspect()
  fireEvent.click(screen.getByRole('button', { name: 'summaryExport.confirm' }))
  await screen.findByText('summaryExport.uncertain')
  first.unmount()
  client.clear()
  show('other-viewer', 'other-version')
  await open()
  expect(
    screen.queryByRole('button', { name: 'summaryExport.resubmit' })
  ).toBeNull()
  expect(posts()).toHaveLength(1)
})

it('changing heading language invalidates the previous preview', async () => {
  show()
  await open()
  await inspect()
  fireEvent.change(screen.getByLabelText('summaryExport.language'), {
    target: { value: 'zh' },
  })
  await screen.findByRole('button', { name: 'summaryExport.preview' })
  expect(screen.queryByText('Frozen meeting')).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'summaryExport.confirm' })
  ).toBeNull()
})

it('blocks mutation if a recovery key cannot be stored', async () => {
  show()
  await open()
  await inspect()
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota')
    })
  try {
    fireEvent.click(
      screen.getByRole('button', { name: 'summaryExport.confirm' })
    )
    await screen.findByText('summaryExport.storageUnavailable')
    expect(posts()).toHaveLength(0)
  } finally {
    write.mockRestore()
  }
})

it('prevents duplicate clicks while a confirmed request is in flight', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let finish: (() => void) | undefined
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (options?.method === 'POST')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return normal(url, options)
  })
  show()
  await open()
  await inspect()
  const button = screen.getByRole('button', { name: 'summaryExport.confirm' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(posts()).toHaveLength(1))
  finish!()
  await screen.findByText('summaryExport.accepted')
})

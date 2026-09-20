import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { TranscriptReplacementControl } from './TranscriptReplacementControl'
const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const preview = {
  preview_hash: 'a'.repeat(64),
  occurrences: 1,
  changes: [
    { id: 'row', start_ms: 1000, before: 'Hello word', after: 'Hello world' },
  ],
}
const receipt = {
  id: 'batch',
  find: 'word',
  replacement: 'world',
  changed_segments: 1,
  created_at: '2026-09-20T07:00:00Z',
  undone: false,
}
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TranscriptReplacementControl viewerId="owner" recordId="record" />
    </QueryClientProvider>
  )
}
function mock() {
  mocks.fetchApi.mockImplementation((path: string, options?: RequestInit) => {
    if (!options?.method) return Promise.resolve({ results: [] })
    return Promise.resolve(path.endsWith('preview/') ? preview : receipt)
  })
}
async function prepare() {
  fireEvent.click(screen.getByRole('button', { name: 'batchCorrection.title' }))
  await waitFor(() =>
    expect(screen.getByLabelText('batchCorrection.find')).toBeEnabled()
  )
  fireEvent.change(screen.getByLabelText('batchCorrection.find'), {
    target: { value: 'word' },
  })
  fireEvent.change(screen.getByLabelText('batchCorrection.replacement'), {
    target: { value: 'world' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'batchCorrection.preview' })
  )
  await screen.findByText('batchCorrection.after: Hello world')
}
afterEach(() => {
  client?.clear()
  vi.resetAllMocks()
  sessionStorage.clear()
})

it('previews before committing and invalidates the preview when text changes', async () => {
  mock()
  show()
  await prepare()
  expect(mocks.fetchApi.mock.calls.filter(([, o]) => o?.method).length).toBe(1)
  fireEvent.change(screen.getByLabelText('batchCorrection.replacement'), {
    target: { value: 'earth' },
  })
  expect(
    screen.queryByRole('button', { name: 'batchCorrection.confirm' })
  ).toBeNull()
})

it('keeps the exact intent across response loss and remount, without automatic resubmission', async () => {
  mock()
  const view = show()
  await prepare()
  mocks.fetchApi.mockRejectedValueOnce(new TypeError('Lost response'))
  fireEvent.click(
    screen.getByRole('button', { name: 'batchCorrection.confirm' })
  )
  await screen.findByText('batchCorrection.pending')
  const saved = sessionStorage.getItem('transcript-replacement:owner:record')
  expect(JSON.parse(saved!).expected_hash).toBe(preview.preview_hash)
  view.unmount()
  client.clear()
  mock()
  show()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'batchCorrection.retry' })
    ).toBeEnabled()
  )
  expect(
    mocks.fetchApi.mock.calls.filter(
      ([p, o]) => p.endsWith('transcript-replacements/') && o?.method
    ).length
  ).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'batchCorrection.retry' }))
  await screen.findByText('batchCorrection.applied')
  const writes = mocks.fetchApi.mock.calls.filter(
    ([p, o]) => p.endsWith('transcript-replacements/') && o?.method
  )
  expect(writes[1][1].body).toBe(writes[0][1].body)
  expect(sessionStorage.length).toBe(0)
})

it('a stale preview requires a new preview rather than silently resubmitting', async () => {
  mock()
  show()
  await prepare()
  mocks.fetchApi.mockRejectedValueOnce(new ApiError(409, {}))
  fireEvent.click(
    screen.getByRole('button', { name: 'batchCorrection.confirm' })
  )
  await screen.findByText('batchCorrection.conflict')
  expect(
    screen.queryByRole('button', { name: 'batchCorrection.confirm' })
  ).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it('requires explicit undo confirmation and preserves the target on conflict', async () => {
  mocks.fetchApi.mockResolvedValue({ results: [receipt] })
  show()
  fireEvent.click(screen.getByRole('button', { name: 'batchCorrection.title' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'batchCorrection.undo' })
  )
  expect(mocks.fetchApi.mock.calls.every(([, o]) => !o.method)).toBe(true)
  mocks.fetchApi.mockRejectedValueOnce(new ApiError(409, {}))
  fireEvent.click(
    screen.getByRole('button', { name: 'batchCorrection.confirmUndo' })
  )
  await screen.findByText('batchCorrection.conflict')
  expect(mocks.fetchApi.mock.calls.at(-1)?.[0]).toContain('/batch/undo/')
})

it('hides preview and history after access refresh fails', async () => {
  mock()
  show()
  await prepare()
  mocks.fetchApi.mockRejectedValue(new ApiError(403, {}))
  await client.invalidateQueries({
    queryKey: ['transcript-replacements', 'owner', 'record'],
  })
  await waitFor(() =>
    expect(screen.queryByText('batchCorrection.after: Hello world')).toBeNull()
  )
  expect(
    screen.getByRole('button', { name: 'batchCorrection.preview' })
  ).toBeDisabled()
})

it('malformed recovery data blocks new writes', async () => {
  sessionStorage.setItem('transcript-replacement:owner:record', '{}')
  mock()
  show()
  fireEvent.click(screen.getByRole('button', { name: 'batchCorrection.title' }))
  await screen.findByText('batchCorrection.storageError')
  expect(screen.getByLabelText('batchCorrection.find')).toBeDisabled()
})

it('keeps an uncertain request across temporary permission loss', async () => {
  mock()
  show()
  await prepare()
  mocks.fetchApi.mockRejectedValueOnce(new ApiError(403, {}))
  fireEvent.click(
    screen.getByRole('button', { name: 'batchCorrection.confirm' })
  )
  await screen.findByText('batchCorrection.pending')
  await screen.findByText('batchCorrection.error')
  expect(
    sessionStorage.getItem('transcript-replacement:owner:record')
  ).not.toBeNull()
  expect(screen.getByLabelText('batchCorrection.find')).toBeDisabled()
})

it('does not carry preview or a retry marker into a different viewer', async () => {
  mock()
  const view = show()
  await prepare()
  view.rerender(
    <QueryClientProvider client={client}>
      <TranscriptReplacementControl viewerId="reader" recordId="record" />
    </QueryClientProvider>
  )
  expect(screen.queryByText('batchCorrection.after: Hello world')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'batchCorrection.title' }))
  expect(screen.getByLabelText('batchCorrection.find')).toHaveValue('')
  expect(screen.queryByText('batchCorrection.pending')).toBeNull()
})

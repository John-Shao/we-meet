import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import type { ApiMeetingRecord } from '../api/ApiMeetingRecord'
import { RecordTrashControl, RecordTrashLibrary } from './RecordTrash'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn(), navigate: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('wouter', () => ({ useLocation: () => ['', mocks.navigate] }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const record = {
  id: 'record',
  title: 'Private record',
  lifecycle_revision: 2,
  capabilities: { trash: true },
} as ApiMeetingRecord
const row = {
  id: 'record',
  title: 'Trashed record',
  lifecycle_revision: 3,
  deleted_at: '2026-09-20T00:00:00Z',
}
function show(library = false, value = record) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      {library ? (
        <RecordTrashLibrary viewerId="owner" />
      ) : (
        <RecordTrashControl viewerId="owner" record={value} />
      )}
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => client?.clear())

it('does not offer removal without an explicit capability and revision', () => {
  show(false, {
    ...record,
    capabilities: { ...record.capabilities, trash: false },
  })
  expect(screen.queryByRole('button')).toBeNull()
  expect(mocks.fetchApi).not.toHaveBeenCalled()
})
it('asks for confirmation and cancel never writes', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'trash.remove' }))
  await screen.findByText('trash.removeHint')
  expect(mocks.fetchApi).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'trash.cancel' }))
  expect(mocks.fetchApi).not.toHaveBeenCalled()
})
it('moves only the confirmed revision and returns to the library', async () => {
  mocks.fetchApi.mockResolvedValue(row)
  show()
  fireEvent.click(screen.getByRole('button', { name: 'trash.remove' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'trash.confirmRemove' })
  )
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith('/meeting/notes')
  )
  expect(JSON.parse(mocks.fetchApi.mock.calls[0][1].body)).toEqual({
    target: 'trashed',
    expected_revision: 2,
  })
})
it('retains the same request after an unknown result without automatic replay', async () => {
  mocks.fetchApi
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValue(row)
  show()
  fireEvent.click(screen.getByRole('button', { name: 'trash.remove' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'trash.confirmRemove' })
  )
  await screen.findByText('trash.uncertain')
  expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'trash.confirmRemove' }))
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled())
  expect(mocks.fetchApi.mock.calls[1][1].body).toBe(
    mocks.fetchApi.mock.calls[0][1].body
  )
})
it('does not replay after a conflict', async () => {
  mocks.fetchApi.mockRejectedValue(new ApiError(409, {}))
  show()
  fireEvent.click(screen.getByRole('button', { name: 'trash.remove' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'trash.confirmRemove' })
  )
  await screen.findByText('trash.conflict')
  expect(
    screen.getByRole('button', { name: 'trash.confirmRemove' })
  ).toBeDisabled()
  expect(mocks.navigate).not.toHaveBeenCalled()
})
it('pages metadata and restores the selected revision only after confirmation', async () => {
  mocks.fetchApi.mockImplementation(
    async (path: string, options: { method?: string }) =>
      options.method === 'PATCH'
        ? { ...row, deleted_at: null, lifecycle_revision: 4 }
        : {
            results: [row],
            next_cursor: path.includes('cursor') ? null : 'signed+cursor',
          }
  )
  show(true)
  fireEvent.click(screen.getByRole('button', { name: 'trash.title' }))
  fireEvent.click(await screen.findByRole('button', { name: 'library.next' }))
  await waitFor(() =>
    expect(
      mocks.fetchApi.mock.calls.some(([path]) =>
        path.includes('cursor=signed%2Bcursor')
      )
    ).toBe(true)
  )
  fireEvent.click(await screen.findByRole('button', { name: 'trash.restore' }))
  await screen.findByText('trash.restoreHint')
  expect(mocks.fetchApi.mock.calls.every(([, o]) => !o.method)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'trash.confirmRestore' }))
  await waitFor(() =>
    expect(
      mocks.fetchApi.mock.calls.some(([, o]) => o.method === 'PATCH')
    ).toBe(true)
  )
  const body = mocks.fetchApi.mock.calls.find(
    ([, o]) => o.method === 'PATCH'
  )![1].body
  expect(JSON.parse(body)).toEqual({ target: 'active', expected_revision: 3 })
})
it('clears private trash metadata after an access failure', async () => {
  mocks.fetchApi.mockResolvedValue({ results: [row], next_cursor: null })
  show(true)
  fireEvent.click(screen.getByRole('button', { name: 'trash.title' }))
  await screen.findByRole('button', { name: 'trash.restore' })
  mocks.fetchApi.mockRejectedValue(new ApiError(404, {}))
  await client.invalidateQueries({ queryKey: ['record-trash'] })
  await screen.findByText('trash.unavailable')
  expect(screen.queryByRole('button', { name: 'trash.restore' })).toBeNull()
  expect(screen.queryByText(/Trashed record/)).toBeNull()
})

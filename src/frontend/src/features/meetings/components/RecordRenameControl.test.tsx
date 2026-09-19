import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'

import { RecordRenameControl } from './RecordRenameControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function show(title = 'Private source') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RecordRenameControl viewerId="owner" recordId="record" title={title} />
    </QueryClientProvider>
  )
}

const patch = () =>
  mocks.fetchApi.mock.calls.find(([, options]) => options?.method === 'PATCH')

beforeEach(() => {
  vi.resetAllMocks()
})

it('sends the title the caller last saw as the conflict guard', async () => {
  mocks.fetchApi.mockResolvedValue({ id: 'record', title: 'Design review' })
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  const input = screen.getByLabelText('library.rename')
  fireEvent.change(input, { target: { value: 'Design review' } })
  fireEvent.click(screen.getByRole('button', { name: 'library.renameSave' }))
  await waitFor(() => expect(patch()).toBeTruthy())
  const [url, options] = patch()!
  expect(url).toBe('meeting-records/record/title/')
  expect(JSON.parse(options.body)).toEqual({
    title: 'Design review',
    // Without this the backend would happily overwrite a concurrent rename.
    expected_title: 'Private source',
  })
})

it('trims the draft but keeps an unchanged title from submitting', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  const input = screen.getByLabelText('library.rename')
  // Padding is trimmed on submit, so "  Private source  " is still a no-op.
  fireEvent.change(input, { target: { value: '  Private source  ' } })
  expect(
    screen.getByRole('button', { name: 'library.renameSave' })
  ).toBeDisabled()
  expect(patch()).toBeUndefined()
})

it('refuses an empty name without calling the API', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  fireEvent.change(screen.getByLabelText('library.rename'), {
    target: { value: '   ' },
  })
  expect(
    screen.getByRole('button', { name: 'library.renameSave' })
  ).toBeDisabled()
  expect(patch()).toBeUndefined()
})

it('reports a stale rename as a conflict rather than a generic failure', async () => {
  mocks.fetchApi.mockRejectedValue(
    new ApiError(409, { code: 'record_title_changed' })
  )
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  fireEvent.change(screen.getByLabelText('library.rename'), {
    target: { value: 'Renamed' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.renameSave' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'library.renameConflict'
  )
})

it('reports any other failure as a generic error', async () => {
  mocks.fetchApi.mockRejectedValue(new ApiError(400, {}))
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  fireEvent.change(screen.getByLabelText('library.rename'), {
    target: { value: 'Renamed' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.renameSave' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'library.renameError'
  )
})

it('cancel restores the original title and closes the editor', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  fireEvent.change(screen.getByLabelText('library.rename'), {
    target: { value: 'Abandoned' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.renameCancel' }))
  expect(screen.queryByLabelText('library.rename')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'library.rename' }))
  expect(screen.getByLabelText('library.rename')).toHaveValue('Private source')
})

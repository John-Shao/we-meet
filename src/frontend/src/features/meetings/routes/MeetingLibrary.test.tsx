import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Library } from './MeetingLibrary'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const archived = {
  id: 'archived',
  title: 'Archived private record',
  source_type: 'audio_recording',
  origin_at: '2026-09-13T00:00:00Z',
  has_summary: true,
}
function show(minutes = false, viewerId = 'owner') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Library key={viewerId} viewerId={viewerId} minutes={minutes} />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    const params = new URL(path, 'https://fixture.invalid').searchParams
    if (params.get('is_ongoing') === 'true')
      return {
        results: [
          { ...archived, id: 'active', title: 'Older paused recording' },
        ],
        next_cursor: null,
      }
    if (params.get('cursor'))
      return {
        results: [{ ...archived, id: 'page2', title: 'Second page' }],
        next_cursor: null,
      }
    return { results: [archived], next_cursor: 'a+/=' }
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
})

it('pins ongoing records separately and follows the exact opaque archive cursor', async () => {
  show()
  expect(
    await screen.findByRole('link', { name: archived.title })
  ).toHaveAttribute('href', '/meeting/records/archived')
  expect(
    await screen.findByRole('link', { name: 'Older paused recording' })
  ).toHaveAttribute('href', '/meeting/records/active')
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  expect(await screen.findByText('Second page')).toBeInTheDocument()
  expect(screen.queryByText(archived.title)).not.toBeInTheDocument()
  expect(screen.getByText('Older paused recording')).toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(
        ([path]) =>
          new URL(path, 'https://fixture.invalid').searchParams.get(
            'cursor'
          ) === 'a+/='
      )
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'library.previous' }))
  expect(await screen.findByText(archived.title)).toBeInTheDocument()
})

it('minutes uses the same record link with server-side summary and permission filters', async () => {
  show(true)
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  await screen.findByText('Second page')
  fireEvent.change(screen.getByLabelText('library.scopeLabel'), {
    target: { value: 'shared' },
  })
  await screen.findByText(archived.title)
  const calls = vi
    .mocked(fetchApi)
    .mock.calls.map(
      ([path]) => new URL(path, 'https://fixture.invalid').searchParams
    )
  expect(calls.every((params) => params.get('has_summary') === 'true')).toBe(
    true
  )
  expect(
    calls
      .filter((params) => params.get('scope') === 'shared')
      .every((params) => !params.get('cursor'))
  ).toBe(true)
  expect(screen.getByRole('link', { name: archived.title })).toHaveAttribute(
    'href',
    '/meeting/records/archived'
  )
  fireEvent.change(screen.getByLabelText('library.search'), {
    target: { value: '  title & 中文  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.searchButton' }))
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(
          ([path]) =>
            new URL(path, 'https://fixture.invalid').searchParams.get('q') ===
            'title & 中文'
        )
    ).toBe(true)
  )
})

it('hides previously cached titles after a permission check fails', async () => {
  show()
  await screen.findByText(archived.title)
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(403, {}))
  await client.invalidateQueries({ queryKey: ['meeting-records', 'owner'] })
  await waitFor(() =>
    expect(screen.queryByText(archived.title)).not.toBeInTheDocument()
  )
  expect(screen.queryByText('Older paused recording')).not.toBeInTheDocument()
  expect(screen.getAllByRole('alert')).toHaveLength(2)
})

it('does not reuse another account’s loaded records', async () => {
  const view = show()
  await screen.findByText(archived.title)
  vi.mocked(fetchApi).mockImplementation(() => new Promise(() => {}))
  view.rerender(
    <QueryClientProvider client={client}>
      <Library key="other" viewerId="other" />
    </QueryClientProvider>
  )
  expect(screen.queryByText(archived.title)).not.toBeInTheDocument()
  expect(within(screen.getByRole('main')).getAllByRole('status')).toHaveLength(
    2
  )
})

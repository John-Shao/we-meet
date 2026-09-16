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
  window.history.replaceState({}, '', '/meeting/notes')
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

it('keeps upload and participation filters available and clears a submitted search', async () => {
  show()
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.filters' }))
  fireEvent.change(screen.getByLabelText('library.sourceLabel'), {
    target: { value: 'upload' },
  })
  fireEvent.change(
    screen.getByLabelText('library.scopeLabel', { selector: 'select' }),
    { target: { value: 'participated' } }
  )
  fireEvent.change(screen.getByLabelText('library.search'), {
    target: { value: 'Project' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.searchButton' }))
  await waitFor(() =>
    expect(
      vi.mocked(fetchApi).mock.calls.some(([path]) => {
        const params = new URL(path, 'https://fixture.invalid').searchParams
        return (
          params.get('q') === 'Project' &&
          params.get('scope') === 'participated' &&
          params.get('source_type') === 'upload'
        )
      })
    ).toBe(true)
  )
  fireEvent.change(screen.getByLabelText('library.search'), {
    target: { value: '' },
  })
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.filter(([path]) => path.includes('meeting-records'))
        .slice(-2)
        .every(
          ([path]) =>
            !new URL(path, 'https://fixture.invalid').searchParams.get('q')
        )
    ).toBe(true)
  )
})

it('minutes opens the summary reader and filters ownership on the server', async () => {
  show(true)
  await screen.findByText(archived.title)
  // 范围筛选收口到共享 SegmentedControl,语义是 tablist/tab(页内阅读模式),
  // 不再是页面手写的一组 aria-pressed 按钮。
  expect(
    screen.getByRole('tab', { name: 'minutesLibrary.scope.owned' })
  ).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(
    screen.getByRole('tab', { name: 'minutesLibrary.scope.participated' })
  )
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([path]) => path.includes('scope=participated'))
    ).toBe(true)
  )
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  await screen.findByText('Second page')
  fireEvent.click(
    screen.getByRole('tab', { name: 'minutesLibrary.scope.shared' })
  )
  await screen.findByText(archived.title)
  // 只看记录接口的请求:这一页现在还会读一次全局 config(页内那行导航要用它
  // 决定显不显示「AI 录音」),那条请求没有 has_summary 这回事。
  const calls = vi
    .mocked(fetchApi)
    .mock.calls.filter(([path]) => path.includes('meeting-records'))
    .map(([path]) => new URL(path, 'https://fixture.invalid').searchParams)
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
    '/meeting/records/archived?tab=summary'
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

it('applies the video filter when opened from More', async () => {
  window.history.replaceState({}, '', '/meeting/notes?source_type=meeting')
  show()
  await screen.findByText(archived.title)
  const reads = vi
    .mocked(fetchApi)
    .mock.calls.filter(([path]) => path.startsWith('meeting-records/'))
  expect(reads.length).toBeGreaterThan(0)
  expect(
    reads.every(
      ([path]) =>
        new URL(path, 'https://fixture.invalid').searchParams.get(
          'source_type'
        ) === 'meeting'
    )
  ).toBe(true)
})

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

/** 搜索框没有提交按钮了:回车(表单提交)是唯一的提交方式。 */
const submitSearch = () =>
  fireEvent.submit(
    screen.getByLabelText('library.search').closest('form') as HTMLFormElement
  )

it('applies creation dates to both sections, resets pagination, and clears dates', async () => {
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    const params = new URL(path, 'https://fixture.invalid').searchParams
    return {
      results: params.get('is_ongoing') === 'true' ? [] : [archived],
      next_cursor: params.has('cursor') ? null : 'page2',
      supported_filters: ['created_from', 'created_before'],
    }
  })
  show()
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  await screen.findByRole('button', { name: 'library.previous' })
  fireEvent.click(screen.getByRole('button', { name: 'library.filters' }))
  fireEvent.change(screen.getByLabelText('library.createdFrom'), {
    target: { value: '2026-09-20' },
  })
  fireEvent.change(screen.getByLabelText('library.createdThrough'), {
    target: { value: '2026-09-20' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.applyDates' }))
  await waitFor(() => {
    const calls = vi
      .mocked(fetchApi)
      .mock.calls.map(
        ([path]) => new URL(path, 'https://fixture.invalid').searchParams
      )
      .filter((params) => params.has('created_from'))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(
      calls.every(
        (params) =>
          !params.has('cursor') &&
          params.get('created_from') === new Date(2026, 8, 20).toISOString() &&
          params.get('created_before') === new Date(2026, 8, 21).toISOString()
      )
    ).toBe(true)
  })
  expect(screen.queryByRole('button', { name: 'library.previous' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'library.clearDates' }))
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.slice(-2)
        .every(([path]) => !path.includes('created_from'))
    ).toBe(true)
  )
})

it('does not display unfiltered content when an older server ignores date filters', async () => {
  show()
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.filters' }))
  fireEvent.change(screen.getByLabelText('library.createdFrom'), {
    target: { value: '2026-09-20' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.applyDates' }))
  await screen.findAllByText('library.loadError')
  expect(screen.queryByText(archived.title)).toBeNull()
  expect(screen.queryByText('Older paused recording')).toBeNull()
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
  submitSearch()
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
  submitSearch()
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

it('requests creation-time sorting from the server and preserves response order', async () => {
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    const params = new URL(path, 'https://fixture.invalid').searchParams
    if (params.get('is_ongoing') === 'true')
      return { results: [], next_cursor: null }
    return {
      results: [
        {
          ...archived,
          id: 'older',
          title: 'Older record',
          owner: 'Ann',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-02T00:00:00Z',
        },
        {
          ...archived,
          id: 'newer',
          title: 'Newer record',
          owner: 'Bob',
          created_at: '2026-09-09T00:00:00Z',
          updated_at: '2026-09-10T00:00:00Z',
        },
      ].sort((a, b) =>
        params.get('ordering') === 'created_at'
          ? a.created_at.localeCompare(b.created_at)
          : b.created_at.localeCompare(a.created_at)
      ),
      next_cursor: null,
    }
  })
  show()
  await screen.findByText('Newer record')
  const table = screen.getByRole('table')
  // 表头只出现一次,四列与飞书对齐;分组名是表内的行组标题。
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
  ).toEqual([
    'library.table.title',
    'library.table.owner',
    'library.table.modified',
    'library.table.created',
  ])
  expect(within(table).getByText('library.archive')).toBeInTheDocument()
  const rowTitles = () =>
    within(table)
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'))
  // 默认按创建时间降序(与列表服务端顺序一致),点表头切成升序。
  expect(rowTitles()).toEqual(['Newer record', 'Older record'])
  const createdAtHeader = within(table).getByRole('columnheader', {
    name: 'library.table.created',
  })
  expect(createdAtHeader).toHaveAttribute('aria-sort', 'descending')
  fireEvent.click(
    within(table).getByRole('button', { name: 'library.table.created' })
  )
  expect(createdAtHeader).toHaveAttribute('aria-sort', 'ascending')
  await waitFor(() =>
    expect(rowTitles()).toEqual(['Older record', 'Newer record'])
  )
})

it('drops both sections old cursors when switching global ordering', async () => {
  show()
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  await screen.findByText('Second page')
  vi.mocked(fetchApi).mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'library.table.created' }))
  await screen.findByText(archived.title)
  const queries = vi
    .mocked(fetchApi)
    .mock.calls.filter(([path]) => path.startsWith('meeting-records/?'))
    .map(([path]) => new URL(path, 'https://fixture.invalid').searchParams)
  expect(queries.length).toBeGreaterThan(0)
  expect(
    queries.every(
      (params) =>
        params.get('ordering') === 'created_at' && !params.has('cursor')
    )
  ).toBe(true)
})

it('keeps the loaded page when switching between the table and the grid', async () => {
  show()
  await screen.findByText(archived.title)
  fireEvent.click(screen.getByRole('button', { name: 'library.next' }))
  await screen.findByText('Second page')
  // 两个视图同一份数据:换视图不重挂列表组件,翻过的页不丢。
  fireEvent.click(screen.getByRole('button', { name: 'library.gridView' }))
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByText('Second page')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'library.listView' }))
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByText('Second page')).toBeInTheDocument()
})

it('labels an imported file by its media type instead of a blanket upload label', async () => {
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    const params = new URL(path, 'https://fixture.invalid').searchParams
    if (params.get('is_ongoing') === 'true')
      return { results: [], next_cursor: null }
    return {
      results: [
        {
          ...archived,
          id: 'clip',
          title: 'Kickoff.mp4',
          source_type: 'upload',
          upload: {
            media_type: 'video',
            name: 'Kickoff.mp4',
            size: 1024,
            status: 'succeeded',
          },
        },
      ],
      next_cursor: null,
    }
  })
  show()
  const row = await screen.findByRole('link', { name: 'Kickoff.mp4' })
  // 同一条记录在「AI 录音」页写的就是 upload.video:记录库不能退回笼统的通用标签。
  expect(within(row).getByText('upload.video')).toBeInTheDocument()
  expect(
    within(row).queryByText('library.source.upload')
  ).not.toBeInTheDocument()
})

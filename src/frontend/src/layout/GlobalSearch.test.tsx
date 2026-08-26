import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '@/features/tasks/api/ApiTask'
import { EMPTY_TASK_SEARCH_FILTERS } from '@/features/tasks/api/searchTasks'

import { SearchPalette } from './GlobalSearch'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  close: vi.fn(),
  taskSearch: vi.fn(),
  taskRefetch: vi.fn(),
  taskFetchNextPage: vi.fn(),
  fetchApi: vi.fn(),
  searchMessages: vi.fn(),
  abortAsk: vi.fn(),
  taskSearchError: false,
}))

vi.mock('wouter', () => ({ useLocation: () => ['', mocks.navigate] }))
vi.mock('@/components/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('@/navigation/navigateTo', () => ({ navigateTo: vi.fn() }))
vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ alert: vi.fn() }),
}))
vi.mock('@/features/contacts', async () => {
  const React = await import('react')
  return {
    useDirectoryMemberSearch: () => {
      const [query, setQuery] = React.useState('')
      return {
        query,
        setQuery,
        selectable: [],
        isFetching: false,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }
    },
  }
})
vi.mock('@/features/im/api/createDirectConversation', () => ({
  createDirectConversationByUserId: vi.fn(),
}))
vi.mock('@/features/im/api/searchImMessages', () => ({
  searchImMessages: mocks.searchMessages,
}))
vi.mock('@/features/im/api/resolveImUsers', () => ({
  resolveImUsers: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/features/im/api/fetchImToken', () => ({
  fetchImToken: vi.fn().mockResolvedValue({ uid: 'self' }),
}))
vi.mock('@/features/meetings/api/fetchMeeting', () => ({
  useRecentMeetings: () => ({ data: [] }),
  useScheduledMeetings: () => ({ data: [] }),
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({ data: { search_ai: { enabled: false } } }),
}))
vi.mock('@/features/global-ask/useGlobalAsk', () => ({
  useGlobalAsk: () => ({
    state: {
      status: 'idle',
      answer: '',
      citations: [],
      citationsUsed: [],
      degraded: false,
      sources: {},
    },
    ask: vi.fn(),
    abort: mocks.abortAsk,
  }),
}))
vi.mock('@/features/tasks/api/searchTasks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/tasks/api/searchTasks')>()
  return { ...actual, useTaskSearch: mocks.taskSearch }
})

const task = (index: number): ApiTask =>
  ({
    id: `00000000-0000-0000-0000-00000000000${index}`,
    title: `Launch plan ${index}`,
    description: `Detailed launch plan description ${index}`,
    creator: {
      id: 'creator',
      full_name: 'Creator One',
      short_name: null,
      email: null,
      avatar_url: '',
    },
    assignee: null,
    assignees: [],
    followers: [],
    status: 'todo',
    priority: 'medium',
    task_list: null,
    group: null,
    parent_id: null,
    depth: 0,
    ancestor_path: [
      {
        id: `00000000-0000-0000-0000-00000000000${index}`,
        title: `Launch plan ${index}`,
        depth: 0,
      },
    ],
    descendant_progress: { completed: 0, total: 0 },
    can_create_subtasks: true,
    position: 0,
    start_date: null,
    due_date: null,
    completed_at: null,
    source_action_item_id: null,
    source_room_id: null,
    source_room_name: null,
    can_edit: true,
    can_update_status: true,
    can_delete: true,
    can_comment: true,
    can_manage_attachments: true,
    can_manage_followers: true,
    is_following: false,
    time_state: null,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
  }) as ApiTask

const tasks = Array.from({ length: 6 }, (_, index) => task(index + 1))

const searchResult = (pageSize: number, enabled: boolean) => ({
  data:
    enabled && !mocks.taskSearchError
      ? {
          pages: [
            {
              count: tasks.length,
              next: pageSize === 5 ? 'next' : null,
              previous: null,
              results: tasks.slice(0, pageSize),
            },
          ],
        }
      : undefined,
  isFetching: false,
  isError: enabled && mocks.taskSearchError,
  refetch: mocks.taskRefetch,
  hasNextPage: enabled && pageSize === 20 && !mocks.taskSearchError,
  isFetchingNextPage: false,
  fetchNextPage: mocks.taskFetchNextPage,
})

const renderPalette = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SearchPalette onClose={mocks.close} />
    </QueryClientProvider>
  )
}

describe('global task search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tasks[0].parent_id = null
    tasks[0].depth = 0
    tasks[0].ancestor_path = [
      { id: tasks[0].id, title: tasks[0].title, depth: 0 },
    ]
    mocks.taskSearchError = false
    mocks.fetchApi.mockResolvedValue({ results: [], has_more: false })
    mocks.searchMessages.mockResolvedValue({
      items: [],
      next_before_mid: 0,
    })
    mocks.taskSearch.mockImplementation((_query, _filters, pageSize, enabled) =>
      searchResult(pageSize, enabled)
    )
  })

  it('starts at two characters, truncates All, and deep-links a result', async () => {
    const user = userEvent.setup()
    renderPalette()
    const input = screen.getByTestId('global-search-input')

    await user.type(input, 'L')
    expect(
      mocks.taskSearch.mock.calls.some(
        ([query, , pageSize, enabled]) =>
          query === 'L' && pageSize === 5 && enabled
      )
    ).toBe(false)

    await user.type(input, 'aunch')
    expect(await screen.findAllByTestId(/^global-search-task-/)).toHaveLength(5)
    expect(screen.getByTestId('global-search-tasks-more')).toBeInTheDocument()

    await user.click(screen.getByTestId(`global-search-task-${tasks[0].id}`))
    expect(mocks.close).toHaveBeenCalled()
    expect(mocks.navigate).toHaveBeenCalledWith(
      `/tasks?scope=all&status=all&time=all&priority=all&task_list=all&view=list&task=${tasks[0].id}`
    )
  })

  it('keeps task filters while switching categories and clears them together', async () => {
    const user = userEvent.setup()
    renderPalette()
    await user.type(screen.getByTestId('global-search-input'), 'Launch')
    await user.click(screen.getByTestId('global-search-tab-tasks'))
    await user.click(screen.getByTestId('global-search-tasks-load-more'))
    expect(mocks.taskFetchNextPage).toHaveBeenCalled()

    await user.click(screen.getByTestId('global-search-task-filter-status'))
    await user.click(
      await screen.findByTestId('global-search-task-filter-status-todo')
    )
    await waitFor(() =>
      expect(mocks.taskSearch).toHaveBeenCalledWith(
        'Launch',
        expect.objectContaining({ status: 'todo' }),
        20,
        true
      )
    )

    await user.click(screen.getByTestId('global-search-tab-all'))
    expect(mocks.taskSearch).toHaveBeenCalledWith(
      'Launch',
      EMPTY_TASK_SEARCH_FILTERS,
      5,
      true
    )
    await user.click(screen.getByTestId('global-search-tab-tasks'))
    expect(
      screen.getByTestId('global-search-task-filter-status')
    ).toHaveTextContent('search.taskStatusTodo')

    fireEvent.click(screen.getByTestId('global-search-task-clear-filters'))
    const latestFilteredCall = [...mocks.taskSearch.mock.calls]
      .reverse()
      .find(([, , pageSize, enabled]) => pageSize === 20 && enabled)
    expect(latestFilteredCall?.[1]).toEqual(EMPTY_TASK_SEARCH_FILTERS)
  })

  it('renders safe title and description highlights', async () => {
    const user = userEvent.setup()
    renderPalette()
    await user.type(screen.getByTestId('global-search-input'), 'Launch')
    const row = await screen.findByTestId(`global-search-task-${tasks[0].id}`)

    expect(within(row).getAllByText(/launch/i)).toHaveLength(2)
    expect(within(row).getAllByText(/launch/i)[0].tagName).toBe('MARK')
  })

  it('shows the complete ancestor chain for a matching subtask', async () => {
    tasks[0].parent_id = 'root'
    tasks[0].depth = 2
    tasks[0].ancestor_path = [
      { id: 'root', title: 'Release', depth: 0 },
      { id: 'parent', title: 'Backend', depth: 1 },
      { id: tasks[0].id, title: tasks[0].title, depth: 2 },
    ]
    const user = userEvent.setup()
    renderPalette()

    await user.type(screen.getByTestId('global-search-input'), 'Launch')

    expect(
      await screen.findByTestId(`global-search-task-${tasks[0].id}`)
    ).toHaveTextContent('Release › Backend › Launch plan 1')
  })

  it('isolates a task-source failure and offers retry in the task tab', async () => {
    mocks.taskSearchError = true
    const user = userEvent.setup()
    renderPalette()
    await user.type(screen.getByTestId('global-search-input'), 'Launch')
    await user.click(screen.getByTestId('global-search-tab-tasks'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'search.taskError'
    )
    await user.click(screen.getByTestId('global-search-task-retry'))
    expect(mocks.taskRefetch).toHaveBeenCalled()
  })

  it('projects rich-card message results to readable text without exposing JSON', async () => {
    mocks.searchMessages.mockResolvedValue({
      items: [
        {
          mid: 101,
          cid: 'task-assistant',
          sender_uid: 'bot',
          seq: 7,
          content_type: 'rich-card',
          body: JSON.stringify({
            plain: '任务今天开始：人员招聘',
            v: 1,
            blocks: [
              {
                type: 'text',
                spans: [{ tag: 'text', text: '任务今天开始：人员招聘' }],
              },
            ],
          }),
          created_at: Date.UTC(2026, 7, 24),
        },
        {
          mid: 102,
          cid: 'task-assistant',
          sender_uid: 'bot',
          seq: 8,
          content_type: 'rich-card',
          body: '{ malformed card JSON',
          created_at: Date.UTC(2026, 7, 24),
        },
      ],
      next_before_mid: 0,
    })

    const user = userEvent.setup()
    renderPalette()
    await user.type(screen.getByTestId('global-search-input'), '招聘')

    const validCard = await screen.findByTestId('global-search-msg-101')
    expect(validCard).toHaveTextContent('任务今天开始：人员招聘')
    expect(validCard).not.toHaveTextContent('[rich-card]')
    expect(validCard).not.toHaveTextContent('"plain"')

    const malformedCard = screen.getByTestId('global-search-msg-102')
    expect(malformedCard).toHaveTextContent('preview.richCard')
    expect(malformedCard).not.toHaveTextContent('malformed card JSON')
  })
})

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MyWorkPage } from './MyWorkPage'

// /work/items is a shipped route with a rule that is easy to break and invisible in a
// snapshot: the ?view= parameter is only accepted from a fixed list, anything else falls back
// to 'all'. That guard is what stops an arbitrary query string from becoming a server-side
// filter value, and the page also switches its empty-state copy per view, so a wrong fallback
// would show the guidance meant for a different view.

type PageFixture = {
  items: { task_id: string; title: string }[]
  next_cursor: string | null
}

const mocks = vi.hoisted(() => ({
  requestedView: null as string | null,
  search: '',
  pages: [] as { items: { task_id: string; title: string }[] }[],
  hasNextPage: false,
  isLoading: false,
  isError: false,
  isFetchingNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}))

vi.mock('wouter', () => ({
  // aria-current has to survive the mock, or the test would only prove that a link exists
  // rather than which view the page marks as current.
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useSearchParams: () => [new URLSearchParams(mocks.search), vi.fn()],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../api/queries', () => ({
  useWorkTasks: (view: string) => {
    mocks.requestedView = view
    return {
      data: { pages: mocks.pages },
      isLoading: mocks.isLoading,
      isError: mocks.isError,
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: mocks.isFetchingNextPage,
      refetch: mocks.refetch,
      fetchNextPage: mocks.fetchNextPage,
    }
  },
}))

vi.mock('../components/TaskCard', () => ({
  TaskCard: ({ task }: { task: { task_id: string; title: string } }) => (
    <div>{task.title}</div>
  ),
}))

const task = (taskId: string, title: string): PageFixture['items'][number] => ({
  task_id: taskId,
  title,
})

const renderPage = () => render(<MyWorkPage />)

beforeEach(() => {
  mocks.requestedView = null
  mocks.search = ''
  mocks.pages = []
  mocks.hasNextPage = false
  mocks.isLoading = false
  mocks.isError = false
  mocks.isFetchingNextPage = false
  mocks.refetch.mockReset()
  mocks.fetchNextPage.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('my work page', () => {
  it('accepts only the five views and falls back to all', () => {
    for (const view of [
      'pending',
      'running',
      'awaiting_acceptance',
      'completed',
      'all',
    ]) {
      mocks.search = `view=${view}`
      renderPage()
      expect(mocks.requestedView).toBe(view)
      const tab = screen.getByRole('link', { name: `items.view.${view}` })
      expect(tab).toHaveAttribute('aria-current', 'page')
      // The tab has to navigate to this page with its own view, not somewhere else.
      expect(tab).toHaveAttribute('href', `/work/items?view=${view}`)
      cleanup()
    }

    // Anything outside the list must not reach the query, including a value that would be a
    // legal view if it arrived with different casing or extra text.
    for (const junk of [
      'view=RUNNING',
      'view=secret',
      'view=',
      'view=all;drop',
    ]) {
      mocks.search = junk
      renderPage()
      expect(mocks.requestedView).toBe('all')
      expect(
        screen.getByRole('link', { name: 'items.view.all' })
      ).toHaveAttribute('aria-current', 'page')
      cleanup()
    }

    mocks.search = ''
    renderPage()
    expect(mocks.requestedView).toBe('all')
  })

  it('shows the empty guidance that belongs to the selected view', () => {
    mocks.search = 'view=pending'
    renderPage()
    expect(screen.getByText('items.empty.pending.title')).toBeInTheDocument()

    cleanup()
    mocks.search = 'view=completed'
    renderPage()
    expect(screen.getByText('items.empty.completed.title')).toBeInTheDocument()
    expect(
      screen.queryByText('items.empty.pending.title')
    ).not.toBeInTheDocument()
  })

  it('renders the accumulated pages as cards', () => {
    mocks.pages = [
      { items: [task('task-1', 'First task')] },
      { items: [task('task-2', 'Second task')] },
    ]
    renderPage()
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
    expect(screen.queryByText('items.empty.all.title')).not.toBeInTheDocument()
  })

  it('offers a retry that actually refetches when the list fails', async () => {
    mocks.search = 'view=running'
    mocks.isError = true
    renderPage()
    expect(screen.getByText('items.errorTitle')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
  })

  it('shows loading, then a load-more control only while another page exists', async () => {
    mocks.isLoading = true
    renderPage()
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'items.loadMore' })
    ).not.toBeInTheDocument()
    cleanup()

    mocks.isLoading = false
    mocks.pages = [{ items: [task('task-1', 'First task')] }]
    mocks.hasNextPage = true
    renderPage()
    const more = screen.getByRole('button', { name: 'items.loadMore' })
    await userEvent.click(more)
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1)
  })
})

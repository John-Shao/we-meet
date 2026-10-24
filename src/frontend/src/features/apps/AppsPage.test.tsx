import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import zh from '@/locales/zh/apps.json'
import shell from '@/locales/zh/shell.json'
import { AppsContent } from './AppsPage'
import { AppRail } from '@/layout/AppRail'
import { useAppPreferences } from './useAppPreferences'

const session = vi.hoisted(() => ({ owner: 'alice', work: true, docs: true }))
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, args: Record<string, unknown> = {}) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          namespace === 'apps' ? zh : shell
        )
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(args[name] ?? '')
      )
    },
  }),
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({
    user: { id: session.owner, full_name: 'Tester' },
    isLoggedIn: true,
    logout: vi.fn(),
  }),
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({
    data: {
      work: { enabled: session.work },
      docs: { url: session.docs ? '/docs' : null },
    },
  }),
}))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/layout/GlobalSearch', () => ({ GlobalSearch: () => null }))
vi.mock('@/features/settings/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}))
vi.mock('@/features/im/components/ImUnreadProvider', () => ({
  useImUnread: () => ({ messages: 2 }),
}))
vi.mock('@/features/approval/api/fetchApproval', () => ({
  fetchApprovals: async () => [],
}))

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AppRail />
      <AppsContent ownerId={session.owner} workEnabled={session.work} />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  session.owner = 'alice'
  session.work = true
  session.docs = true
  window.history.replaceState(null, '', '/apps')
})

describe('App navigation and favorites', () => {
  it('shows six primary destinations and opens existing modules directly', () => {
    mount()
    const primary = screen.getAllByTestId(/^rail-\//)
    expect(primary.map((link) => link.getAttribute('href'))).toEqual([
      '/im',
      '/assistant',
      '/meeting',
      '/work',
      '/docs',
      '/apps',
    ])
    expect(screen.getByTestId('catalog-contacts')).toHaveAttribute(
      'href',
      '/contacts'
    )
    expect(screen.getByTestId('catalog-communication')).toHaveAttribute(
      'href',
      '/work?view=communication'
    )
  })
  it('adds, reorders and removes favorites while keeping rail shortcuts in sync', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '添加常用' }))
    fireEvent.click(screen.getByRole('button', { name: '添加通讯录' }))
    expect(
      screen.getAllByTestId(/^rail-shortcut-/).map((link) => link.textContent)
    ).toEqual(['日历', '任务', '审批', '通讯录'])
    fireEvent.click(screen.getByRole('button', { name: '管理常用' }))
    fireEvent.click(screen.getByRole('button', { name: '上移通讯录' }))
    expect(
      screen.getAllByTestId(/^rail-shortcut-/).map((link) => link.textContent)
    ).toEqual(['日历', '任务', '通讯录', '审批'])
    fireEvent.click(screen.getByRole('button', { name: '移除任务' }))
    expect(screen.queryByTestId('rail-shortcut-tasks')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
    expect(
      screen.getAllByTestId(/^rail-shortcut-/).map((link) => link.textContent)
    ).toEqual(['日历', '通讯录', '审批', '任务'])
  })
  it('filters categories and search and records visits through shortcuts', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'AI 工具' }))
    expect(screen.queryByTestId('catalog-calendar')).not.toBeInTheDocument()
    expect(screen.getByTestId('catalog-communication')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '表格' },
    })
    expect(
      screen.queryByTestId('catalog-communication')
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('rail-shortcut-calendar'))
    fireEvent.click(screen.getByRole('button', { name: '最近使用' }))
    expect(screen.getByTestId('catalog-calendar')).toBeInTheDocument()
    expect(screen.getByTestId('rail-/apps')).toHaveAttribute(
      'aria-current',
      'page'
    )
  })
  it('respects module availability without erasing saved favorites', () => {
    localStorage.setItem(
      'we-meet:apps:v1:alice',
      JSON.stringify({ favorites: ['calendar', 'communication'], recent: [] })
    )
    session.work = false
    session.docs = false
    mount()
    expect(screen.queryByTestId('rail-/work')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rail-/docs')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'AI 工具' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('rail-shortcut-communication')
    ).not.toBeInTheDocument()
    expect(
      JSON.parse(localStorage.getItem('we-meet:apps:v1:alice')!).favorites
    ).toContain('communication')
  })
})

describe('Favorite preferences', () => {
  it('isolates accounts immediately and persists an empty list on remount', () => {
    const view = renderHook(({ owner }) => useAppPreferences(owner), {
      initialProps: { owner: 'alice' },
    })
    act(() => {
      view.result.current.remove('calendar')
      view.result.current.remove('tasks')
      view.result.current.remove('approval')
    })
    expect(view.result.current.favorites).toEqual([])
    view.rerender({ owner: 'bob' })
    expect(view.result.current.favorites).toEqual([
      'calendar',
      'tasks',
      'approval',
    ])
    view.rerender({ owner: 'alice' })
    expect(view.result.current.favorites).toEqual([])
    view.unmount()
    const reopened = renderHook(() => useAppPreferences('alice'))
    expect(reopened.result.current.favorites).toEqual([])
  })
  it('handles malformed storage and changes from another browser tab', () => {
    localStorage.setItem('we-meet:apps:v1:alice', '{bad')
    const view = renderHook(() => useAppPreferences('alice'))
    expect(view.result.current.favorites).toEqual([
      'calendar',
      'tasks',
      'approval',
    ])
    act(() => {
      localStorage.setItem(
        'we-meet:apps:v1:alice',
        JSON.stringify({
          favorites: ['contacts', 'contacts', 'unknown', 'calendar'],
          recent: [],
        })
      )
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'we-meet:apps:v1:alice' })
      )
    })
    expect(view.result.current.favorites).toEqual(['contacts', 'calendar'])
  })
  it('remains usable when storage writes are blocked', () => {
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage full')
      })
    const view = renderHook(() => useAppPreferences('storage-blocked-user'))
    act(() => view.result.current.add('contacts'))
    expect(view.result.current.favorites.at(-1)).toBe('contacts')
    write.mockRestore()
  })
})

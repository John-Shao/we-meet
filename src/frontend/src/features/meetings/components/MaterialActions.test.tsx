import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { MaterialActions } from './MaterialActions'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/features/im/components/ShareToChatDialog', () => ({
  ShareToChatDialog: ({ body }: { body: string }) => <output>{body}</output>,
}))
// 基元 Select 是 RAC 的 button + listbox;这里换成原生 select,让「本批角色」
// 的选择在测试里是一步 setState,而不是点开弹层再点选项。
vi.mock('@/primitives/Select', () => ({
  Select: ({
    selectedKey,
    onSelectionChange,
    items,
    'aria-label': ariaLabel,
  }: {
    selectedKey: string
    onSelectionChange: (key: string) => void
    items: { value: string; label: React.ReactNode }[]
    'aria-label'?: string
  }) => (
    <select
      aria-label={ariaLabel}
      value={selectedKey}
      onChange={(event) => onSelectionChange(event.target.value)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.value}
        </option>
      ))}
    </select>
  ),
}))
// 选人面板本身有独立实现(通讯录搜索 / 来源切换 / 分页)。这里只保留它的
// 「勾选 + sources」出口,让本文件专注协作流程:邀请是否带上本批角色、改角色
// 是否直接提交、未确认回执能否用同一个编号重试。
vi.mock('@/features/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/contacts')>()),
  DirectoryMultiPicker: ({
    onToggle,
    selected,
    sources,
  }: {
    onToggle: (id: string, label: string) => void
    selected: Map<string, string>
    sources?: { value: string }[]
  }) => (
    <div data-testid="directory-multi-picker">
      <span data-testid="picker-sources">
        {sources?.map((source) => source.value).join(',')}
      </span>
      <button
        type="button"
        aria-pressed={selected.has('teammate')}
        onClick={() => onToggle('teammate', 'Teammate')}
      >
        Teammate
      </button>
    </div>
  ),
}))
let client: QueryClient
let revision = 0
const member = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Teammate',
  role: 'reader',
  active: true,
}
const posts = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
const postBody = (index: number) =>
  JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MaterialActions
        viewerId="viewer"
        recordId="record"
        scope="record"
        title="Review"
      />
    </QueryClientProvider>
  )
}
const openMembers = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.manage' }))
  await screen.findByText('Teammate')
}
const openInvite = async () => {
  await openMembers()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.invite' }))
  await screen.findByTestId('directory-multi-picker')
}
const confirmInvite = () => {
  const buttons = screen.getAllByRole('button', {
    name: 'collaboration.invite',
  })
  fireEvent.click(buttons[buttons.length - 1])
}
beforeEach(() => {
  sessionStorage.clear()
  revision = 0
  vi.mocked(fetchApi).mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') return {}
    return {
      scope: 'record',
      record_id: 'record',
      revision,
      can_manage: true,
      is_owner: true,
      results: [member],
      count: 1,
      link_scope: 'private',
      can_link_organization: true,
      can_notify: true,
      pending_notifications: 0,
    }
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
})

it('keeps sharing separate from permissions and sends the recording scope without granting access', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.share' }))
  expect(
    screen.getByRole('button', { name: 'collaboration.copy' })
  ).toBeInTheDocument()
  expect(
    screen.queryByText('collaboration.permissions')
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.send' }))
  expect(screen.getByRole('status').textContent).toContain('"scope":"record"')
  expect(posts()).toHaveLength(0)
})

it('invites the picked people in one step, with one role for the batch', async () => {
  show()
  await openInvite()
  // 来源切换交给共享面板:用户 + 部门(纪要才多一个用户组)。
  expect(screen.getByTestId('picker-sources').textContent).toBe(
    'users,departments'
  )
  // 默认角色是可阅读 —— 与截图里的初始角色一致。
  expect(screen.getByLabelText('collaboration.role')).toHaveValue('reader')
  fireEvent.click(screen.getByRole('button', { name: 'Teammate' }))
  expect(screen.getByRole('button', { name: 'Teammate' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  fireEvent.change(screen.getByLabelText('collaboration.role'), {
    target: { value: 'editor' },
  })
  confirmInvite()
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(postBody(0)).toMatchObject({
    operation: 'invite',
    members: [{ id: 'teammate', role: 'editor' }],
    notify: true,
  })
})

it('applies a role change without a second confirmation', async () => {
  show()
  await openMembers()
  fireEvent.change(screen.getByRole('combobox', { name: 'Teammate' }), {
    target: { value: 'editor' },
  })
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(postBody(0)).toMatchObject({
    operation: 'role',
    members: [{ id: member.id, role: 'editor' }],
  })
  expect(
    screen.queryByText('collaboration.confirm_role')
  ).not.toBeInTheDocument()
})

it('retries an uncertain change with the identical key and body', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') throw new TypeError('network')
    return baseline(url, options)
  })
  show()
  await openMembers()
  fireEvent.change(screen.getByRole('combobox', { name: 'Teammate' }), {
    target: { value: 'editor' },
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'collaboration.retry' })
    ).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.retry' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[1][1]).toEqual(posts()[0][1])
})

it('keeps the opening revision when link access changes', async () => {
  show()
  await openMembers()
  revision = 3
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['material-collaboration'] })
  })
  fireEvent.change(
    screen.getByRole('combobox', { name: /collaboration.link/ }),
    {
      target: { value: 'organization' },
    }
  )
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.confirm' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(postBody(0).expected_revision).toBe(0)
})

it('hides collaborators after permission is revoked', async () => {
  show()
  await openMembers()
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(404, {}))
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['material-collaboration'] })
  })
  await waitFor(() =>
    expect(screen.queryByText('Teammate')).not.toBeInTheDocument()
  )
  expect(posts()).toHaveLength(0)
})

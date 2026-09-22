import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { SummarySharingControl } from './SummarySharingControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
// 选人面板本身有独立单测(通讯录搜索/分页/已选);这里只保留它的「候选来源 +
// 勾选」两个出口,让本文件专注权限流程本身:预览哈希、幂等键、未确认回执、
// 继承权限提示。`load` 是真调用 —— 候选集来自后端,不是通讯录。
vi.mock('@/features/contacts', () => ({
  DirectoryMultiPicker: ({
    onToggle,
    sources,
  }: {
    onToggle: (id: string, label: string) => void
    sources?: {
      value: string
      load?: (params: { query: string; cursor?: string }) => Promise<unknown>
    }[]
  }) => (
    <div>
      {sources?.map((source) => (
        <button
          key={source.value}
          type="button"
          data-testid={`picker-source-${source.value}`}
          onClick={() => void source.load?.({ query: '' })}
        >
          {source.value}
        </button>
      ))}
      <button
        type="button"
        data-testid="picker-toggle"
        onClick={() => onToggle(peer.id, peer.name)}
      >
        {peer.name}
      </button>
    </div>
  ),
}))
const peer = {
  id: 'f9a2cd03-14d0-461a-9311-5aeeac3ce756',
  name: 'Invited colleague',
  read_summary: true,
  read_transcript: false,
  active: true,
}
const preview = {
  title: 'Product meeting',
  preview_hash: 'a'.repeat(64),
  recipients: [
    {
      ...peer,
      after_effective_summary: true,
      inherited_summary: false,
      effective_transcript: false,
    },
  ],
}
const mutations = () =>
  mocks.fetchApi.mock.calls.filter(
    ([url, options]) => options?.method === 'POST' && !url.endsWith('/preview/')
  )
let client: QueryClient
let available: boolean
let manager: boolean
let grants: (typeof peer)[]
let failRead: boolean
function show(viewerId = 'owner') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SummarySharingControl recordId="record" viewerId={viewerId} online />
    </QueryClientProvider>
  )
}
/** 「协作管理」现在是弹窗:先等面板渲染出来,再进去选人。 */
async function openMembers() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'summarySharing.members' })
  )
}
async function inspect() {
  fireEvent.click(screen.getByTestId('picker-toggle'))
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.preview' })
  )
  await screen.findByRole('button', { name: 'summarySharing.confirm' })
}
/**
 * 授权范围下拉是 react-aria 的 Select:它把 [aria-label] 吃掉、只留一个隐藏的
 * 原生 select 承接值/表单语义,所以按无障碍名找不到它 —— 这里就走那个隐藏
 * select,和真实键盘操作落到的也是同一处。
 */
function chooseScope(value: 'summary' | 'transcript') {
  const select = document.querySelector(
    '[data-testid="hidden-select-container"] select'
  )
  if (!select) throw new Error('scope select not rendered')
  fireEvent.change(select, { target: { value } })
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  available = true
  manager = true
  grants = []
  failRead = false
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (failRead) throw new ApiError(403, {})
    if (url.endsWith('/preview/')) return preview
    if (options?.method === 'POST') {
      grants = [peer]
      return { replayed: false, applied_preview: preview }
    }
    if (url.includes('/candidates/'))
      return { results: [peer], next_cursor: null }
    return {
      available,
      can_manage: manager,
      results: grants,
      next_cursor: null,
      supported_scopes: ['summary', 'transcript'],
    }
  })
})
afterEach(() => {
  client.clear()
  sessionStorage.clear()
})

it('splits sharing from collaboration and requires a reviewed scope before any mutation', async () => {
  show()
  // 两个区块同时在面板上:分享转发(聊天/链接)不掺权限,协作管理单独一处。
  expect(await screen.findByText('summarySharing.forward')).toBeInTheDocument()
  expect(screen.getByText('summarySharing.collaboration')).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'summarySharing.chat' })
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'summarySharing.copyLink' })
  ).toBeInTheDocument()
  // 权限写入只发生在协作管理弹窗里,且必须先预览。
  expect(
    screen.queryByRole('button', { name: 'summarySharing.preview' })
  ).toBeNull()
  await openMembers()
  // 候选集来自后端的 summary-sharing 接口(不是通讯录搜索)。
  fireEvent.click(screen.getByTestId('picker-source-participants'))
  await waitFor(() =>
    expect(
      mocks.fetchApi.mock.calls.some(([url]) =>
        url.includes('scope=participants')
      )
    ).toBe(true)
  )
  expect(
    screen.queryByRole('button', { name: 'summarySharing.confirm' })
  ).toBeNull()
  await inspect()
  expect(mutations()).toHaveLength(0)
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(mutations()).toHaveLength(1)
  expect(JSON.parse(mutations()[0][1].body)).toEqual({
    user_ids: [peer.id],
    operation: 'grant',
    expected_hash: preview.preview_hash,
  })
})

it('keeps transcript scope explicit through preview, confirmation and an ambiguous-result retry', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let lost = true
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (url.endsWith('/preview/'))
      return {
        ...preview,
        recipients: [
          {
            ...preview.recipients[0],
            after_effective_transcript: true,
            inherited_transcript: false,
          },
        ],
      }
    if (options?.method === 'POST' && lost) throw new TypeError('lost response')
    const value = await normal(url, options)
    return { ...value, supported_scopes: ['summary', 'transcript'] }
  })
  const first = show()
  await openMembers()
  await screen.findByTestId('picker-toggle')
  chooseScope('transcript')
  await inspect()
  expect(screen.getByText('recordSharing.willRead')).toBeInTheDocument()
  expect(screen.getByText('recordSharing.boundaries')).toBeInTheDocument()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.uncertain')
  const original = mutations()[0][1]
  expect(JSON.parse(original.body).access_scope).toBe('transcript')
  first.unmount()
  client.clear()
  lost = false
  // 关掉弹窗重挂:面板自己要接着显示「上次操作未确认」并能核对同一次操作。
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summarySharing.resubmit' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(mutations()[1][1].body).toEqual(original.body)
  expect(mutations()[1][1].headers).toEqual(original.headers)
})

it('does not offer transcript grants against a server without scoped sharing', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation(async (url, options) => {
    const value = await normal(url, options)
    return { ...value, supported_scopes: ['summary'] }
  })
  show()
  await openMembers()
  expect(
    screen.queryByRole('button', { name: 'recordSharing.scope' })
  ).not.toBeInTheDocument()
})

it('recovers the original permission request after a lost response and remount', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  let fail = true
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (options?.method === 'POST' && !url.endsWith('/preview/')) {
      expect(sessionStorage.getItem(sessionStorage.key(0)!)).toContain(
        options.headers['Idempotency-Key']
      )
      if (fail) throw new TypeError('response lost')
    }
    return normal(url, options)
  })
  const first = show()
  await openMembers()
  await inspect()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.uncertain')
  const original = mutations()[0][1]
  first.unmount()
  client.clear()
  fail = false
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'summarySharing.resubmit' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(mutations()[1][1].headers).toEqual(original.headers)
  expect(mutations()[1][1].body).toEqual(original.body)
})

it('does not allow a changed preview to be confirmed again', async () => {
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    options?.method === 'POST' && !url.endsWith('/preview/')
      ? Promise.reject(new ApiError(409, {}))
      : normal(url, options)
  )
  show()
  await openMembers()
  await inspect()
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.conflict')
  expect(
    screen.queryByRole('button', { name: 'summarySharing.confirm' })
  ).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it('previews inherited access that remains after revoking a direct grant', async () => {
  grants = [peer]
  const normal = mocks.fetchApi.getMockImplementation()!
  mocks.fetchApi.mockImplementation((url, options) =>
    url.endsWith('/preview/')
      ? Promise.resolve({
          ...preview,
          recipients: [
            {
              ...preview.recipients[0],
              inherited_summary: true,
              effective_transcript: true,
            },
          ],
        })
      : normal(url, options)
  )
  show()
  await openMembers()
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Invited colleague · summarySharing.scopeSummary`,
    })
  )
  await screen.findByText('summarySharing.inherited')
  expect(screen.getByText('summarySharing.originalAccess')).toBeInTheDocument()
  expect(mutations()).toHaveLength(0)
  fireEvent.click(
    screen.getByRole('button', { name: 'summarySharing.confirm' })
  )
  await screen.findByText('summarySharing.accepted')
  expect(JSON.parse(mutations()[0][1].body).operation).toBe('revoke')
})

it('removes the private preview and all write controls on permission failure', async () => {
  show()
  await openMembers()
  await inspect()
  failRead = true
  await client.invalidateQueries()
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'summarySharing.confirm' })
    ).toBeNull()
  )
  expect(screen.queryByText(peer.name)).toBeNull()
  expect(mutations()).toHaveLength(0)
})

it('never exposes management to shared readers or reuses a different account marker', async () => {
  sessionStorage.setItem(
    'meeting-summary-sharing:other:record',
    JSON.stringify({
      key: crypto.randomUUID(),
      expected_hash: 'a'.repeat(64),
      user_ids: [peer.id],
      operation: 'grant',
    })
  )
  manager = false
  const first = show('reader')
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
  expect(
    screen.queryByRole('button', { name: 'summarySharing.members' })
  ).toBeNull()
  first.unmount()
  client.clear()
  manager = true
  show()
  await screen.findByRole('button', { name: 'summarySharing.members' })
  expect(
    screen.queryByRole('button', { name: 'summarySharing.resubmit' })
  ).toBeNull()
})

it('turning off sharing retains existing grants without new actions', async () => {
  available = false
  grants = [peer]
  show()
  await screen.findByText('summarySharing.paused')
  expect(
    screen.getByRole('button', { name: 'summarySharing.members' })
  ).toBeDisabled()
  expect(mutations()).toHaveLength(0)
})

it.each(['{', '{}', ''])(
  'blocks a corrupt recovery marker without replacing it: %s',
  async (raw) => {
    const key = `meeting-summary-sharing:owner:record`
    sessionStorage.setItem(key, raw)
    show()
    await screen.findByText('summarySharing.storageUnavailable')
    expect(
      screen.getByRole('button', { name: 'summarySharing.members' })
    ).toBeDisabled()
    expect(mutations()).toHaveLength(0)
    expect(sessionStorage.getItem(key)).toBe(raw)
  }
)

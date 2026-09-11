import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryDepartment, DirectoryMember } from '../api/ApiDirectory'
import { ContactsRoute } from './ContactsRoute'

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
  t: vi.fn(),
  /** 界面语言 —— 拼音索引的开关就看它(i18n.language)。 */
  language: 'zh',
}))

vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ alert: mocks.alert, confirm: mocks.confirm }),
}))
vi.mock('@/components/RequireAuth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 回显 key(带 count 时连数字一起回显)——断言就能同时验到词条与数值;
    // 调用参数另外记在 mocks.t 上,用来验「带参文案拿到了什么参数」。
    t: (key: string, opts?: { count?: number }) => {
      mocks.t(key, opts)
      return opts?.count === undefined ? key : `${key}:${opts.count}`
    },
    i18n: { language: mocks.language },
  }),
}))
// 群/外部联系人这两块的数据源在别处已有测试;这里只关心通讯录自身的状态与版面。
vi.mock('@/features/contacts/hooks/useMyGroups', () => ({
  useMyGroups: () => ({
    groups: [],
    selfUid: 'self',
    isLoading: false,
    memberInfo: {},
    groupAvatars: {},
    unreadTotal: 0,
  }),
}))

const dept = (
  id: string,
  name: string,
  parent: string | null,
  memberCount: number
): DirectoryDepartment => ({
  id,
  name,
  parent,
  path: `/${id}/`,
  depth: parent ? 1 : 0,
  head: null,
  sort_order: 0,
  code: id,
  member_count: memberCount,
})

/** 部门名 → id。成员的 department.id 必须与部门树对得上:列表现在由**服务端**按
 *  department 过滤,id 写错的话「人事部的人」会被算进销售部,而测试还以为在测别的。 */
const DEPT_IDS: Record<string, string> = { 销售部: 'sales', 人事部: 'hr' }

const member = (
  id: string,
  fullName: string,
  title = '',
  deptName = '销售部'
): DirectoryMember => ({
  id,
  membership_id: `m-${id}`,
  sub: null,
  full_name: fullName,
  short_name: null,
  email: `${id}@example.com`,
  avatar_url: '',
  title,
  org_role: 'member',
  department: { id: DEPT_IDS[deptName] ?? 'sales', name: deptName },
  // 服务端按拼音算的首字母(见 core/services/pinyin.py)。测试里就按名字给死值,
  // 免得在断言里复制一遍拼音实现。
  initial: INITIALS[fullName] ?? (fullName[0] ?? '#').toUpperCase(),
  is_self: false,
  is_starred: false,
  special_alert: false,
  left: false,
})

const INITIALS: Record<string, string> = { 张三: 'Z', 李四: 'L', 王五: 'W' }

const departments = [
  dept('sales', '销售部', null, 2),
  dept('hr', '人事部', null, 0),
]
// 按拼音序给:服务端就是这么返回的(L 李四 < Z 张三),测试里不必再排一遍。
const deptMembers = [member('u2', '李四'), member('u1', '张三', '销售总监')]
// 可变:有的用例要看「上千人时的窗口化」,会临时换成一个大名册。
let allMembers = [
  member('u2', '李四'),
  member('u3', '王五', '招聘专员', '人事部'),
  member('u1', '张三', '销售总监'),
]

/** 字母表(每个字母各有多少人)—— 与 allMembers 的 initial 一致。 */
const page = (results: DirectoryMember[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

/** 让某个用例把成员端点打成失败(验列表的失败态与重试)。 */
let membersError: Error | null = null

/** 星标名单(另一个端点,不支持 ?q= —— 它的筛选是客户端做的)。 */
let starredMembers: DirectoryMember[] = []

/**
 * 有的用例要把整册一次给完(验「上千人只渲染一屏」):窗口化算的是**已加载**的
 * 行数,分页一开,一页就只剩 20 行,那个用例的 1000 行前提就不成立了。
 */
let singlePageMembers = false

/** DRF 的 next 是绝对地址;`toApiPath` 认这种带 search 的 URL。 */
const nextPageUrl = (params: URLSearchParams, pageNumber: number) => {
  const next = new URLSearchParams(params)
  next.set('page', String(pageNumber))
  return `http://test.local/api/v1.0/directory/members/?${next.toString()}`
}

/**
 * 假的 /directory/members/ 端点:真的按 department / q 过滤,并且真的分页
 * (count / next / results 是 DRF 的形状)。
 *
 * 过滤必须**在这里**做:筛选与分页都是服务端的事,前端只负责把参数发出去 ——
 * mock 若不分青红皂白回同一份数据,「服务端按全册筛」与「只筛已加载的那一页」两种
 * 实现都能让测试通过,那就等于没测。
 */
const directoryMembersPage = (path: string) => {
  const params = new URL(path, 'http://test.local').searchParams
  const department = params.get('department')
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const pageNumber = Number(params.get('page') ?? 1)
  // 服务端每页上限 100(见 meet/settings.py 的 Pagination);这里照请求值办。
  const pageSize = singlePageMembers
    ? allMembers.length || 1
    : Number(params.get('page_size') ?? 20)

  const list = allMembers.filter((m) => {
    if (department && m.department?.id !== department) return false
    if (!q) return true
    return [
      m.full_name,
      m.short_name,
      m.email,
      m.title,
      m.department?.name,
    ].some((field) => field?.toLowerCase().includes(q))
  })

  const start = (pageNumber - 1) * pageSize
  return {
    count: list.length,
    next:
      start + pageSize < list.length ? nextPageUrl(params, pageNumber + 1) : null,
    previous: null,
    results: list.slice(start, start + pageSize),
  }
}

mocks.fetchApi.mockImplementation((path: string) => {
  // 建群:回一个真的 cid。回 null 会让调用点抛在 result.cid 上,变成一句
  // 「创建群聊失败」—— 那不是这个用例要测的东西,而且会污染后面的 alert 计数。
  if (path === '/im/conversations/group/') {
    return Promise.resolve({
      cid: 'c-new',
      type: 'group',
      owner_uid: 'self',
      members: [],
      self_uid: 'self',
    })
  }
  const deptMembersMatch = /^\/directory\/departments\/([^/]+)\/members\//.exec(
    path
  )
  if (deptMembersMatch) {
    return Promise.resolve(
      page(deptMembersMatch[1] === 'sales' ? deptMembers : [])
    )
  }
  if (path.startsWith('/directory/departments/')) {
    return Promise.resolve(departments)
  }
  if (path.startsWith('/directory/members/')) {
    if (membersError) return Promise.reject(membersError)
    return Promise.resolve(directoryMembersPage(path))
  }
  if (path.startsWith('/directory/starred/'))
    return Promise.resolve(starredMembers)
  if (path.startsWith('/directory/contact-prefs/')) return Promise.resolve([])
  if (path.startsWith('/directory/external-contacts/'))
    return Promise.resolve([])
  return Promise.resolve(null)
})

const renderRoute = (url: string) => {
  window.history.pushState({}, '', url)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ContactsRoute />
    </QueryClientProvider>
  )
}

const currentUrl = () => `${window.location.pathname}${window.location.search}`

/**
 * jsdom 的 matchMedia 永远返回 matches:false(等于宽屏)。要验窄屏那条分支就得
 * 自己换掉它 —— 只对通讯录用的那个查询说「是」。
 */
const setNarrow = (narrow: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  mocks.confirm.mockResolvedValue(true)
  mocks.confirm.mockClear()
  mocks.fetchApi.mockClear()
  mocks.t.mockClear()
  mocks.language = 'zh'
  membersError = null
  singlePageMembers = false
  starredMembers = []
  setNarrow(false)
})

describe('ContactsRoute', () => {
  it('?dept= 落地:标题/人数来自 URL,左栏对应行是选中态', async () => {
    renderRoute('/contacts?dept=sales')

    // 「销售部」在左栏树上也有一个,所以按标题这个 testid 断言,不用文本查询。
    await waitFor(() =>
      expect(screen.getByTestId('contacts-list-title')).toHaveTextContent(
        '销售部'
      )
    )
    // 人数取服务端报的 count,不是「已加载几条」。
    await waitFor(() =>
      expect(screen.getByTestId('contacts-list-subtitle')).toHaveTextContent(
        'page.count:2'
      )
    )
    expect(screen.getByTestId('contacts-dept-sales')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // 部门被选中时「全部成员」不该同时高亮 —— 两处亮着等于没说清在哪。
    expect(screen.getByTestId('contacts-all-entry')).not.toHaveAttribute(
      'aria-current'
    )
    // 部门视图只列这个部门的人。
    expect(screen.getByTestId('contacts-member-u1')).toBeInTheDocument()
    expect(screen.queryByTestId('contacts-member-u3')).toBeNull()
  })

  it('切视图写进 URL,并且不再残留上一个部门', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    await user.click(screen.getByTestId('contacts-groups-entry'))
    await waitFor(() => expect(currentUrl()).toBe('/contacts?view=groups'))

    await user.click(screen.getByTestId('contacts-all-entry'))
    await waitFor(() => expect(currentUrl()).toBe('/contacts'))
    // 回到「全部成员」时列出所有人。
    expect(await screen.findByTestId('contacts-member-u3')).toBeInTheDocument()
  })

  it('点成员行 = 选中并写进 ?member=,关掉卡片后参数消失', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-member-u2')

    await user.click(screen.getByTestId('contacts-member-u2'))
    await waitFor(() => expect(currentUrl()).toBe('/contacts?member=u2'))
    expect(screen.getByTestId('member-detail')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'detail.close' }))
    await waitFor(() => expect(currentUrl()).toBe('/contacts'))
    // 右栏恒定存在:没有选中的人时给空态,而不是整块消失(否则中栏宽度会跳)。
    expect(
      screen.getByTestId('contacts-detail-placeholder')
    ).toBeInTheDocument()
  })

  it('星标名单的筛选仍然管用(那个端点不支持 ?q=,只有它是客户端过滤)', async () => {
    starredMembers = [member('s1', '李四'), member('s2', '张三', '销售总监')]
    const user = userEvent.setup()
    renderRoute('/contacts?view=starred')
    await screen.findByTestId('contacts-member-s1')
    expect(screen.getByTestId('contacts-member-s2')).toBeInTheDocument()

    await user.type(screen.getByTestId('contacts-member-filter'), '销售总监')
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-member-s1')).toBeNull()
    )
    // 职位也要能命中 —— 与目录端点的 q 同一套字段。
    expect(screen.getByTestId('contacts-member-s2')).toBeInTheDocument()
  })

  it('筛选词发给服务端(全册范围),无命中给专门的文案', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-member-u1')

    const filter = screen.getByTestId('contacts-member-filter')
    await user.type(filter, '李')
    // 防抖 250ms 之后词要真的进请求 —— 只在已加载的那 20 条里找,等于「公司里
    // 没这个人」,而那是个假话。
    await waitFor(() =>
      expect(
        mocks.fetchApi.mock.calls.some((call) =>
          String(call[0]).includes('q=%E6%9D%8E')
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-member-u1')).toBeNull()
    )
    expect(screen.getByTestId('contacts-member-u2')).toBeInTheDocument()

    await user.clear(filter)
    await user.type(filter, '查无此人')
    expect(await screen.findByText('page.noMatch')).toBeInTheDocument()
  })

  it('筛选到 0 条:只说「没有匹配的成员」,不挂一个「加载更多」自相矛盾', async () => {
    // 名册本身是分页的(25 人 → 第一页 20 条 + next),所以「加载更多」本来是
    // 在的 —— 空的筛选结果必须把它收掉,否则用户会一直点一个什么也不会发生的
    // 按钮,而那句「没有匹配的成员」看起来就像还没加载完。
    allMembers = Array.from({ length: 25 }, (_, i) =>
      member(`u${i}`, `Member${i}`, '工程师')
    )
    const user = userEvent.setup()
    try {
      renderRoute('/contacts')
      await screen.findByTestId('contacts-member-u0')
      expect(screen.getByTestId('contacts-load-more')).toBeInTheDocument()

      await user.type(screen.getByTestId('contacts-member-filter'), '查无此人')
      expect(await screen.findByText('page.noMatch')).toBeInTheDocument()
      expect(screen.queryByTestId('contacts-load-more')).toBeNull()
    } finally {
      allMembers = [
        member('u2', '李四'),
        member('u3', '王五', '招聘专员', '人事部'),
        member('u1', '张三', '销售总监'),
      ]
    }
  })

  it('列表加载失败:说「加载失败」并给一条重试的路,而不是「暂无成员」', async () => {
    membersError = new Error('boom')
    const user = userEvent.setup()
    renderRoute('/contacts')

    // 「暂无成员」会把一次网络/权限故障说成「公司里没有人」。
    expect(await screen.findByTestId('contacts-retry')).toBeInTheDocument()
    expect(screen.getByText('picker.loadError')).toBeInTheDocument()
    expect(screen.queryByText('page.empty')).toBeNull()

    // 重试要真的再请求一次,而不是把错误藏起来。
    membersError = null
    await user.click(screen.getByTestId('contacts-retry'))
    expect(await screen.findByTestId('contacts-member-u1')).toBeInTheDocument()
  })

  it('筛选让 count 变成「筛出来的人」时,左栏「全部成员」不跟着变小', async () => {
    // 筛选后的 count 是「命中的人数」,当成全组织人数写进左栏就是错的 —— 数字该保留
    // 最后一次「全部成员、无筛选」时的值。
    const user = userEvent.setup()
    renderRoute('/contacts')
    await waitFor(() =>
      expect(screen.getByTestId('contacts-all-entry')).toHaveTextContent(
        'page.allMembers3'
      )
    )
    await user.type(screen.getByTestId('contacts-member-filter'), '李')
    await waitFor(() =>
      expect(screen.getByTestId('contacts-member-u2')).toBeInTheDocument()
    )
    expect(screen.getByTestId('contacts-all-entry')).toHaveTextContent(
      'page.allMembers3'
    )
  })

  it('部门视图里不重复写部门名(整列都是同一个部门)', async () => {
    renderRoute('/contacts?dept=sales')
    const rowButton = await screen.findByTestId('contacts-member-u1')
    // 副标题只有职位,没有「· 销售部」。
    expect(rowButton).toHaveTextContent('销售总监')
    expect(rowButton).not.toHaveTextContent('销售部')
  })

  it('左栏可以整体收起:收起后留窄条,展开按钮就在那儿', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-dept-sales')

    await user.click(screen.getByTestId('contacts-nav-collapse'))
    // 整栏(含部门树)让位给名单。
    expect(screen.queryByTestId('contacts-dept-sales')).toBeNull()
    expect(screen.getByTestId('contacts-nav-expand')).toBeInTheDocument()
    // 收起态也记住:换页/重开还是收起的。
    expect(localStorage.getItem('we-meet:contacts-nav-collapsed')).toBe('1')

    await user.click(screen.getByTestId('contacts-nav-expand'))
    expect(await screen.findByTestId('contacts-dept-sales')).toBeInTheDocument()
  })

  it('看过的部门进「最近访问」', async () => {
    renderRoute('/contacts?dept=sales')
    expect(
      await screen.findByTestId('contacts-recent-sales')
    ).toHaveTextContent('销售部')
    expect(
      JSON.parse(localStorage.getItem('we-meet:contacts-recent-depts') ?? '[]')
    ).toEqual(['sales'])
  })

  it('窄屏:右栏改成浮层,返回后浮层关掉但选择不变', async () => {
    const user = userEvent.setup()
    setNarrow(true)
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    // 窄屏下部门卡不再占一栏:它盖在名单上(浮层),名单本身还在后面。
    expect(screen.getByTestId('contacts-detail-overlay')).toContainElement(
      screen.getByTestId('contacts-department-detail')
    )
    // 常驻第三栏(空态占位那一块)不在 DOM 里 —— 它会把名单挤没。
    expect(screen.queryByTestId('contacts-detail-placeholder')).toBeNull()

    // 点成员 → 浮层换成成员卡(走 portal,挂在 body 上),名单还在后面。
    await user.click(screen.getByTestId('contacts-member-u2'))
    expect(await screen.findByTestId('member-detail')).toBeInTheDocument()
    const back = screen.getByTestId('contacts-detail-back')

    await user.click(back)
    // 浮层收掉,但 ?member= 还在 —— 选择表达的是「在看谁」,不随浮层开关改变。
    await waitFor(() =>
      expect(screen.queryByTestId('member-detail')).toBeNull()
    )
    expect(currentUrl()).toBe('/contacts?dept=sales&member=u2')
    expect(screen.getByTestId('contacts-member-u1')).toBeInTheDocument()

    // 再点一次同一个人要能重新打开(不是「关过就再也不出现」)。
    await user.click(screen.getByTestId('contacts-member-u2'))
    expect(await screen.findByTestId('member-detail')).toBeInTheDocument()
  })

  it('宽屏:右栏是常驻第三栏(不是浮层)', async () => {
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    expect(screen.getByTestId('contacts-department-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('contacts-detail-overlay')).toBeNull()
  })

  it('部门级「发起群聊」:先确认,再按部门成员建群', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts?dept=sales')
    const action = await screen.findByTestId('contacts-dept-group-chat')

    await user.click(action)
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    // 确认文案要带上部门名与真实人数(不含自己),别让用户对着「确定吗」猜。
    expect(mocks.t).toHaveBeenCalledWith('department.startGroupChatConfirm', {
      name: '销售部',
      members: 2,
    })

    await waitFor(() =>
      expect(mocks.fetchApi).toHaveBeenCalledWith(
        '/im/conversations/group/',
        expect.objectContaining({ method: 'POST' })
      )
    )
    const body = JSON.parse(
      mocks.fetchApi.mock.calls.find(
        (call) => call[0] === '/im/conversations/group/'
      )?.[1].body ?? '{}'
    )
    expect(body.name).toBe('销售部')
    // 顺序无所谓,「把这两个人拉进来」才是断言的意思。
    expect([...body.member_user_ids].sort()).toEqual(['u1', 'u2'])
  })

  it('部门级「发起群聊」要翻完整个部门,不能只拉第一页', async () => {
    // 150 人的部门:以前只取第一页(全局每页 20 条),群里只有 20 个人,而确认框
    // 上写的也是 20 —— 少掉的人没有任何提示。
    allMembers = Array.from({ length: 150 }, (_, i) =>
      member(`u${i}`, `Member${i}`, '工程师')
    )
    const user = userEvent.setup()
    try {
      renderRoute('/contacts?dept=sales')
      await user.click(await screen.findByTestId('contacts-dept-group-chat'))

      await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
      expect(mocks.t).toHaveBeenCalledWith('department.startGroupChatConfirm', {
        name: '销售部',
        members: 150,
      })
      // 每页要满(服务端上限 100),并且真的翻了第二页。
      expect(
        mocks.fetchApi.mock.calls.some((call) =>
          String(call[0]).includes('page_size=100')
        )
      ).toBe(true)
      expect(
        mocks.fetchApi.mock.calls.some((call) =>
          String(call[0]).includes('page=2')
        )
      ).toBe(true)

      await waitFor(() =>
        expect(mocks.fetchApi).toHaveBeenCalledWith(
          '/im/conversations/group/',
          expect.objectContaining({ method: 'POST' })
        )
      )
      const body = JSON.parse(
        mocks.fetchApi.mock.calls.find(
          (call) => call[0] === '/im/conversations/group/'
        )?.[1].body ?? '{}'
      )
      expect(body.member_user_ids).toHaveLength(150)
    } finally {
      allMembers = [
        member('u2', '李四'),
        member('u3', '王五', '招聘专员', '人事部'),
        member('u1', '张三', '销售总监'),
      ]
    }
  })

  it('部门超过上限:明说拉不了,不建一个半拉的群', async () => {
    allMembers = Array.from(
      { length: 301 },
      (_, i) => member(`u${i}`, `Member${i}`, '工程师')
    )
    const user = userEvent.setup()
    try {
      renderRoute('/contacts?dept=sales')
      await user.click(await screen.findByTestId('contacts-dept-group-chat'))

      await waitFor(() => expect(mocks.alert).toHaveBeenCalledTimes(1))
      expect(mocks.t).toHaveBeenCalledWith('department.startGroupChatTooMany', {
        count: 301,
        limit: 300,
      })
      // 一个都不该建:部分拉人比拒绝更糟(用户以为全都在群里)。
      expect(
        mocks.fetchApi.mock.calls.some(
          (call) => call[0] === '/im/conversations/group/'
        )
      ).toBe(false)
    } finally {
      allMembers = [
        member('u2', '李四'),
        member('u3', '王五', '招聘专员', '人事部'),
        member('u1', '张三', '销售总监'),
      ]
    }
  })

  it('空部门不给「发起群聊」按钮(点了必然是一句没有成员)', async () => {
    renderRoute('/contacts?dept=hr')
    // 人事部 member_count = 0:右栏照常显示,但没有那个按钮。
    await waitFor(() =>
      expect(screen.getByTestId('contacts-list-title')).toHaveTextContent(
        '人事部'
      )
    )
    expect(screen.queryByTestId('contacts-dept-group-chat')).toBeNull()
  })

  it('列表按拼音排:请求带上 ordering=pinyin(部门也走目录端点)', async () => {
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    const listCall = mocks.fetchApi.mock.calls.find((call) =>
      String(call[0]).startsWith('/directory/members/')
    )
    expect(String(listCall?.[0])).toContain('ordering=pinyin')
    // 部门视图与「全部成员」同一个端点:它同时支持 q 与拼音序,而
    // departments/{id}/members/ 不接受搜索词。
    expect(String(listCall?.[0])).toContain('department=sales')
  })

  it('不再有右侧 A–Z 索引条(它已被去掉,不留半截)', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-member-u1')

    // 索引条连同它的入口一起删了:点字母跳转这条路没有了。留着断言是为了防止
    // 「以为删干净了其实还挂着一个空壳」——一个不响应用户的竖条比没有更糟。
    expect(screen.queryByTestId('contacts-alphabet-L')).toBeNull()
    expect(screen.queryByTestId('contacts-alphabet-A')).toBeNull()

    // 也不该再有字母表请求(那一趟往返只为索引条而发)。
    expect(
      mocks.fetchApi.mock.calls.some((call) =>
        String(call[0]).includes('/alphabet/')
      )
    ).toBe(false)

    // 列表本身照旧:拼音序 + 就地筛选都还在。
    await user.type(screen.getByTestId('contacts-member-filter'), '李')
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-member-u1')).toBeNull()
    )
    expect(screen.getByTestId('contacts-member-u2')).toBeInTheDocument()
  })

  it('界面语言不是简体中文:不画字母头,但排序照样按拼音发', async () => {
    mocks.language = 'en'
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    expect(screen.queryByTestId('contacts-letter-chip')).toBeNull()
    // **排序**与语言无关:汉字没有可用的编码序,中文名册对英文界面用户也一样。
    // (字母头是「怎么读这份名册」,排序是「名册本身长什么样」—— 两件事。)
    expect(
      String(
        mocks.fetchApi.mock.calls.find((call) =>
          String(call[0]).startsWith('/directory/members/')
        )?.[0]
      )
    ).toContain('ordering=pinyin')
  })

  it('简体中文的变体(zh-CN)也认:浏览器给的带地区后缀的语言照样画字母头', async () => {
    mocks.language = 'zh-CN'
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    expect(screen.getByTestId('contacts-letter-chip')).toBeInTheDocument()
  })

  it('悬浮字母头跟着视口顶部那一行走', async () => {
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    // 部门视图按拼音序:L(李四) 应排在 Z(张三) 前面,头一个字母是 L。
    const chip = await screen.findByTestId('contacts-letter-chip')
    expect(chip).toHaveTextContent('L')
    const rows = screen.getAllByTestId(/^contacts-member-u/)
    expect(rows[0]).toHaveAttribute('data-testid', 'contacts-member-u2')
  })

  it('星标 / 群组视图没有字母头(那里不按拼音排)', async () => {
    const { unmount } = renderRoute('/contacts?view=starred')
    await waitFor(() =>
      expect(screen.getByTestId('contacts-list-title')).toHaveTextContent(
        'starred.title'
      )
    )
    expect(screen.queryByTestId('contacts-letter-chip')).toBeNull()
    unmount()

    renderRoute('/contacts?view=groups')
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-letter-chip')).toBeNull()
    )
  })

  it('上千人只渲染一屏:整表高度撑开,但 DOM 里没有上千行', async () => {
    // 1000 人的名册一次给完(单页 mock):窗口化算的是已加载的行数。
    allMembers = Array.from({ length: 1000 }, (_, i) =>
      member(`u${i}`, `Member${i}`, '工程师', '销售部')
    )
    singlePageMembers = true
    try {
      renderRoute('/contacts')
      await screen.findByTestId('contacts-member-u0')

      const rows = screen.getAllByTestId(/^contacts-member-u/)
      // 一屏 11 行 + 上下各 6 行 overscan ≈ 23 行;上千行必须没进 DOM。
      expect(rows.length).toBeLessThan(60)
      const list = screen.getByTestId('contacts-member-list')
      const spacer = list.parentElement as HTMLElement
      // 滚动条高度仍按 1000 行算,滚动比例才对得上。
      expect(spacer.style.height).toBe(`${1000 * 57}px`)
    } finally {
      allMembers = [
        member('u2', '李四'),
        member('u3', '王五', '招聘专员', '人事部'),
        member('u1', '张三', '销售总监'),
      ]
    }
  })
})

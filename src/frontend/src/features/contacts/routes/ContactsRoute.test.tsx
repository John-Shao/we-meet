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
  department: { id: 'sales', name: deptName },
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
let alphabet = [
  { letter: 'L', count: 1 },
  { letter: 'W', count: 1 },
  { letter: 'Z', count: 1 },
]

const page = (results: DirectoryMember[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

mocks.fetchApi.mockImplementation((path: string) => {
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
  // 字母表要在列表之前判:两者都以 /directory/members/ 开头。
  if (path.startsWith('/directory/members/alphabet/')) {
    return Promise.resolve({ letters: alphabet })
  }
  if (path.startsWith('/directory/members/'))
    return Promise.resolve(page(allMembers))
  if (path.startsWith('/directory/starred/')) return Promise.resolve([])
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

  it('就地筛选只过滤已加载的成员,无命中给专门的文案', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-member-u1')

    const filter = screen.getByTestId('contacts-member-filter')
    await user.type(filter, '李')
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-member-u1')).toBeNull()
    )
    expect(screen.getByTestId('contacts-member-u2')).toBeInTheDocument()

    await user.clear(filter)
    await user.type(filter, '查无此人')
    expect(await screen.findByText('page.noMatch')).toBeInTheDocument()
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

    // 窄屏下不再有 300px 的常驻第三栏(它会把名单挤没)。
    expect(screen.queryByTestId('contacts-dept-detail')).toBeNull()

    // 点成员 → 浮层盖上来(走 portal,挂在 body 上),名单还在后面。
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

  it('列表按拼音排:请求带上 ordering=pinyin', async () => {
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    const listCall = mocks.fetchApi.mock.calls.find((call) =>
      String(call[0]).startsWith('/directory/departments/sales/members/')
    )
    expect(String(listCall?.[0])).toContain('ordering=pinyin')
  })

  it('A–Z 索引条:字母来自服务端,点一个字母把起点写进 URL,再点一次取消', async () => {
    const user = userEvent.setup()
    renderRoute('/contacts')
    await screen.findByTestId('contacts-member-u1')

    // 有人的字母可点,没人的字母禁用(而不是点了以后看到一片空白)。
    expect(screen.getByTestId('contacts-alphabet-L')).toBeEnabled()
    expect(screen.getByTestId('contacts-alphabet-A')).toBeDisabled()

    await user.click(screen.getByTestId('contacts-alphabet-L'))
    await waitFor(() => expect(currentUrl()).toBe('/contacts?from_initial=L'))
    // 起点要真的发给服务端(前端不做拼音,筛不了)。
    await waitFor(() =>
      expect(
        mocks.fetchApi.mock.calls.some(
          (call) =>
            String(call[0]).startsWith('/directory/members/') &&
            String(call[0]).includes('from_initial=L')
        )
      ).toBe(true)
    )

    // 再点同一个字母 = 取消起点,回到整册。
    await user.click(screen.getByTestId('contacts-alphabet-L'))
    await waitFor(() => expect(currentUrl()).toBe('/contacts'))
  })

  it('索引条只在按拼音排的视图出现(星标 / 群组没有)', async () => {
    const { unmount } = renderRoute('/contacts?view=starred')
    await waitFor(() =>
      expect(screen.getByTestId('contacts-list-title')).toHaveTextContent(
        'starred.title'
      )
    )
    expect(screen.queryByTestId('contacts-alphabet-L')).toBeNull()
    unmount()

    renderRoute('/contacts?view=groups')
    await waitFor(() =>
      expect(screen.queryByTestId('contacts-alphabet-L')).toBeNull()
    )
  })

  it('界面语言不是简体中文:不画索引条与字母头,也不请求字母表', async () => {
    mocks.language = 'en'
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    expect(screen.queryByTestId('contacts-alphabet-L')).toBeNull()
    expect(screen.queryByTestId('contacts-letter-chip')).toBeNull()
    expect(
      mocks.fetchApi.mock.calls.some((call) =>
        String(call[0]).includes('/alphabet/')
      )
    ).toBe(false)
    // 但**排序**照样按拼音发:汉字没有可用的编码序,中文名册对英文界面用户也一样。
    // (索引条是「怎么读这份名册」,排序是「名册本身长什么样」—— 两件事。)
    expect(
      String(
        mocks.fetchApi.mock.calls.find((call) =>
          String(call[0]).startsWith('/directory/departments/sales/members/')
        )?.[0]
      )
    ).toContain('ordering=pinyin')
  })

  it('简体中文的变体(zh-CN)也认:浏览器给的带地区后缀的语言照样开索引', async () => {
    mocks.language = 'zh-CN'
    renderRoute('/contacts?dept=sales')
    await screen.findByTestId('contacts-member-u1')

    expect(screen.getByTestId('contacts-alphabet-L')).toBeEnabled()
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

  it('上千人只渲染一屏:整表高度撑开,但 DOM 里没有上千行', async () => {
    // 1000 人的名册(每页 100,这里直接给一页就能验窗口化)。
    allMembers = Array.from({ length: 1000 }, (_, i) =>
      member(`u${i}`, `Member${i}`, '工程师', '销售部')
    )
    alphabet = [{ letter: 'M', count: 1000 }]
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
      alphabet = [
        { letter: 'L', count: 1 },
        { letter: 'W', count: 1 },
        { letter: 'Z', count: 1 },
      ]
    }
  })
})

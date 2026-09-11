import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useLocation, useSearchParams } from 'wouter'
import { RiArrowLeftLine, RiLayoutLeftLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { Button, SearchBox } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import { createGroupConversation } from '@/features/im/api/createGroupConversation'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import { useMediaQuery } from '@/features/rooms/livekit/hooks/useMediaQuery'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useVirtualRows } from '@/hooks/useVirtualRows'

import {
  ContactsSidebar,
  type ContactsView,
  type ContactsSidebarCounts,
} from '../components/ContactsSidebar'
import { ContactsDetailPlaceholder } from '../components/ContactsDetailPlaceholder'
import { DepartmentDetailPanel } from '../components/DepartmentDetailPanel'
import { GroupDetailPanel } from '../components/GroupDetailPanel'
import { MemberDetailPanel } from '../components/MemberDetailPanel'
import { MyGroupsPanel } from '../components/MyGroupsPanel'
import { StarredAddDialog } from '../components/StarredAddDialog'
import { ExternalContactsPanel } from '../components/ExternalContactsPanel'
import { resolveGroupName } from '../groups'
import {
  readRecentDepartments,
  rememberDepartment,
  writeRecentDepartments,
} from '../recentDepartments'
import { useMyGroups } from '../hooks/useMyGroups'
import { fetchDepartments } from '../api/fetchDepartments'
import { fetchDirectoryMembersPage } from '../api/fetchDirectoryMembers'
import { fetchDirectoryMember } from '../api/fetchDirectoryMember'
import { fetchStarredContacts } from '../api/fetchStarredContacts'
import { fetchContactPrefs, setContactPref } from '../api/setContactPref'
import {
  fetchExternalContactRequests,
  fetchExternalContacts,
} from '../api/externalContacts'
import type { DirectoryMember, ExternalContact } from '../api/ApiDirectory'

/**
 * `/contacts` — org directory: browse the department tree (left) and the members
 * of the selected department or a name/email search (right). "Message" starts a
 * direct IM conversation. Organization administration (creating / deleting
 * departments, moving members) lives in the management console, not here.
 *
 * 选择状态(view / dept / member / group)全部由 URL 承载:`/contacts?view=groups`、
 * `/contacts?dept=<id>`、`/contacts?member=<id>`、`/contacts?group=<cid>`。这样刷新、
 * 浏览器后退、分享链接、从消息页点「通讯录」回来都落在同一个位置 —— 之前这些
 * 状态只在 useState 里,刷新一次就回到「全部成员」。
 */
export const ContactsRoute = () => (
  <RequireAuth>
    <Screen>
      <ContactsAuthenticated />
    </Screen>
  </RequireAuth>
)

const VIEW_PARAMS = ['starred', 'groups', 'external'] as const
const isViewParam = (v: string | null): v is (typeof VIEW_PARAMS)[number] =>
  !!v && (VIEW_PARAMS as readonly string[]).includes(v)

/** 窄屏阈值:三栏加起来(导航 245 + 部门 260 + 名单 ≥420 + 详情 300)放不下时
 * 右栏改浮层。与任务的「接管式详情」同一手法(那边是 1439px,这里三栏更宽,
 * 取 xl 断点 1280px)。 */
const NARROW_DETAIL_QUERY = '(max-width: 1280px)'

const NAV_COLLAPSED_KEY = 'we-meet:contacts-nav-collapsed'

/** 成员行高(px):36px 头像 + 上下各 0.625rem 内边距 + 1px 分隔线。
 *  窗口化靠这个数算位置,量出来的和实际不符滚动就会漂 —— 行样式改了要一起改。 */
const MEMBER_ROW_HEIGHT = 57

/**
 * 部门级「发起群聊」的规模上限。建群会把所有人拉进一个会话,几百人的群不是
 * 「顺手点一下」该产生的东西 —— 超过就明确告诉用户拉不了,而不是悄悄拉一半。
 */
const GROUP_CHAT_MEMBER_CAP = 300
/** 拉部门成员时的每页条数 —— 服务端上限 100(见 meet/settings.py 的 Pagination)。 */
const GROUP_CHAT_PAGE_SIZE = 100

/**
 * 客户端筛选(只给星标名单用,见中栏那段注释):与目录端点的 `?q=` **同一套字段**
 * —— 姓名 / 简称 / 邮箱 / 职位 / 部门名。两边字段不一致的话,同一个词在「全部成员」
 * 里查得到、在「星标」里查不到,而这种差异用户只会读成「搜索坏了」。
 */
const matchesQuery = (member: DirectoryMember, query: string): boolean => {
  const needle = query.toLowerCase()
  return [
    member.full_name,
    member.short_name,
    member.email,
    member.title,
    member.department?.name,
  ].some((field) => field?.toLowerCase().includes(needle))
}

const ContactsAuthenticated = () => {
  const { t, i18n } = useTranslation('contacts')
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const [addingStarred, setAddingStarred] = useState(false)
  const [memberFilter, setMemberFilter] = useState('')
  // 窄屏下右栏是浮层;用户按「返回」把它关掉后,列表要能露出来(而 URL 里的
  // dept/member 选择不变 —— 它表达的是「在看哪儿」,不是「浮层开着」)。
  const [detailDismissed, setDetailDismissed] = useState(false)
  const [startingGroupChat, setStartingGroupChat] = useState(false)
  const [recentIds, setRecentIds] = useState<string[]>(() =>
    readRecentDepartments()
  )
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const narrowDetail = useMediaQuery(NARROW_DETAIL_QUERY)

  const toggleNav = () => {
    setNavCollapsed((prev) => {
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, prev ? '0' : '1')
      } catch {
        // 隐私模式:这次会话里仍然能收起/展开,只是不记住。
      }
      return !prev
    })
  }

  // ── URL 即状态 ──────────────────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams()
  const rawView = searchParams.get('view')
  const view: ContactsView = isViewParam(rawView) ? rawView : null
  // 视图入口与部门是互斥的:选了「我的群组」就不再有「当前部门」。
  const selectedDeptId = view === null ? searchParams.get('dept') : null
  const memberParam = searchParams.get('member')
  const groupParam = searchParams.get('group')

  /**
   * 改 URL 查询串。`replace` 决定要不要留一条历史:
   *   - 换视图 / 换部门 = 一次真实的「跳转」,留历史 → 后退能回到上一个部门(像
   *     翻文件夹一样);
   *   - 选中/取消一个人或一个群 = 页内状态,用 replace 顶掉当前条目 → 否则点十个
   *     人就在历史里堆十条,后退键要按十次才出得去。
   */
  const patchParams = (
    patch: Record<string, string | null>,
    { replace = false }: { replace?: boolean } = {}
  ) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace }
    )

  const selectView = (next: Exclude<ContactsView, null>) =>
    patchParams({ view: next, dept: null, member: null })
  const selectAll = () => patchParams({ view: null, dept: null, member: null })
  // 每个选择动作都顺手把浮层详情「重新打开」:窄屏下用户可能刚把它关掉,再点
  // 一次同一个部门也该再看到那张卡。
  const selectDept = (id: string) => {
    setDetailDismissed(false)
    patchParams({ view: null, dept: id, member: null })
  }
  const selectMember = (id: string | null) => {
    setDetailDismissed(false)
    patchParams({ member: id }, { replace: true })
  }
  const selectGroup = (cid: string) => {
    setDetailDismissed(false)
    patchParams({ group: cid }, { replace: true })
  }

  // 换视图/换部门时清掉列表筛选:上一处筛的「张」带到新列表里只会显示「无匹配」。
  useEffect(() => {
    setMemberFilter('')
  }, [view, selectedDeptId])

  const { data: departments = [] } = useQuery({
    queryKey: ['directory', 'departments'],
    queryFn: () => fetchDepartments(),
    staleTime: 60_000,
  })

  // 通讯录只负责「浏览」组织:选部门列其直属成员,全部成员列整册。
  // 按姓名找人统一走顶栏全局搜索(飞书式单一搜索入口),列表头另给一个**就地**筛选:
  // 只过滤已加载的这几页,不发请求,用于「这一屏里找那个人」。
  //
  // 分页而不是只取第一页:一个上百人的部门原来会在第 100 人处静默截断,页面上
  // 没有任何迹象表明列表还没完。星标名单不分页(它本来就短)。
  //
  // 部门/全部成员按**拼音**排(?ordering=pinyin):汉字没有可用的编码序,上千人的
  // 名册按编码排等于乱序。星标名单是服务端另一个端点(不支持拼音序),保持原样。
  //
  // 注意排序与字母头是两个决定:排序对所有界面语言都发,字母头只在简体中文下画 ——
  // 详见 letterHeadersEnabled。
  const pinyinOrder = view === null
  /**
   * 悬浮字母头只在界面语言是简体中文时才出现。
   *
   * 理由:按拼音分桶是给中文名册用的读法。界面是英文/法文/荷兰文的组织里,一串
   * A–Z 小节加一个「其他(数字或符号)」桶既不解释得了名册,又占着视线。这一类用户
   * 本来也不按拼音找中文名 —— 他们有筛选和 Ctrl+K 全局搜索。
   *
   * (曾经的右侧 A–Z 索引条已经去掉:一个 27 行的小竖条在手机和窄窗口里都显得突兀,
   * 而它换来的是「跳到一个字母」这一步 —— 名册本来就有服务端筛选可用了。)
   *
   * 用 startsWith 而不是等值比较:i18next 的 supportedLngs 只有 'zh',浏览器给的
   * 'zh-CN'/'zh-TW' 都会落到这份简体资源上,但语言代码可能仍带地区后缀
   * (全站既有的中文判断也都是这么写的,见 CalendarGrid / AgendaListView)。
   *
   * 取 resolvedLanguage(实际渲染用的那份资源)优先,而不是检测到的原始代码:
   * 初始化是异步的,首帧 language 可能还是空的 —— 那时不该先画一个字母头再抽掉;
   * 而回落成中文界面的情况(不支持的语言)看到的本来就是中文,字母头与界面一致。
   */
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language
  const letterHeadersEnabled = activeLanguage?.startsWith('zh') ?? false

  /**
   * 筛选词交给**服务端**(防抖 250ms,和选人器同一档)。
   *
   * 之前是客户端过滤「已加载的这几页」:第一页只有 20 条,于是「在 800 人的名册里
   * 找同事」实际只搜了 20 个人 —— 找不到是必然的,而用户会以为公司里没这个人。
   * 走服务端之后筛选覆盖全册,分页/计数/字母表也都在同一个集合上说话。
   */
  const debouncedFilter = useDebouncedValue(
    memberFilter.trim(),
    250,
    `${view}|${selectedDeptId}`
  )

  /**
   * 链接里的部门可能是**已经删掉的**:`?dept=<旧 id>` 的旧书签/转发链接会让列表
   * 查一个不存在的部门(404 → 空列表),而标题又回落到「全部成员」,看起来就像
   * 「这个部门没人了」。部门表加载完之后,认不出的 id 一律当没选部门 —— 标题、
   * 列表、左栏高亮于是都指向同一个事实。
   */
  const deptIsKnown =
    !selectedDeptId ||
    departments.length === 0 ||
    departments.some((dept) => dept.id === selectedDeptId)
  const effectiveDeptId = deptIsKnown ? selectedDeptId : null

  const {
    data: memberPages,
    isFetching,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [
      'directory',
      'members',
      'page',
      { dept: effectiveDeptId, view, q: debouncedFilter },
    ],
    queryFn: ({ pageParam }) =>
      view === 'starred'
        ? fetchStarredContacts().then((results) => ({
            count: results.length,
            next: null,
            previous: null,
            results,
          }))
        : fetchDirectoryMembersPage(debouncedFilter, pageParam, {
            pinyin: true,
            // 部门视图也走目录端点:它同时支持 ?department= 与 ?q=,
            // 而 departments/{id}/members/ 不接受搜索词。顺带让两个视图用**同一套**
            // 成员规则(目录端点是「每人一张卡,按主部门」)—— 否则部门视图会出现
            // 「卡片上写的部门不是这个部门」的人。
            department: effectiveDeptId,
          }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    staleTime: 30_000,
    // 换筛选词 / 换部门时不把上一份结果丢掉:新的一页没到之前先留着旧列表,
    // 否则每敲一个字名单都会闪成一句「正在加载」。
    placeholderData: keepPreviousData,
    // 「我的群组」/「外部联系人」视图里根本不渲染成员名单,别白拉一整册人。
    enabled: view !== 'groups' && view !== 'external',
  })
  const members = useMemo(
    () => (memberPages?.pages ?? []).flatMap((page) => page.results),
    [memberPages]
  )
  /** 服务端报的总数(不是已加载条数)—— 标题上写「共 N 人」得是这个。 */
  const totalMembers = memberPages?.pages[0]?.count ?? null

  /**
   * 「全部成员」这一行的人数。只有在**当前查询正好是「全部成员、无筛选」**时才知道
   * 确切值,其余情况沿用最后一次已知的数字 —— 每次点部门都让这行数字消失,比留一个
   * 略旧的数字更晃眼。
   *
   * 条件必须把 `q` 也算进去:它会让 `count` 变成「筛出来的人」,当成全组织人数写进
   * 左栏就是错的。用 state 而不是 ref:ref 要等下一次渲染才可见,冷启动时那一格会
   * 先空一拍。
   */
  const [knownAllMembers, setKnownAllMembers] = useState<number | null>(null)
  useEffect(() => {
    if (
      view === null &&
      !effectiveDeptId &&
      !debouncedFilter &&
      typeof totalMembers === 'number'
    ) {
      setKnownAllMembers(totalMembers)
    }
  }, [view, effectiveDeptId, debouncedFilter, totalMembers])

  const selectedDept = useMemo(
    () => departments.find((d) => d.id === effectiveDeptId) ?? null,
    [departments, effectiveDeptId]
  )
  // 祖先链从扁平列表里按 parent 上溯 —— 部门树本来就整棵返回,不必再请求一次。
  const deptAncestors = useMemo(() => {
    if (!selectedDept) return []
    const byId = new Map(departments.map((d) => [d.id, d]))
    const chain = []
    let cursor = selectedDept.parent ? byId.get(selectedDept.parent) : undefined
    // 上限防脏数据成环。
    while (cursor && chain.length < 16) {
      chain.unshift(cursor)
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined
    }
    return chain
  }, [departments, selectedDept])

  // 记住看过的部门(左栏「最近访问」)。id 落 localStorage,名字/人数仍从部门树
  // 那份数据里取 —— 部门被删掉后会自动消失,不需要清理逻辑。
  useEffect(() => {
    if (!selectedDeptId) return
    setRecentIds((prev) => {
      const next = rememberDepartment(selectedDeptId, prev)
      // 没变化就返回原引用,免得白白触发一次重渲染。
      if (next.length === prev.length && next[0] === prev[0]) return prev
      writeRecentDepartments(next)
      return next
    })
  }, [selectedDeptId])

  const recentDepts = useMemo(() => {
    if (recentIds.length === 0) return []
    const byId = new Map(departments.map((d) => [d.id, d]))
    return recentIds
      .map((id) => byId.get(id))
      .filter((dept): dept is (typeof departments)[number] => !!dept)
  }, [recentIds, departments])

  // 成员选择同样由 URL 承载(?member=<id>,如从 IM 消息头像点击跳转)。列表里
  // 有这个人就用列表对象(带部门/职位),没有(比如部门负责人)就单拉一份。
  const { data: linkedMember } = useQuery({
    queryKey: ['directory', 'member', memberParam],
    queryFn: () => fetchDirectoryMember(memberParam!),
    enabled: !!memberParam,
    staleTime: 30_000,
  })
  const selectedMember = useMemo(() => {
    if (!memberParam) return null
    return members.find((m) => m.id === memberParam) ?? linkedMember ?? null
  }, [memberParam, members, linkedMember])

  // 星标名单单独拉一份:一是「添加」对话框要排掉已星标的人,二是任何列表/详情
  // 里的星标状态都从这一份派生,切换视图不会看到两种说法。
  const { data: starred = [] } = useQuery({
    queryKey: ['directory', 'starred'],
    queryFn: () => fetchStarredContacts(),
    staleTime: 30_000,
  })
  const starredIds = new Set(starred.map((m) => m.id))

  // 两个 flag 的紧凑清单:开关状态一律从这一份派生,不读卡片上的快照,免得同一
  // 件事有两个说法。星标名单(上面那份)另外拉,因为它要的是可渲染的卡片。
  const { data: prefs = [] } = useQuery({
    queryKey: ['directory', 'contact-prefs'],
    queryFn: () => fetchContactPrefs(),
    staleTime: 30_000,
  })
  const alertIds = new Set(
    prefs.filter((p) => p.special_alert).map((p) => p.user_id)
  )

  // 左栏的群组与外部联系人计数:与各自的视图面板共用 queryKey,所以只是读缓存。
  const myGroups = useMyGroups()
  const { data: externalContacts = [] } = useQuery({
    queryKey: ['directory', 'external-contacts'],
    queryFn: fetchExternalContacts,
    staleTime: 30_000,
  })
  const { data: externalRequests = [] } = useQuery({
    queryKey: ['directory', 'external-contact-requests'],
    queryFn: fetchExternalContactRequests,
    staleTime: 10_000,
  })
  /** 只有「别人发给我、等我处理」的申请才配红标;我发出去等对方接受的不算。 */
  const externalPending = externalRequests.filter(
    (c) => c.direction === 'incoming'
  ).length

  const counts: ContactsSidebarCounts = {
    starred: starred.length,
    groups: myGroups.groups.length,
    groupUnread: myGroups.unreadTotal,
    external: externalContacts.length,
    externalPending,
    members: knownAllMembers,
  }

  const selectedGroup = useMemo(
    () =>
      view === 'groups' && groupParam
        ? (myGroups.groups.find((c) => c.cid === groupParam) ?? null)
        : null,
    [view, groupParam, myGroups.groups]
  )
  const selectedGroupLabel = useMemo(() => {
    if (!selectedGroup) return ''
    const resolved = resolveGroupName(selectedGroup, myGroups.memberInfo, {
      selfUid: myGroups.selfUid,
      separator: t('groups.nameSeparator'),
    })
    return resolved.kind === 'named'
      ? resolved.name
      : resolved.kind === 'derived'
        ? t('groups.unnamedFromMembers', {
            names: resolved.names,
            count: resolved.count,
          })
        : t('groups.unnamed')
    // t() 随语言变化,但语言切换会整棵重渲染 —— 不必进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup, myGroups.memberInfo, myGroups.selfUid])

  /**
   * 拨一个 flag。只传自己在改的那个键 —— 服务端不动没传的键,所以打星标绝不会
   * 顺手改掉「特别提醒」(两者独立,见 ContactPreference)。
   */
  const toggleContactPref = async (
    member: DirectoryMember,
    patch: { is_starred?: boolean; special_alert?: boolean }
  ) => {
    try {
      await setContactPref(member.id, patch)
      await qc.invalidateQueries({ queryKey: ['directory', 'starred'] })
      await qc.invalidateQueries({ queryKey: ['directory', 'contact-prefs'] })
      await qc.invalidateQueries({ queryKey: ['directory', 'members'] })
    } catch (e) {
      void showAlert({
        message: t('starred.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  const handleMessage = async (member: DirectoryMember) => {
    try {
      const result = await createDirectConversationByUserId(member.id)
      // 带上 cid,ImRoute 据此直接打开与该联系人的会话(否则落到 /im 还要再选一次)
      navigate(`/im?cid=${encodeURIComponent(result.cid)}`)
    } catch (e) {
      void showAlert({
        message: t('page.messageError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  const handleExternalMessage = async (contact: ExternalContact) => {
    try {
      const result = await createDirectConversationByUserId(contact.id)
      navigate(`/im?cid=${encodeURIComponent(result.cid)}`)
    } catch (e) {
      void showAlert({
        message: t('page.messageError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  /**
   * 部门级「发起群聊」:把该部门的直属成员拉进一个新群。
   *
   * 三点克制:①建群会通知到每个人,所以先弹确认框,把「拉几个人进哪个群」说清楚;
   * ②只取直属成员(不含子部门),子部门整棵树拉进来很容易变成几十人的大群,那是
   * 另一个决定;③不在通讯录里做群管理,建完直接落到会话里。
   *
   * 成员必须**翻完**:以前只取了第一页(全局每页 20 条),一个 60 人的部门建出来的
   * 群里只有 20 个人 —— 确认框上写的也是 20,少掉的人没有任何提示,事后几乎无法
   * 发现(群里少一个人,谁也不会去数)。现在先看服务端的 count:超过上限就明说拉不了
   * (几百人的群不该由一个按钮替用户决定),否则按每页 100 翻到底再建。
   */
  const handleStartGroupChat = async (dept: (typeof departments)[number]) => {
    const name = dept.name
    try {
      setStartingGroupChat(true)
      const firstPage = await fetchDirectoryMembersPage(undefined, undefined, {
        department: dept.id,
        pageSize: GROUP_CHAT_PAGE_SIZE,
      })
      if (firstPage.count > GROUP_CHAT_MEMBER_CAP) {
        void showAlert({
          message: t('department.startGroupChatTooMany', {
            count: firstPage.count,
            limit: GROUP_CHAT_MEMBER_CAP,
          }),
        })
        return
      }
      // 建群人由服务端加进去,这里只传其他人。
      const memberIds = firstPage.results
        .filter((m) => !m.is_self)
        .map((m) => m.id)
      let next = firstPage.next
      while (next) {
        // 翻页交给服务端给的 next:它已经带着 department 与 page_size,不必再拼一遍。
        const page = await fetchDirectoryMembersPage(undefined, next)
        next = page.next
        memberIds.push(
          ...page.results.filter((m) => !m.is_self).map((m) => m.id)
        )
      }
      if (memberIds.length === 0) {
        void showAlert({ message: t('department.startGroupChatEmpty') })
        return
      }
      const ok = await askConfirm({
        message: t('department.startGroupChatConfirm', {
          name,
          members: memberIds.length,
        }),
      })
      if (!ok) return
      const result = await createGroupConversation(memberIds, name)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      navigate(`/im?cid=${encodeURIComponent(result.cid)}`)
    } catch (e) {
      void showAlert({
        message: t('department.startGroupChatError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    } finally {
      setStartingGroupChat(false)
    }
  }

  // ── 中栏成员列表 ────────────────────────────────────────────────────────
  // 过滤主要在服务端做(见上文的 debouncedFilter):部门与「全部成员」两个视图的
  // `members` 已经是服务端筛完的结果,这里不再叠一层 —— 两份过滤叠加时,「筛出来的
  // 0 条」既可能是真的没人,也可能是这一页里没有,两种说法在界面上分不出来。
  //
  // 唯一的例外是**星标名单**:它走的是另一个端点(`/directory/starred/`),不支持
  // `?q=`,而且那是一份短名单(本来就整份取回)。让这个视图的筛选框变成打字没反应,
  // 是比「多一层客户端过滤」更糟的回归,所以只有它保留客户端过滤。
  const visibleMembers = useMemo(
    () =>
      view === 'starred' && debouncedFilter
        ? members.filter((m) => matchesQuery(m, debouncedFilter))
        : members,
    [view, members, debouncedFilter]
  )

  const listTitle =
    view === 'starred'
      ? t('starred.title')
      : // 组织根的名字与 App 一致:「内部联系人」而不是「全部成员」—— 同一个东西
        // 在两端叫同一个名(App 的通讯录首页入口就是这个)。
        (selectedDept?.name ?? t('page.orgMembers'))
  // 部门视图下部门名是重复信息(整列都是同一个部门),换成面包屑更有用。
  const listSubtitle = [
    deptAncestors.length > 0
      ? deptAncestors.map((a) => a.name).join(' / ')
      : null,
    typeof totalMembers === 'number'
      ? t('page.count', { count: totalMembers })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // 窗口化:上千人的名册只把可见的那二十来行放进 DOM(见 useVirtualRows)。
  //
  // 行高先按常量估,渲染后用**实测值**纠正:行高写得再死也会被字体、字号、
  // 未来的内边距改动带偏,MEMBER_ROW_HEIGHT 只是第一帧的猜测。差 1px,一千行就偏
  // 1000px(实测过一次:字体一回退,行就从 57 变成 64)。
  const [rowHeight, setRowHeight] = useState(MEMBER_ROW_HEIGHT)
  const listRef = useRef<HTMLUListElement | null>(null)
  const virtual = useVirtualRows({
    count: visibleMembers.length,
    rowHeight,
  })
  const windowMembers = visibleMembers.slice(
    virtual.startIndex,
    virtual.endIndex
  )
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const rendered = list.children.length
      if (rendered === 0) return
      const measured = list.getBoundingClientRect().height / rendered
      // 容差 0.5px:亚像素会有零头,不让它每帧都触发一次重算。
      if (measured > 0 && Math.abs(measured - rowHeight) > 0.5) {
        setRowHeight(measured)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // 也要盯着列表本身:字体换掉(web font 加载完成)会让行变高,而那时窗口长度
    // 一个都没变 —— 只靠依赖数组会漏掉这一次。
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [rowHeight, windowMembers.length])
  /** 悬浮字母头:视口顶部那一行属于哪个字母。 */
  const anchorInitial = visibleMembers[virtual.anchorIndex]?.initial ?? null

  // 列表内容换了(换部门 / 换视图 / 换筛选词)就回到顶部:否则滚动位置留在半山腰,
  // 新列表一上来就是中间那几行 —— 而那几行跟上一份结果没有任何关系。
  const { scrollToTop } = virtual
  useEffect(() => {
    scrollToTop()
  }, [view, effectiveDeptId, debouncedFilter, scrollToTop])

  // 滚到近底自动拉下一页(按钮保留做兜底:老浏览器 / 自动化测试里没有
  // IntersectionObserver,那时仍然可以手点)。
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const { scrollElement } = virtual
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !scrollElement || !hasNextPage || isFetchingNextPage)
      return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage()
      },
      { root: scrollElement, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, scrollElement])

  /** 右栏内容(桌面 = 第三栏,窄屏 = 浮层,见下)。都不选中时为 null —— 那时
   * 桌面显示空态提示,窄屏干脆不占地方。 */
  const detailPanel = selectedMember ? (
    <MemberDetailPanel
      member={selectedMember}
      starred={starredIds.has(selectedMember.id)}
      onToggleStarred={(next) =>
        void toggleContactPref(selectedMember, { is_starred: next })
      }
      specialAlert={alertIds.has(selectedMember.id)}
      onToggleSpecialAlert={(next) =>
        void toggleContactPref(selectedMember, { special_alert: next })
      }
      onMessage={handleMessage}
      onClose={() => selectMember(null)}
    />
  ) : selectedGroup ? (
    <GroupDetailPanel
      group={selectedGroup}
      label={selectedGroupLabel}
      memberInfo={myGroups.memberInfo}
      avatarSrc={myGroups.groupAvatars[selectedGroup.cid]}
      onEnter={() =>
        navigate(`/im?cid=${encodeURIComponent(selectedGroup.cid)}`)
      }
    />
  ) : selectedDept ? (
    <DepartmentDetailPanel
      department={selectedDept}
      ancestors={deptAncestors}
      // 部门负责人可能不在当前列表里(没分页到 / 属于子部门),交给 ?member=
      // 深链那条查询去取。
      onOpenHead={(userId) => selectMember(userId)}
      // 空部门不给按钮:点了必然是一句「没有成员」,不如不给。
      onStartGroupChat={
        selectedDept.member_count > 0
          ? () => void handleStartGroupChat(selectedDept)
          : undefined
      }
      startingGroupChat={startingGroupChat}
    />
  ) : null

  return (
    <div
      className={css({
        display: 'flex',
        height: '100%',
        minHeight: '600px',
        overflow: 'hidden',
      })}
    >
      {navCollapsed ? (
        // 收起态:只留一条 36px 窄条,把 260px 还给名单。按钮放在这里而不是中栏
        // 的页头里 —— 群组/外部联系人视图没有同一个页头,放那儿就找不到了。
        <div className={navStripCls}>
          <button
            type="button"
            onClick={toggleNav}
            aria-label={t('page.showNav')}
            title={t('page.showNav')}
            data-testid="contacts-nav-expand"
            className={navStripBtnCls}
          >
            <RiLayoutLeftLine size={16} />
          </button>
        </div>
      ) : (
        <ResizablePanel
          storageKey="we-meet:contacts-dept-width"
          defaultWidth={260}
          min={220}
          max={460}
        >
          <ContactsSidebar
            view={view}
            selectedDeptId={effectiveDeptId}
            departments={departments}
            recent={recentDepts}
            counts={counts}
            onSelectView={selectView}
            onSelectAll={selectAll}
            onSelectDept={selectDept}
            onCollapse={toggleNav}
          />
        </ResizablePanel>
      )}

      <main
        className={css({
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        {view === 'groups' ? (
          <MyGroupsPanel selectedCid={groupParam} onSelect={selectGroup} />
        ) : view === 'external' ? (
          <ExternalContactsPanel onMessage={handleExternalMessage} />
        ) : (
          <>
            <header className={listHeaderCls}>
              <div className={css({ minWidth: 0 })}>
                <h2 className={listTitleCls} data-testid="contacts-list-title">
                  {listTitle}
                </h2>
                {listSubtitle && (
                  <p
                    className={listSubtitleCls}
                    data-testid="contacts-list-subtitle"
                  >
                    {listSubtitle}
                  </p>
                )}
              </div>
              <div className={headerActionsCls}>
                <SearchBox
                  value={memberFilter}
                  onChange={setMemberFilter}
                  placeholder={t('page.filterMembers')}
                  testId="contacts-member-filter"
                  className={searchBoxCls}
                />
                {view === 'starred' && (
                  // dense 而非 sm:sm 不带字号,会吃到浏览器默认 16px,比同页的
                  //「发消息」大一号 —— 正是 buttonRecipe 里 dense 那档点名要收口的
                  //「通讯录『添加』vs『发消息』」不一致。
                  <Button
                    variant="secondary"
                    size="dense"
                    onPress={() => setAddingStarred(true)}
                    data-testid="contacts-starred-add"
                  >
                    {t('starred.add')}
                  </Button>
                )}
              </div>
            </header>

            <div className={listBodyCls}>
              <div
                className={scrollerCls}
                ref={virtual.scrollRef}
                onScroll={virtual.onScroll}
                data-testid="contacts-list-scroller"
              >
                {/* 悬浮字母头:滚动中始终知道自己看到哪个字母了(sticky,不占列表流,
                    所以行高还是定值,窗口化的算术不会被它打乱)。
                    字母来自服务端下发的 `initial`(拼音序是服务端排的),前端不自己算。
                    '#' 桶直接显示井号本身 —— 它是一段(数字/符号/空名字),不是「其他」。 */}
                {letterHeadersEnabled && pinyinOrder && anchorInitial && (
                  <div
                    className={letterChipCls}
                    data-testid="contacts-letter-chip"
                  >
                    {anchorInitial}
                  </div>
                )}
                {/* 加载失败要说「加载失败」并给一条重试的路。以前这里没有 error
                    分支:请求挂了就落到下面的空态,显示「暂无成员」—— 把一次网络/权限
                    故障说成「公司里没有人」,用户会去找管理员而不是刷新一次。
                    (keepPreviousData 会让失败时仍留着上一份结果,所以判的是 isError
                    而不是「列表为空」:那份旧名单与当前筛选词已经对不上了。) */}
                {isError ? (
                  <StateHint
                    state="error"
                    action={
                      <Button
                        variant="secondary"
                        size="dense"
                        onPress={() => void refetch()}
                        data-testid="contacts-retry"
                      >
                        {t('picker.retry')}
                      </Button>
                    }
                  >
                    {t('picker.loadError')}
                  </StateHint>
                ) : isFetching && visibleMembers.length === 0 ? (
                  <StateHint state="loading">{t('page.loading')}</StateHint>
                ) : visibleMembers.length === 0 ? (
                  <StateHint>
                    {/* 筛出来是空的,与「这个部门本来就没人」是两句不同的话:
                        前者要告诉用户「换个词试试」,后者才是「这里没人」。 */}
                    {debouncedFilter
                      ? t('page.noMatch')
                      : view === 'starred'
                        ? t('starred.empty')
                        : t('page.empty')}
                  </StateHint>
                ) : (
                  // 整表高度撑着滚动条,里面只放当前窗口那几行(translateY 到正确位置)。
                  <div
                    className={spacerCls}
                    style={{ height: virtual.totalHeight }}
                  >
                    <ul
                      className={listCls}
                      ref={listRef}
                      style={{ transform: `translateY(${virtual.offsetY}px)` }}
                      data-testid="contacts-member-list"
                    >
                      {windowMembers.map((member) => {
                        const label =
                          member.full_name ||
                          member.short_name ||
                          member.email ||
                          ''
                        const selected = selectedMember?.id === member.id
                        // 部门视图里每行都写一遍「开发部」是零信息,只留职位。
                        const meta = (
                          effectiveDeptId
                            ? [member.title]
                            : [member.title, member.department?.name]
                        )
                          .filter(Boolean)
                          .join(' · ')
                        return (
                          <li
                            key={member.id}
                            className={cx(
                              memberRowCls,
                              css({
                                backgroundColor: selected
                                  ? 'greyscale.100'
                                  : 'transparent',
                              })
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => selectMember(member.id)}
                              data-testid={`contacts-member-${member.id}`}
                              className={memberMainCls}
                            >
                              {member.avatar_url ? (
                                <img
                                  src={member.avatar_url}
                                  alt={label}
                                  className={avatarCls}
                                />
                              ) : (
                                <span className={avatarFallbackCls}>
                                  {(label || '?').slice(0, 1).toUpperCase()}
                                </span>
                              )}
                              <span className={memberTextCls}>
                                <span className={memberNameCls}>
                                  {label}
                                  {/* 星标标记(对标飞书:名字后跟一颗 ⭐)。 */}
                                  {starredIds.has(member.id) && (
                                    <span
                                      aria-label={t('starred.title')}
                                      title={t('starred.title')}
                                    >
                                      {' '}
                                      ⭐
                                    </span>
                                  )}
                                  {member.is_self && (
                                    <span
                                      className={css({
                                        color: 'greyscale.400',
                                      })}
                                    >
                                      {' '}
                                      {t('page.selfTag')}
                                    </span>
                                  )}
                                </span>
                                {meta && (
                                  <span className={memberMetaCls}>{meta}</span>
                                )}
                              </span>
                            </button>
                            {/* 行尾动作:hover / 键盘聚焦才出现(触屏常显)。以前每个
                        成员行都挂一颗常显的「发消息」,一屏十几颗同重量按钮既是
                        噪声、又把名字和按钮拉开几百像素。 */}
                            {view === 'starred' ? (
                              <span data-row-action className={rowActionCls}>
                                <Button
                                  variant="secondaryText"
                                  size="dense"
                                  onPress={() =>
                                    void toggleContactPref(member, {
                                      is_starred: false,
                                    })
                                  }
                                  data-testid={`contacts-unstar-${member.id}`}
                                >
                                  {t('starred.remove')}
                                </Button>
                              </span>
                            ) : !member.is_self ? (
                              <span data-row-action className={rowActionCls}>
                                <Button
                                  variant="secondary"
                                  size="dense"
                                  onPress={() => handleMessage(member)}
                                  data-testid={`contacts-message-${member.id}`}
                                >
                                  {t('page.message')}
                                </Button>
                              </span>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
                {/* 只有真的还有下一页**且这一屏已经有内容**时才出现。之前列表在第
                100 人处静默截断,页面上没有任何迹象说明「还没完」;现在滚到近底自动
                续,按钮是兜底(老浏览器 / 没有 IntersectionObserver 的环境)。
                「列表非空」这个条件不是多余的:空态里挂一个「加载更多」,点它就等于
                把「没结果」和「还没加载」两件事混在一起 —— 用户会一直点下去。
                放在整表高度之后 = 真的在底部,不会一进页面就误触发。 */}
                {hasNextPage && visibleMembers.length > 0 && (
                  <div ref={sentinelRef} className={loadMoreCls}>
                    <Button
                      variant="tertiaryText"
                      size="sm"
                      onPress={() => void fetchNextPage()}
                      isDisabled={isFetchingNextPage}
                      data-testid="contacts-load-more"
                    >
                      {isFetchingNextPage
                        ? t('page.loading')
                        : t('page.loadMore')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* 右栏:桌面宽度下恒定占位(以前没选中就整块不渲染,中栏宽度会随选择跳
          一次);窄屏下改成浮层(见 detailPanel 的注释)。
          优先级:成员卡 > 群资料卡 > 部门卡 > 空态提示。 */}
      {narrowDetail
        ? !detailDismissed &&
          detailPanel &&
          // 窄屏(≤1280px):三栏放不下,右栏改成盖在名单上的浮层 —— 名单保住
          // 自己的宽度(否则一排名字会被挤到只剩一个头像),关掉浮层就回到名单。
          // 与任务的「接管式详情」同一手法,只是这里盖住的是通讯录而不是整页。
          createPortal(
            <div className={takeoverCls} data-testid="contacts-detail-overlay">
              <div className={takeoverHeaderCls}>
                <Button
                  variant="secondaryText"
                  size="dense"
                  onPress={() => setDetailDismissed(true)}
                  data-testid="contacts-detail-back"
                >
                  <RiArrowLeftLine size={16} aria-hidden />
                  {t('detail.back')}
                </Button>
              </div>
              <div className={takeoverBodyCls}>{detailPanel}</div>
            </div>,
            document.body
          )
        : (detailPanel ?? <ContactsDetailPlaceholder view={view} />)}

      {addingStarred && (
        <StarredAddDialog
          alreadyStarredIds={starredIds}
          onDone={() => {
            setAddingStarred(false)
            void qc.invalidateQueries({ queryKey: ['directory', 'starred'] })
            void qc.invalidateQueries({ queryKey: ['directory', 'members'] })
          }}
          onClose={() => setAddingStarred(false)}
          onError={(message) =>
            void showAlert({ message: t('starred.error', { message }) })
          }
        />
      )}
    </div>
  )
}

/**
 * 表头(标题 / 筛选框 / 「添加」)。
 *
 * 右侧内边距比左侧多一条滚动条槽(全局细滚动条宽 10px,见 styles/index.css):
 * 名单在滚动容器里,行的右缘已经被槽位占了 10px —— 表头不补这 10px,「筛选成员」
 * 的右缘就会比行尾的「发消息」靠外 10px,看着就是两列没对齐。
 */
const listHeaderCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  paddingLeft: '1rem',
  paddingRight: 'calc(1rem + 10px)',
  paddingY: '0.625rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

/** 左栏收起后的窄条:恒定留在最左侧,所以「展开」在任何视图下都能找到。 */
const navStripCls = css({
  flexShrink: 0,
  width: '36px',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: '0.75rem',
  borderRight: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.50',
})
const navStripBtnCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.75rem',
  height: '1.75rem',
  border: 'none',
  borderRadius: '6px',
  background: 'transparent',
  color: 'greyscale.500',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.800' },
})

/** 窄屏的右栏浮层:盖住内容区,自带一条返回栏。 */
const takeoverCls = css({
  position: 'fixed',
  inset: 0,
  zIndex: 'takeover',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'greyscale.50',
})
const takeoverHeaderCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  paddingX: '0.5rem',
  paddingY: '0.375rem',
  backgroundColor: 'greyscale.000',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const takeoverBodyCls = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  justifyContent: 'center',
  // 面板本身写死了 300px(桌面第三栏的宽度),浮层里让它铺满并居中。
  '& > aside': {
    width: '100%',
    maxWidth: '960px',
    backgroundColor: 'greyscale.000',
    boxShadow: '0 0 0 1px token(colors.greyscale.200)',
  },
})
const listTitleCls = css({
  margin: 0,
  fontSize: '0.9375rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})
const listSubtitleCls = css({
  margin: '0.125rem 0 0',
  fontSize: '0.75rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const headerActionsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexShrink: 0,
})
/** 表头那颗筛选框只出宽度 —— 长相由统一搜索框 SearchBox 负责。 */
const searchBoxCls = css({
  width: '14rem',
  maxWidth: '40vw',
})
const listCls = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  // 曾经这里有一条 maxWidth: 60rem「别让行在超宽屏上无限拉长」。它的问题比它解决的
  // 多:中栏一旦宽过 60rem,行(连同行尾的「发消息」)就比上面的表头窄一截,按钮与
  // 「筛选成员」输入框的右缘对不齐 —— 96px 的空档比「名字离按钮远一点」显眼得多。
  // 名字与按钮的距离由行本身的网格管(1fr + 行尾动作槽),不需要再来一道宽度上限。
})

/** 列表本体 = 可滚动的名单 + 右侧索引条。索引条是 flex 兄弟而不是浮层,
 *  不会盖住行尾的按钮,也不用为它留内边距。 */
const listBodyCls = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'stretch',
})
const scrollerCls = css({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  // 滚动条槽位恒定保留:名单从「不满一屏」涨到「要滚」时行宽不该跳一下。
  // (也让下面表头的右内边距能按同一个槽宽对齐 —— 见 listHeaderCls。)
  scrollbarGutter: 'stable',
})
/** 整表高度的占位框:窗口里的那几行绝对定位到它的顶部再 translateY。 */
const spacerCls = css({ position: 'relative' })
/** 悬浮字母头:滚动中始终知道自己看到哪个字母了。 */
const letterChipCls = css({
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  height: '1.25rem',
  paddingX: '0.5rem',
  marginLeft: '0.5rem',
  borderRadius: '0 0 6px 6px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.600',
  fontSize: '0.6875rem',
  fontWeight: '600',
  pointerEvents: 'none',
})
const memberRowCls = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  // 定高 = MEMBER_ROW_HEIGHT:36px 头像 + 上下各 10px 内边距 + 1px 分隔线。
  // box-sizing 是 border-box,所以这个高度**含**那 1px 边框 —— 少算 1px,一千行就
  // 会累计偏 1000px(窗口化的位置全靠这个数)。改这里要同步改常量。
  height: '57px',
  borderBottom: '1px solid token(colors.greyscale.100)',
  _hover: {
    backgroundColor: 'greyscale.50',
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
  },
  _focusWithin: {
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
  },
})
const memberMainCls = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  paddingX: '1rem',
  paddingY: '0.625rem',
})
const avatarCls = css({
  flexShrink: 0,
  width: '36px',
  height: '36px',
  borderRadius: '8px',
  objectFit: 'cover',
})
const avatarFallbackCls = css({
  flexShrink: 0,
  width: '36px',
  height: '36px',
  borderRadius: '8px',
  backgroundColor: 'primary.500',
  color: 'white',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.875rem',
})
const memberTextCls = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  // 不设 gap:两行行高(20+16)要正好等于头像的 36px,行高才是定值。
  gap: 0,
})
const memberNameCls = css({
  fontSize: '0.875rem',
  // 行高必须写死:窗口化要求行高固定,而「正常行高」是跟着字体走的(fallback 字体
  // 一换就变)。20 + 16 = 36 = 头像高度,行盒于是正好 36px。
  lineHeight: '20px',
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const memberMetaCls = css({
  fontSize: '0.75rem',
  lineHeight: '16px',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
/** 行尾动作槽:hover / 聚焦才现身,但**始终占位** —— 否则悬停时整行内容会横向位移。 */
const rowActionCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: '6rem',
  paddingRight: '1rem',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease',
  '@media (hover: none)': { opacity: 1, pointerEvents: 'auto' },
})
const loadMoreCls = css({
  display: 'flex',
  justifyContent: 'center',
  padding: '0.75rem',
})

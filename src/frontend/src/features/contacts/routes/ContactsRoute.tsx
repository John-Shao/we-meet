import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useLocation, useSearchParams } from 'wouter'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import { DepartmentTree } from '../components/DepartmentTree'
import { DepartmentDetailPanel } from '../components/DepartmentDetailPanel'
import { MemberDetailPanel } from '../components/MemberDetailPanel'
import { MyGroupsPanel } from '../components/MyGroupsPanel'
import { StarredAddDialog } from '../components/StarredAddDialog'
import { ExternalContactsPanel } from '../components/ExternalContactsPanel'
import { fetchDepartmentMembersPage } from '../api/fetchDepartmentMembers'
import { fetchDepartments } from '../api/fetchDepartments'
import { fetchDirectoryMembersPage } from '../api/fetchDirectoryMembers'
import { fetchDirectoryMember } from '../api/fetchDirectoryMember'
import { fetchStarredContacts } from '../api/fetchStarredContacts'
import { fetchContactPrefs, setContactPref } from '../api/setContactPref'
import type { DirectoryMember } from '../api/ApiDirectory'
import type { ExternalContact } from '../api/ApiDirectory'

/**
 * `/contacts` — org directory: browse the department tree (left) and the members
 * of the selected department or a name/email search (right). "Message" starts a
 * direct IM conversation. Organization administration (creating / deleting
 * departments, moving members) lives in the management console, not here.
 */
export const ContactsRoute = () => (
  <RequireAuth>
    <Screen>
      <ContactsAuthenticated />
    </Screen>
  </RequireAuth>
)

const ContactsAuthenticated = () => {
  const { t } = useTranslation('contacts')
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const { alert: showAlert } = useConfirm()
  // 左栏四态:'starred'(星标联系人)/ 'groups'(我的群组)/ null(全部成员)/ 部门 id。
  const [view, setView] = useState<'starred' | 'groups' | 'external' | null>(
    null
  )
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null)
  const [selectedMember, setSelectedMember] = useState<DirectoryMember | null>(
    null
  )
  const [addingStarred, setAddingStarred] = useState(false)

  const selectDept = (id: string | null) => {
    setView(null)
    setSelectedDeptId(id)
    setSelectedMember(null)
  }

  const selectStarred = () => {
    setView('starred')
    setSelectedDeptId(null)
    setSelectedMember(null)
  }

  const selectGroups = () => {
    setView('groups')
    setSelectedDeptId(null)
    setSelectedMember(null)
  }

  const selectExternal = () => {
    setView('external')
    setSelectedDeptId(null)
    setSelectedMember(null)
  }

  // 深链 `/contacts?member=<userId>`(如从 IM 消息头像点击跳转):按 id 拉该成员
  // 并打开详情卡。用 ref 记录已应用的 id,关闭后不再自动重开。
  const [searchParams] = useSearchParams()
  const memberIdParam = searchParams.get('member')
  const { data: linkedMember } = useQuery({
    queryKey: ['directory', 'member', memberIdParam],
    queryFn: () => fetchDirectoryMember(memberIdParam!),
    enabled: !!memberIdParam,
    staleTime: 30_000,
  })
  const appliedMemberIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (linkedMember && appliedMemberIdRef.current !== linkedMember.id) {
      appliedMemberIdRef.current = linkedMember.id
      setSelectedMember(linkedMember)
    }
  }, [linkedMember])

  const { data: departments = [] } = useQuery({
    queryKey: ['directory', 'departments'],
    queryFn: () => fetchDepartments(),
    staleTime: 60_000,
  })

  // 通讯录只负责「浏览」组织:选部门列其直属成员,全部成员列整册。
  // 按姓名找人统一走顶栏全局搜索(飞书式单一搜索入口),这里不设搜索框。
  //
  // 分页而不是只取第一页:一个上百人的部门原来会在第 100 人处静默截断,页面上
  // 没有任何迹象表明列表还没完。星标名单不分页(它本来就短)。
  const {
    data: memberPages,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['directory', 'members', 'page', { dept: selectedDeptId, view }],
    queryFn: ({ pageParam }) =>
      view === 'starred'
        ? fetchStarredContacts().then((results) => ({
            count: results.length,
            next: null,
            previous: null,
            results,
          }))
        : selectedDeptId
          ? fetchDepartmentMembersPage(selectedDeptId, false, pageParam)
          : fetchDirectoryMembersPage(undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    staleTime: 30_000,
    // 「我的群组」视图里根本不渲染成员名单,别白拉一整册人。
    enabled: view !== 'groups' && view !== 'external',
  })
  const members = useMemo(
    () => (memberPages?.pages ?? []).flatMap((page) => page.results),
    [memberPages]
  )

  const selectedDept = useMemo(
    () => departments.find((d) => d.id === selectedDeptId) ?? null,
    [departments, selectedDeptId]
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

  return (
    <div
      className={css({
        display: 'flex',
        height: '100%',
        minHeight: '600px',
        overflow: 'hidden',
      })}
    >
      <ResizablePanel
        storageKey="we-meet:contacts-dept-width"
        defaultWidth={260}
        min={220}
        max={460}
      >
        <aside
          className={css({
            width: '100%',
            height: '100%',
            borderRight: '1px solid token(colors.greyscale.200)',
            overflowY: 'auto',
            backgroundColor: 'greyscale.50',
          })}
        >
          <div className={css({ paddingX: '1rem', paddingY: '0.75rem' })}>
            <h2
              className={css({
                margin: 0,
                fontSize: '1rem',
                fontWeight: 'bold',
                color: 'greyscale.900',
              })}
            >
              {t('page.departments')}
            </h2>
          </div>
          <div>
            {/* 星标联系人:与部门并列的一个入口(对标飞书通讯录的独立分组)。 */}
            <button
              type="button"
              onClick={selectStarred}
              data-testid="contacts-starred-entry"
              className={deptButton(view === 'starred')}
            >
              ⭐ {t('starred.title')}
            </button>
            {/* 我的群组:零后端 —— 群清单就是 IM 会话列表里 type==='group' 的
              那部分,复用会话列表已有的查询缓存。 */}
            <button
              type="button"
              onClick={selectGroups}
              data-testid="contacts-groups-entry"
              className={deptButton(view === 'groups')}
            >
              👥 {t('groups.title')}
            </button>
            <button
              type="button"
              onClick={selectExternal}
              data-testid="contacts-external-entry"
              className={deptButton(view === 'external')}
            >
              ◇ {t('external.title')}
            </button>
            <button
              type="button"
              onClick={() => selectDept(null)}
              className={deptButton(view === null && selectedDeptId === null)}
            >
              {t('page.allMembers')}
            </button>
            <DepartmentTree
              departments={departments}
              selectedId={selectedDeptId}
              onSelect={selectDept}
            />
          </div>
        </aside>
      </ResizablePanel>

      <main
        className={css({
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        {view === 'groups' ? (
          <MyGroupsPanel />
        ) : view === 'external' ? (
          <ExternalContactsPanel onMessage={handleExternalMessage} />
        ) : (
          <>
            {view === 'starred' && (
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingX: '1rem',
                  paddingY: '0.625rem',
                  borderBottom: '1px solid token(colors.greyscale.200)',
                })}
              >
                <h2
                  className={css({
                    margin: 0,
                    fontSize: '0.9375rem',
                    fontWeight: 'bold',
                    color: 'greyscale.900',
                  })}
                >
                  {t('starred.title')}
                </h2>
                {/* dense 而非 sm:sm 不带字号,会吃到浏览器默认 16px,比同页的
                「发消息」大一号 —— 正是 buttonRecipe 里 dense 那档点名要收口的
                「通讯录『添加』vs『发消息』」不一致。 */}
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => setAddingStarred(true)}
                  data-testid="contacts-starred-add"
                >
                  {t('starred.add')}
                </Button>
              </div>
            )}
            <div className={css({ overflowY: 'auto', flex: 1 })}>
              {isFetching && members.length === 0 ? (
                <StateHint state="loading">{t('page.loading')}</StateHint>
              ) : members.length === 0 ? (
                <StateHint>
                  {view === 'starred' ? t('starred.empty') : t('page.empty')}
                </StateHint>
              ) : (
                <ul
                  className={css({ listStyle: 'none', margin: 0, padding: 0 })}
                >
                  {members.map((member) => {
                    const label =
                      member.full_name ||
                      member.short_name ||
                      member.email ||
                      ''
                    const selected = selectedMember?.id === member.id
                    return (
                      <li
                        key={member.id}
                        className={css({
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px solid token(colors.greyscale.100)',
                          // 选中用会翻转的 greyscale.100(避免浅蓝底配翻转后的浅字看不见)。
                          backgroundColor: selected
                            ? 'greyscale.100'
                            : 'transparent',
                          _hover: { backgroundColor: 'greyscale.50' },
                        })}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedMember(member)}
                          data-testid={`contacts-member-${member.id}`}
                          className={css({
                            flex: 1,
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
                          })}
                        >
                          {member.avatar_url ? (
                            <img
                              src={member.avatar_url}
                              alt={label}
                              className={css({
                                flexShrink: 0,
                                width: '36px',
                                height: '36px',
                                borderRadius: '8px',
                                objectFit: 'cover',
                              })}
                            />
                          ) : (
                            <span
                              className={css({
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
                              })}
                            >
                              {(label || '?').slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <span
                            className={css({
                              minWidth: 0,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.125rem',
                            })}
                          >
                            <span
                              className={css({
                                fontWeight: 'medium',
                                color: 'greyscale.900',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              })}
                            >
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
                                  className={css({ color: 'greyscale.400' })}
                                >
                                  {' '}
                                  {t('page.selfTag')}
                                </span>
                              )}
                            </span>
                            <span
                              className={css({
                                fontSize: '0.75rem',
                                color: 'greyscale.500',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              })}
                            >
                              {[member.title, member.department?.name]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                        </button>
                        {view === 'starred' && (
                          <span
                            className={css({
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              marginRight: '0.5rem',
                            })}
                          >
                            {/* 与其它分组行尾的「发消息」同档(dense):它俩占同一个
                            列位,尺寸必须一致,否则切分组时行高会跳。 */}
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
                        )}
                        {/* 星标名单里不放「发消息」:那一行已经有「取消星标」,再并一个
                        按钮既挤又抢焦点,而点整行就能开详情卡、卡里就有发消息。 */}
                        {view !== 'starred' && !member.is_self && (
                          <span
                            className={css({
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              marginRight: '1rem',
                            })}
                          >
                            <Button
                              variant="secondary"
                              size="dense"
                              onPress={() => handleMessage(member)}
                              data-testid={`contacts-message-${member.id}`}
                            >
                              {t('page.message')}
                            </Button>
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {/* 只有真的还有下一页时才出现 —— 之前列表在第 100 人处静默截断,页面
              上没有任何迹象说明「还没完」。 */}
              {hasNextPage && (
                <div
                  className={css({
                    display: 'flex',
                    justifyContent: 'center',
                    padding: '0.75rem',
                  })}
                >
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
          </>
        )}
      </main>

      {/* 右栏三态:选了人 → 成员卡;只选了部门 → 部门卡(终于用上 head);
          都没选 → 不渲染。 */}
      {view !== 'external' && !selectedMember && selectedDept && (
        <DepartmentDetailPanel
          department={selectedDept}
          ancestors={deptAncestors}
          onOpenHead={(userId) => {
            const inList = members.find((m) => m.id === userId)
            if (inList) setSelectedMember(inList)
            else void fetchDirectoryMember(userId).then(setSelectedMember)
          }}
        />
      )}

      {selectedMember && (
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
          onClose={() => setSelectedMember(null)}
        />
      )}

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

const deptButton = (active: boolean) =>
  css({
    display: 'block',
    flex: 1,
    minWidth: 0,
    paddingX: '0.75rem',
    paddingY: '0.5rem',
    border: 'none',
    borderBottom: '1px solid token(colors.greyscale.100)',
    textAlign: 'left',
    fontSize: '0.875rem',
    cursor: 'pointer',
    // 选中态走 selected.*(自带深浅两套);非选中用会翻转的 greyscale.800。
    color: active ? 'selected.text' : 'greyscale.800',
    fontWeight: active ? '600' : undefined,
    backgroundColor: active ? 'selected.bg' : 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    // hover 也要分选中/未选中:原先无条件盖 greyscale.100,鼠标一碰选中行
    // 底色就退回中性灰,配 selected.text 的蓝字对比度掉下来(同 AdminShell 那个坑)。
    _hover: { backgroundColor: active ? 'selected.bg' : 'greyscale.100' },
  })

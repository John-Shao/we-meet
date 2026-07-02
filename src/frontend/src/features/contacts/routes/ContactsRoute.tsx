import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import { DepartmentTree } from '../components/DepartmentTree'
import { MemberDetailPanel } from '../components/MemberDetailPanel'
import { fetchDepartmentMembers } from '../api/fetchDepartmentMembers'
import { fetchDepartments } from '../api/fetchDepartments'
import { fetchDirectoryMembers } from '../api/fetchDirectoryMembers'
import type { DirectoryMember } from '../api/ApiDirectory'

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
  const { alert: showAlert } = useConfirm()
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [includeSubtree, setIncludeSubtree] = useState(false)
  const [selectedMember, setSelectedMember] = useState<DirectoryMember | null>(
    null
  )

  // 选部门 / 全部成员时清空搜索,避免上一处的关键词残留造成空结果的困惑。
  const selectDept = (id: string | null) => {
    setSelectedDeptId(id)
    setSelectedMember(null)
    setSearch('')
  }

  const { data: departments = [] } = useQuery({
    queryKey: ['directory', 'departments'],
    queryFn: () => fetchDepartments(),
    staleTime: 60_000,
  })

  // 部门视图:搜索在客户端过滤(serverQuery='',不随输入重拉);全部成员视图:
  // 服务端按关键词搜索(覆盖全部成员,非仅首页)。serverQuery 同时进 key 与 queryFn。
  const serverQuery = selectedDeptId ? '' : search
  const { data: members = [], isFetching } = useQuery({
    queryKey: [
      'directory',
      'members',
      { dept: selectedDeptId, subtree: includeSubtree, q: serverQuery },
    ],
    queryFn: () =>
      selectedDeptId
        ? fetchDepartmentMembers(selectedDeptId, includeSubtree)
        : fetchDirectoryMembers(serverQuery),
    staleTime: 30_000,
  })

  // 部门视图内的搜索在客户端过滤已拉取成员(姓名/简称/邮箱);全部成员视图走服务端。
  const displayedMembers = useMemo(() => {
    if (!selectedDeptId) return members
    const q = search.trim().toLowerCase()
    if (!q) return members
    return members.filter((m) =>
      [m.full_name, m.short_name, m.email]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    )
  }, [members, selectedDeptId, search])

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
          <button
            type="button"
            onClick={() => selectDept(null)}
            className={deptButton(selectedDeptId === null)}
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
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 1rem',
          })}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('page.searchPlaceholder')}
            data-testid="contacts-search"
            className={css({
              flex: 1,
              maxWidth: '360px',
              paddingX: '0.75rem',
              paddingY: '0.5rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
              outline: 'none',
              _focus: { borderColor: 'primary.500' },
            })}
          />
          {selectedDeptId && (
            <label
              className={css({
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.8125rem',
                color: 'greyscale.700',
                cursor: 'pointer',
                userSelect: 'none',
              })}
            >
              <input
                type="checkbox"
                checked={includeSubtree}
                onChange={(e) => setIncludeSubtree(e.target.checked)}
                data-testid="contacts-include-subtree"
              />
              {t('page.includeSubtree')}
            </label>
          )}
        </div>
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {isFetching && members.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('page.loading')}
            </p>
          ) : displayedMembers.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('page.empty')}
            </p>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {displayedMembers.map((member) => {
                const label =
                  member.full_name || member.short_name || member.email || ''
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
                      backgroundColor: selected ? 'greyscale.100' : 'transparent',
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
                          {member.is_self && (
                            <span className={css({ color: 'greyscale.400' })}>
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
                    {!member.is_self && (
                      <button
                        type="button"
                        onClick={() => handleMessage(member)}
                        data-testid={`contacts-message-${member.id}`}
                        className={css({
                          flexShrink: 0,
                          marginRight: '1rem',
                          border: '1px solid token(colors.primary.300)',
                          borderRadius: '0.5rem',
                          backgroundColor: 'greyscale.000',
                          paddingX: '0.75rem',
                          paddingY: '0.375rem',
                          fontSize: '0.8125rem',
                          cursor: 'pointer',
                          color: 'primary.600',
                          _hover: { backgroundColor: 'primary.50' },
                        })}
                      >
                        {t('page.message')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </main>

      {selectedMember && (
        <MemberDetailPanel
          member={selectedMember}
          onMessage={handleMessage}
          onClose={() => setSelectedMember(null)}
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
    // 选中:蓝底 primary.100(浅/深都为浅蓝)配深蓝字 primary.700(浅/深都深),
    // 两种主题都可读;非选中用会翻转的 greyscale.800。
    color: active ? 'primary.700' : 'greyscale.800',
    fontWeight: active ? '600' : undefined,
    backgroundColor: active ? 'primary.100' : 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    _hover: { backgroundColor: 'greyscale.100' },
  })

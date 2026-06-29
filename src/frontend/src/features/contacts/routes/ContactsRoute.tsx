import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'

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
export const ContactsRoute = () => {
  const { t } = useTranslation('contacts')
  const { user, isLoggedIn } = useUser()

  if (!isLoggedIn || !user) {
    return (
      <div className={css({ padding: '2rem', color: 'greyscale.700' })}>
        {t('page.authRequired')}
      </div>
    )
  }
  return <ContactsAuthenticated />
}

const ContactsAuthenticated = () => {
  const { t } = useTranslation('contacts')
  const [, navigate] = useLocation()
  const { alert: showAlert } = useConfirm()
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedMember, setSelectedMember] = useState<DirectoryMember | null>(
    null
  )

  const { data: departments = [] } = useQuery({
    queryKey: ['directory', 'departments'],
    queryFn: () => fetchDepartments(),
    staleTime: 60_000,
  })

  const { data: members = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', { dept: selectedDeptId, q: search }],
    queryFn: () =>
      selectedDeptId
        ? fetchDepartmentMembers(selectedDeptId)
        : fetchDirectoryMembers(search),
    staleTime: 30_000,
  })

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
        <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
          <li className={css({ display: 'flex' })}>
            <button
              type="button"
              onClick={() => {
                setSelectedDeptId(null)
                setSelectedMember(null)
              }}
              className={deptButton(selectedDeptId === null)}
            >
              {t('page.allMembers')}
            </button>
          </li>
          {departments.map((dept) => (
            <li key={dept.id} className={css({ display: 'flex' })}>
              <button
                type="button"
                onClick={() => {
                  setSelectedDeptId(dept.id)
                  setSelectedMember(null)
                }}
                style={{ paddingLeft: `${0.75 + dept.depth * 0.75}rem` }}
                className={deptButton(selectedDeptId === dept.id)}
                data-testid={`contacts-dept-${dept.id}`}
              >
                {dept.name}
              </button>
            </li>
          ))}
        </ul>
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
        {!selectedDeptId && (
          <div className={css({ padding: '0.75rem 1rem' })}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('page.searchPlaceholder')}
              data-testid="contacts-search"
              className={css({
                width: '100%',
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
          </div>
        )}
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {isFetching && members.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('page.loading')}
            </p>
          ) : members.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('page.empty')}
            </p>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {members.map((member) => {
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
                      backgroundColor: selected ? 'primary.50' : 'transparent',
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
                            borderRadius: 'full',
                            objectFit: 'cover',
                          })}
                        />
                      ) : (
                        <span
                          className={css({
                            flexShrink: 0,
                            width: '36px',
                            height: '36px',
                            borderRadius: 'full',
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
                          backgroundColor: 'white',
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
    color: 'greyscale.800',
    backgroundColor: active ? 'primary.100' : 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    _hover: { backgroundColor: 'greyscale.100' },
  })

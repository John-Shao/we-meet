import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { fetchDirectoryMembers, MemberAvatar } from '@/features/contacts'

import type { MeetInviteTarget } from './meetInviteTracker'

/**
 * P4 通话中拉人 — directory multi-picker shown over the in-call stage.
 * Mirrors AddMemberDialog's shape but is decoupled from any group cid: the
 * output is just picked members, which the caller hands to sendMeetInvites.
 * Members already in the room are not filtered here (LiveKit identity is the
 * OIDC sub, not the directory id) — a re-invited present member simply
 * auto-answers busy and the grid already shows who's in.
 */
export const MeetInvitePicker = ({
  onInvite,
  onClose,
  excludeUserIds,
  footer,
  initialQuery,
}: {
  onInvite: (targets: MeetInviteTarget[]) => void
  onClose: () => void
  /** P4.1 会议拉人: hide members already in the room (resolve-subs ids). */
  excludeUserIds?: Set<string>
  /** P5 统一邀请面板: share-link / meeting-code section rendered between the
   * member list and the confirm bar — absent for plain pickers. */
  footer?: ReactNode
  /** P5.1(实测问题2): seed the search with what the user already typed in
   * the participants panel's 搜索或呼叫 box — 输入不白打. */
  initialQuery?: string
}) => {
  const { t } = useTranslation('im')
  const [query, setQuery] = useState(initialQuery ?? '')
  // id → {label, avatar} captured at toggle time (list content changes with
  // the query).
  const [selected, setSelected] = useState<
    Map<string, { label: string; avatarUrl?: string }>
  >(new Map())
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: members = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', query],
    queryFn: () => fetchDirectoryMembers(query),
    staleTime: 30_000,
  })
  const selectable = members
    .filter((m) => !m.is_self)
    .filter((m) => !excludeUserIds?.has(m.id))

  const toggle = (id: string, label: string, avatarUrl?: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, { label, avatarUrl })
      return next
    })

  const confirm = () => {
    onInvite(
      [...selected.entries()].map(([userId, v]) => ({
        userId,
        label: v.label,
        avatarUrl: v.avatarUrl,
      }))
    )
    onClose()
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={overlay}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('call.invite.title')}
        className={modal}
      >
        <div className={modalHead}>
          <h2
            className={css({
              margin: 0,
              fontSize: '1rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('call.invite.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('call.cancel')}
            className={closeBtn}
          >
            ×
          </button>
        </div>
        <div className={css({ padding: '0.75rem 1rem' })}>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('group.searchPlaceholder')}
            data-testid="meet-invite-search"
            className={inputCls}
          />
        </div>
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {isFetching && selectable.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('group.loading')}
            </p>
          ) : selectable.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('manage.empty')}
            </p>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {selectable.map((m) => {
                const label = m.full_name || m.short_name || m.email || m.id
                const checked = selected.has(m.id)
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggle(m.id, label, m.avatar_url || undefined)}
                      aria-pressed={checked}
                      data-testid={`meet-invite-item-${m.id}`}
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.625rem',
                        width: '100%',
                        paddingX: '1rem',
                        paddingY: '0.5rem',
                        border: 'none',
                        borderBottom: '1px solid token(colors.greyscale.100)',
                        backgroundColor: checked
                          ? 'greyscale.100'
                          : 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                        _hover: { backgroundColor: 'greyscale.100' },
                      })}
                    >
                      <span
                        aria-hidden="true"
                        className={css({
                          flexShrink: 0,
                          width: '1.125rem',
                          height: '1.125rem',
                          borderRadius: '0.25rem',
                          border: '1px solid token(colors.greyscale.400)',
                          backgroundColor: checked ? 'primary.500' : 'white',
                          color: 'white',
                          fontSize: '0.75rem',
                          lineHeight: '1.125rem',
                          textAlign: 'center',
                        })}
                      >
                        {checked ? '✓' : ''}
                      </span>
                      <MemberAvatar name={label} src={m.avatar_url} size="2rem" />
                      <span
                        className={css({
                          display: 'flex',
                          flexDirection: 'column',
                          minWidth: 0,
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
                        </span>
                        <span
                          className={css({
                            fontSize: '0.75rem',
                            color: 'greyscale.500',
                          })}
                        >
                          {[m.title, m.department?.name]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {footer}
        <div className={modalFoot}>
          <span className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
            {t('group.selected', { count: selected.size })}
          </span>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={confirm}
            data-testid="meet-invite-confirm"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor:
                selected.size > 0 ? 'primary.500' : 'greyscale.300',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
            })}
          >
            {t('call.invite.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = css({
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(0, 0, 0, 0.4)',
  padding: '1rem',
})
const modal = css({
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  maxWidth: '440px',
  maxHeight: '72vh',
  backgroundColor: 'greyscale.000',
  borderRadius: '0.75rem',
  overflow: 'hidden',
  boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
})
const modalHead = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const modalFoot = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const closeBtn = css({
  border: 'none',
  background: 'transparent',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
})
const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

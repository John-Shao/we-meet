import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
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
    <Modal
      onClose={onClose}
      ariaLabel={t('call.invite.title')}
      maxWidth="440px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
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
          <ModalCloseButton onClose={onClose} label={t('call.cancel')} />
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
            <StateHint loading>{t('group.loading')}</StateHint>
          ) : selectable.length === 0 ? (
            <StateHint>{t('manage.empty')}</StateHint>
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
                          // 未选中走会翻转的 greyscale.000(浅色仍是纯白),
                          // 裸 'white' 在深色下是一排刺眼白方块。
                          backgroundColor: checked
                            ? 'primary.500'
                            : 'greyscale.000',
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
          <Button
            variant="primary"
            size="action"
            isDisabled={selected.size === 0}
            onPress={confirm}
            data-testid="meet-invite-confirm"
          >
            {t('call.invite.confirm')}
          </Button>
        </div>
    </Modal>
  )
}

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
const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
})

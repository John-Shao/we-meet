import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { Client } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { MemberAvatar } from '@/features/contacts'

import { resolveImUsers } from '../api/resolveImUsers'
import type { MeetInviteTarget } from './meetInviteTracker'

/**
 * P4.1 群语音通话 — GROUP-MEMBER multi-picker (unlike MeetInvitePicker, which
 * is directory-scoped): roster from listMembers(cid), resolved to org display
 * profiles. Everyone is pre-selected (拍板: 默认全选 — small groups ring
 * everyone in one tap); self is excluded; members that don't resolve in the
 * caller's org are hidden (cross-org data boundary, same as the chat list).
 * Output is MeetInviteTarget[] — the resolved `.id` IS the we-meet userId the
 * tracker needs, so the P4 invite engine is reused untouched.
 */
export const GroupVoiceCallPicker = ({
  client,
  cid,
  title,
  onCall,
  onClose,
}: {
  client: Client
  cid: string
  /** P5.1: heading override — the video-meeting entry reuses this picker
   * (defaults to the group-voice-call title). */
  title?: string
  /** `allMembers` (P5): the full resolved roster regardless of check state —
   * the caller reports it as the room's suggested invitees. */
  onCall: (targets: MeetInviteTarget[], allMembers: MeetInviteTarget[]) => void
  onClose: () => void
}) => {
  const { t } = useTranslation('im')
  const { user } = useUser()

  const { data: roster = [], isFetching } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
  })
  const uids = roster.map((m) => m.uid)
  const { data: resolved = {} } = useQuery({
    queryKey: ['im', 'member-names', uids],
    queryFn: () => resolveImUsers(uids),
    enabled: uids.length > 0,
    staleTime: 60_000,
  })
  const candidates = uids
    .map((uid) => resolved[uid])
    .filter((e): e is NonNullable<typeof e> => !!e)
    .filter((e) => e.id !== user?.id)
    .map((e) => ({
      userId: e.id,
      label: e.full_name || e.short_name || e.id,
      avatarUrl: e.avatar_url || undefined,
    }))

  // null = "everything selected" until the user first toggles — this is how
  // 默认全选 survives the roster arriving asynchronously.
  const [deselected, setDeselected] = useState<Set<string>>(new Set())
  const isChecked = (id: string) => !deselected.has(id)
  const toggle = (id: string) =>
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const picked = candidates.filter((c) => isChecked(c.userId))
  const confirm = () => {
    if (picked.length === 0) return
    onCall(picked, candidates)
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
        aria-label={title ?? t('call.groupPicker.title')}
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
            {title ?? t('call.groupPicker.title')}
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
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {isFetching && candidates.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('group.loading')}
            </p>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {candidates.map((m) => {
                const checked = isChecked(m.userId)
                return (
                  <li key={m.userId}>
                    <button
                      type="button"
                      onClick={() => toggle(m.userId)}
                      aria-pressed={checked}
                      data-testid={`group-call-item-${m.userId}`}
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
                      <MemberAvatar name={m.label} src={m.avatarUrl} size="2rem" />
                      <span
                        className={css({
                          fontWeight: 'medium',
                          color: 'greyscale.900',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        })}
                      >
                        {m.label}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className={modalFoot}>
          <span className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
            {t('group.selected', { count: picked.length })}
          </span>
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={confirm}
            data-testid="group-call-confirm"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor:
                picked.length > 0 ? 'primary.500' : 'greyscale.300',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: picked.length > 0 ? 'pointer' : 'not-allowed',
            })}
          >
            {t('call.groupPicker.confirm')}
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

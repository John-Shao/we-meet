import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { Client } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { Button, SelectableListRow } from '@/primitives'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
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

  const picked = candidates.filter((c) => isChecked(c.userId))
  const confirm = () => {
    if (picked.length === 0) return
    onCall(picked, candidates)
    onClose()
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={title ?? t('call.groupPicker.title')}
      maxWidth="440px"
      maxHeight="72vh"
    >
      <ModalHeader
        title={title ?? t('call.groupPicker.title')}
        onClose={onClose}
        closeLabel={t('call.cancel')}
      />
      <ModalBody padding="none">
        {isFetching && candidates.length === 0 ? (
          <StateHint state="loading">{t('group.loading')}</StateHint>
        ) : (
          <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
            {candidates.map((m) => {
              const checked = isChecked(m.userId)
              return (
                <li key={m.userId}>
                  <SelectableListRow
                    onClick={() => toggle(m.userId)}
                    isSelected={checked}
                    data-testid={`group-call-item-${m.userId}`}
                    divider
                  >
                    <MemberAvatar
                      name={m.label}
                      src={m.avatarUrl}
                      size="2rem"
                    />
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
                  </SelectableListRow>
                </li>
              )
            })}
          </ul>
        )}
      </ModalBody>
      <ModalFooter alignment="space-between">
        <span
          className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}
        >
          {t('group.selected', { count: picked.length })}
        </span>
        <Button
          variant="primary"
          size="action"
          isDisabled={picked.length === 0}
          onPress={confirm}
          data-testid="group-call-confirm"
        >
          {t('call.groupPicker.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

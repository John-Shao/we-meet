import { useSnapshot } from 'valtio'
import { useTranslation } from 'react-i18next'
import { RiCloseLine, RiPhoneLine } from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { MemberAvatar } from '@/features/contacts'
import {
  cancelMeetInvite,
  meetInviteStore,
  sendMeetInvites,
  type MeetInvite,
} from '@/features/im/call/meetInviteTracker'
import { inviteStateText } from '@/features/rooms/components/CallStage'
import type { SuggestedParticipant } from '@/features/rooms/api/suggestedParticipants'

/**
 * P5 建议参会 tab (设计 §5.1) — the room's invited-but-absent people, each
 * with a per-person call lifecycle:
 *
 *   idle           → 〔呼叫〕 single-target ring (P4 engine, one is a fan-out of 1)
 *   inviting/ringing (mine)  → 呼叫中…〔✕〕 cancelable
 *   ringing (someone else's) → 响铃中 dimmed, read-only
 *   rejected/timeout/busy/…  → state text + 〔再次呼叫〕
 *
 * The caller has already subtracted present people (sub == LiveKit identity)
 * — a row disappearing IS "moved to the 全部 tab", Feishu-style.
 */
export const SuggestedParticipantsList = ({
  suggestions,
  roomSlug,
  inviterName,
  remoteRingingUserIds,
}: {
  suggestions: SuggestedParticipant[]
  roomSlug: string
  /** Rides in the invite frame's room_name (「{name}邀请你加入会议」). */
  inviterName: string
  /** People co-participants are already ringing (P5 broadcast userId). */
  remoteRingingUserIds: Set<string>
}) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'participants' })
  const { t: tIm } = useTranslation('im')
  const invites = useSnapshot(meetInviteStore).invites

  // Latest invite per user wins — re-calls push a fresh entry for the same
  // person and the row must track the newest attempt.
  const latestByUser = new Map<string, MeetInvite>()
  for (const invite of invites) latestByUser.set(invite.userId, invite as MeetInvite)

  const call = (person: SuggestedParticipant) =>
    sendMeetInvites(
      [
        {
          userId: person.id,
          label: person.full_name || person.short_name || person.email,
          avatarUrl: person.avatar_url || undefined,
        },
      ],
      {
        media: 'video',
        roomSlug,
        roomName: tIm('call.meetInviteRoomName', { name: inviterName }),
      }
    )

  if (suggestions.length === 0) {
    return (
      <p
        className={css({
          padding: '1rem 1.5rem',
          fontSize: '0.8125rem',
          color: 'greyscale.500',
        })}
      >
        {t('suggestedEmpty')}
      </p>
    )
  }

  return (
    <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
      {suggestions.map((person) => {
        const label = person.full_name || person.short_name || person.email
        const invite = latestByUser.get(person.id)
        const mineActive =
          invite &&
          (invite.state === 'inviting' || invite.state === 'ringing')
        const remoteRinging =
          !mineActive && remoteRingingUserIds.has(person.id)
        const mineEnded =
          invite &&
          !mineActive &&
          invite.state !== 'accepted' &&
          invite.state !== 'canceled'

        return (
          <li
            key={person.id}
            data-testid={`suggested-participant-${person.id}`}
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              padding: '0.5rem 1.5rem',
              opacity: remoteRinging ? 0.55 : 1,
            })}
          >
            <MemberAvatar
              name={label}
              src={person.avatar_url}
              size="2rem"
            />
            <span
              className={css({
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                flex: 1,
              })}
            >
              <span
                className={css({
                  fontSize: '0.875rem',
                  color: 'greyscale.900',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
              >
                {label}
              </span>
              <span
                className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
              >
                {[person.title, person.department?.name]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {mineActive ? (
              <span
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  fontSize: '0.75rem',
                  color: 'primary.500',
                })}
              >
                {invite.state === 'ringing'
                  ? tIm('call.invite.stateRinging')
                  : tIm('call.invite.stateInviting')}
                <button
                  type="button"
                  onClick={() => cancelMeetInvite(invite.callId)}
                  aria-label={t('cancelCall')}
                  data-testid={`suggested-cancel-${person.id}`}
                  className={css({
                    display: 'inline-flex',
                    border: 'none',
                    background: 'transparent',
                    color: 'greyscale.500',
                    cursor: 'pointer',
                    padding: '0.125rem',
                    _hover: { color: 'greyscale.800' },
                  })}
                >
                  <RiCloseLine size={16} />
                </button>
              </span>
            ) : remoteRinging ? (
              <span
                className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
              >
                {tIm('call.invite.stateRinging')}
              </span>
            ) : (
              <span
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                })}
              >
                {mineEnded && invite && (
                  <span
                    className={css({
                      fontSize: '0.75rem',
                      color: 'greyscale.500',
                    })}
                  >
                    {inviteStateText(tIm, invite)}
                  </span>
                )}
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => call(person)}
                  data-testid={`suggested-call-${person.id}`}
                >
                  <RiPhoneLine size={14} />
                  {mineEnded ? t('callAgain') : t('call')}
                </Button>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

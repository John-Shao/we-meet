import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { getRouteUrl } from '@/navigation/getRouteUrl'
import { useUser } from '@/features/auth'
import { MeetInvitePicker } from '@/features/im/call/MeetInvitePicker'
import {
  sendMeetInvites,
  type MeetInviteTarget,
} from '@/features/im/call/meetInviteTracker'
import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'
import { useTelephony } from '@/features/rooms/livekit/hooks/useTelephony'
import { formatPinCode } from '@/features/rooms/utils/telephony'
import { reportSuggestedParticipants } from '../api/suggestedParticipants'

/**
 * P5 统一邀请面板 — the ONE in-meeting invite surface (设计 §5.2): the P4
 * directory ringing picker on top, the share fallbacks (meeting link + code,
 * telephony PIN when enabled) pinned underneath. Confirm rings the picked
 * members into THIS room and fire-and-forget reports them as suggested
 * invitees, so no-answer people stay recallable from the suggested tab.
 *
 * The auto-popup on room creation intentionally stays on the old
 * InviteDialog (§3.3 渐进收敛 — the picker needs the IM client, which may
 * not be up yet at that moment).
 */
export const UnifiedInvitePanel = ({
  roomSlug,
  excludeUserIds,
  media = 'video',
  onClose,
}: {
  roomSlug: string
  /** Members already in the room (resolve-subs ids) — hidden from the picker. */
  excludeUserIds?: Set<string>
  /** Ring media — 'audio' from the voice stage, 'video' everywhere else. */
  media?: 'audio' | 'video'
  onClose: () => void
}) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'participants' })
  const { t: tIm } = useTranslation('im')
  const { t: tShare } = useTranslation('rooms', { keyPrefix: 'shareDialog' })
  const { user } = useUser()
  const roomData = useRoomData()
  const telephony = useTelephony()
  const roomUrl = getRouteUrl('room', roomSlug)
  const [copied, setCopied] = useState(false)

  const showPin = useMemo(
    () => telephony?.enabled && roomData?.pin_code,
    [telephony?.enabled, roomData?.pin_code]
  )

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable — the visible URL is still selectable.
    }
  }

  const onInvite = (targets: MeetInviteTarget[]) => {
    sendMeetInvites(targets, {
      media,
      roomSlug,
      roomName: tIm('call.meetInviteRoomName', {
        name: user?.full_name ?? '',
      }),
    })
    reportSuggestedParticipants(
      roomSlug,
      targets.map((target) => target.userId),
      'manual'
    )
  }

  return (
    <MeetInvitePicker
      onInvite={onInvite}
      onClose={onClose}
      excludeUserIds={excludeUserIds}
      footer={
        <div
          className={css({
            borderTop: '1px solid token(colors.greyscale.200)',
            paddingX: '1rem',
            paddingY: '0.625rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.375rem',
            backgroundColor: 'greyscale.050',
          })}
        >
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem',
            })}
          >
            <span
              className={css({
                fontSize: '0.8125rem',
                color: 'greyscale.700',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {t('meetingCode')}
              <b className={css({ marginLeft: '0.375rem', letterSpacing: '0.05em' })}>
                {roomSlug}
              </b>
            </span>
            <button
              type="button"
              onClick={copyLink}
              data-testid="unified-invite-copy-link"
              className={css({
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                border: 'none',
                borderRadius: '0.375rem',
                paddingX: '0.5rem',
                paddingY: '0.25rem',
                fontSize: '0.8125rem',
                cursor: 'pointer',
                color: copied ? 'success.600' : 'primary.500',
                backgroundColor: 'transparent',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              {copied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
              {copied ? tShare('copied') : tShare('copyUrl')}
            </button>
          </div>
          {showPin && (
            <span className={css({ fontSize: '0.75rem', color: 'greyscale.600' })}>
              {tShare('phone.call')} ({telephony?.country}){' '}
              {telephony?.internationalPhoneNumber} ·{' '}
              {tShare('phone.pinCode')} {formatPinCode(roomData?.pin_code)}
            </span>
          )}
        </div>
      }
    />
  )
}

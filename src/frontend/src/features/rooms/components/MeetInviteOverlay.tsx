import { useSnapshot } from 'valtio'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { meetInviteStore } from '@/features/im/call/meetInviteTracker'

import { inviteStateText, type RemoteInviteChip } from './CallStage'

/**
 * P4-M3 会议 UI 内的邀请状态悬浮层。完整会议界面(VideoConference)没有
 * 语音宫格那样的占位瓦片,拉人后本端毫无反馈——这里以顶部居中悬浮 chips
 * 补上:响铃中(本端 + 房内他人广播的快照)与本端终态(已拒绝/无应答/忙线,
 * accepted/canceled 不展示——前者已在画面里,后者无意义)。只读轻量,重邀
 * 走参会者面板「邀请成员」。
 */
export const MeetInviteOverlay = ({
  remoteInvites = [],
}: {
  remoteInvites?: RemoteInviteChip[]
}) => {
  const { t } = useTranslation('im')
  const invites = useSnapshot(meetInviteStore).invites
  const active = invites.filter(
    (i) => i.state === 'inviting' || i.state === 'ringing'
  )
  const failed = invites.filter((i) =>
    ['rejected', 'busy', 'unreachable', 'timeout', 'failed'].includes(i.state)
  )
  if (active.length + remoteInvites.length + failed.length === 0) return null

  return (
    <div className={overlay} data-testid="meet-invite-overlay">
      {active.map((i) => (
        <Chip
          key={i.callId}
          label={i.label}
          avatarUrl={i.avatarUrl}
          text={t(
            i.state === 'ringing'
              ? 'call.invite.stateRinging'
              : 'call.invite.stateInviting'
          )}
          live
        />
      ))}
      {remoteInvites.map((c, idx) => (
        <Chip
          key={`remote:${c.label}:${idx}`}
          label={c.label}
          avatarUrl={c.avatarUrl}
          text={t(
            c.state === 'ringing'
              ? 'call.invite.stateRinging'
              : 'call.invite.stateInviting'
          )}
          live
        />
      ))}
      {failed.map((i) => (
        <Chip
          key={i.callId}
          label={i.label}
          avatarUrl={i.avatarUrl}
          text={inviteStateText(t, i)}
        />
      ))}
    </div>
  )
}

const Chip = ({
  label,
  avatarUrl,
  text,
  live,
}: {
  label: string
  avatarUrl?: string
  text: string
  live?: boolean
}) => (
  <div className={cx(chip, live ? chipLive : undefined)}>
    {avatarUrl ? (
      <img src={avatarUrl} alt="" className={chipAvatar} />
    ) : (
      <span className={chipAvatarFallback}>{label.slice(0, 1)}</span>
    )}
    <span className={chipLabel}>{label}</span>
    <span className={live ? chipStateLive : chipState}>{text}</span>
  </div>
)

const overlay = css({
  position: 'absolute',
  top: '0.75rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 30,
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: '0.375rem',
  maxWidth: '80%',
  pointerEvents: 'none',
})

const chip = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.25rem 0.625rem 0.25rem 0.25rem',
  borderRadius: '999px',
  backgroundColor: 'rgba(0,0,0,0.65)',
  color: 'white',
  fontSize: '0.75rem',
  lineHeight: 1,
})

const chipLive = css({
  boxShadow: '0 0 0 1px rgba(59,130,246,0.9)',
})

const chipAvatar = css({
  width: '1.375rem',
  height: '1.375rem',
  borderRadius: '50%',
  objectFit: 'cover',
})

const chipAvatarFallback = css({
  width: '1.375rem',
  height: '1.375rem',
  borderRadius: '50%',
  backgroundColor: 'rgba(255,255,255,0.25)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.6875rem',
})

const chipLabel = css({
  maxWidth: '7rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const chipState = css({ color: 'rgba(255,255,255,0.65)' })

const chipStateLive = css({
  color: 'rgba(147,197,253,1)',
  animation: 'blink 1.6s ease-in-out infinite',
})

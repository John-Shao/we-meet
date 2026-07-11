import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Track } from 'livekit-client'
import {
  RoomAudioRenderer,
  useRoomContext,
  useTrackToggle,
} from '@livekit/components-react'
import { css } from '@/styled-system/css'
import { RiMicFill, RiMicOffFill, RiPhoneFill } from '@remixicon/react'
import { Avatar } from '@/features/im/components/Avatar'
import { resolveImUsers } from '@/features/im/api/resolveImUsers'
import { navigateTo } from '@/navigation/navigateTo'

/**
 * Minimal 1:1 voice-call stage (Feishu/WeCom style) — replaces the full
 * `<VideoConference/>` when the room was entered from a voice call: centered
 * avatar + name + mm:ss duration, mic toggle and a red hangup. Audio playback
 * needs its own `<RoomAudioRenderer/>` since the prefab's one is gone.
 */
export const CallStage = ({
  peer,
}: {
  peer: { uid: string; name: string; avatar?: string }
}) => {
  const { t } = useTranslation('im')
  const room = useRoomContext()
  const { enabled: micEnabled, toggle: toggleMic } = useTrackToggle({
    source: Track.Source.Microphone,
  })

  // Resolve the peer's display name/avatar, same as CallOverlay: on the
  // callee side the router state only carries the uid (peerName falls back
  // to it), and a state-carried avatar URL is a presigned link that may
  // already be stale — re-resolving covers both.
  const { data: names } = useQuery({
    queryKey: ['im', 'resolve', peer.uid],
    queryFn: () => resolveImUsers([peer.uid]),
    staleTime: 300_000,
  })
  const resolved = names?.[peer.uid]
  const displayName = resolved?.full_name || resolved?.short_name || peer.name
  const avatarUrl = resolved?.avatar_url || peer.avatar

  // Anchored on mount: both sides land here at accept, so mount ≈ connected.
  const [startMs] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startMs) / 1000)),
      1000
    )
    return () => clearInterval(timer)
  }, [startMs])

  const handleHangup = () => {
    // Navigate first so Conference's onDisconnected (→ feedback page) never
    // fires — same trick as LeaveButton.handleEndRoom.
    navigateTo('im')
    room
      .disconnect(true)
      .catch((e) => console.error('hangup: disconnect failed:', e))
  }

  return (
    <div className={stageRoot} data-testid="call-stage">
      <RoomAudioRenderer />
      <div className={centerCol}>
        <Avatar name={displayName} src={avatarUrl} size="7rem" />
        <div className={nameText}>{displayName}</div>
        <div className={durationText}>{formatElapsed(elapsed)}</div>
      </div>
      <div className={bottomRow}>
        <RoundButton
          label={t(micEnabled ? 'call.stage.micOn' : 'call.stage.muted')}
          color={micEnabled ? '#6b7280' : '#9ca3af'}
          onClick={() => void toggleMic()}
        >
          {micEnabled ? (
            <RiMicFill size={26} color="white" />
          ) : (
            <RiMicOffFill size={26} color="white" />
          )}
        </RoundButton>
        <RoundButton
          label={t('call.stage.hangup')}
          color="#e5484d"
          onClick={handleHangup}
        >
          <RiPhoneFill
            size={26}
            color="white"
            style={{ transform: 'rotate(135deg)' }}
          />
        </RoundButton>
      </div>
    </div>
  )
}

const RoundButton = ({
  label,
  color,
  onClick,
  children,
}: {
  label: string
  color: string
  onClick: () => void
  children: React.ReactNode
}) => (
  <div className={roundButtonCol}>
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={roundButtonFace}
      style={{ backgroundColor: color }}
    >
      {children}
    </button>
    <span className={roundButtonLabel}>{label}</span>
  </div>
)

const formatElapsed = (sec: number): string => {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

const stageRoot = css({
  position: 'relative',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'primaryDark.50',
})

const centerCol = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
})

const nameText = css({
  fontSize: '1.5rem',
  fontWeight: 600,
  color: 'white',
})

const durationText = css({
  fontSize: '1rem',
  color: 'rgba(255,255,255,0.7)',
  fontVariantNumeric: 'tabular-nums',
})

const bottomRow = css({
  position: 'absolute',
  bottom: '3.5rem',
  display: 'flex',
  gap: '4rem',
})

const roundButtonCol = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.5rem',
})

const roundButtonFace = css({
  width: '4rem',
  height: '4rem',
  borderRadius: '1.25rem',
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
})

const roundButtonLabel = css({
  fontSize: '0.8125rem',
  color: 'rgba(255,255,255,0.7)',
})

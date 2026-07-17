import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Track } from 'livekit-client'
import {
  RoomAudioRenderer,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
  useTrackToggle,
  VideoTrack,
} from '@livekit/components-react'
import { css } from '@/styled-system/css'
import {
  RiCameraOffFill,
  RiMicFill,
  RiMicOffFill,
  RiPhoneFill,
  RiUserAddLine,
  RiVidiconFill,
} from '@remixicon/react'
import { Avatar } from '@/features/im/components/Avatar'
import { resolveImUsers } from '@/features/im/api/resolveImUsers'
import { MeetInvitePicker } from '@/features/im/call/MeetInvitePicker'
import {
  meetInviteStore,
  sendMeetInvites,
  type MeetInvite,
} from '@/features/im/call/meetInviteTracker'
import { useSnapshot } from 'valtio'
import { navigateTo } from '@/navigation/navigateTo'

/**
 * Minimal call stage (Feishu/WeChat style) — replaces the full
 * `<VideoConference/>` when the room was entered from a call.
 *
 * 1:1 voice: centered avatar + name + mm:ss duration. 1:1 video: full-screen
 * remote camera + mirrored self-view. P4 escalation keeps VOICE on this stage
 * as a multi-party avatar grid (WeChat group-voice style) — video escalation
 * switches to the full meeting UI at the Conference level instead.
 *
 * Audio playback needs its own `<RoomAudioRenderer/>` since the prefab's one
 * is gone.
 */
export const CallStage = ({
  peer,
  video = false,
  upgraded = false,
  roomSlug,
  selfName,
}: {
  /** 1:1 peer identity; absent when an invitee lands straight in a meet. */
  peer?: { uid: string; name: string; avatar?: string }
  video?: boolean
  /** P4: multi-party form — grid layout, no auto-hangup, leave ≠ end. */
  upgraded?: boolean
  /** Current room slug — rides in escalation invites (no new room). */
  roomSlug: string
  /** Inviter display name for the invite's room_name. */
  selfName: string
}) => {
  const { t } = useTranslation('im')
  const room = useRoomContext()
  const { enabled: micEnabled, toggle: toggleMic } = useTrackToggle({
    source: Track.Source.Microphone,
  })
  const { enabled: camEnabled, toggle: toggleCam } = useTrackToggle({
    source: Track.Source.Camera,
  })
  const [showInvitePicker, setShowInvitePicker] = useState(false)
  const invites = useSnapshot(meetInviteStore).invites
  // Camera tracks for the two 1:1 video surfaces; unsubscribed/muted tracks
  // are absent, so these double as the "is their/our camera on" signal.
  const cameraTracks = useTracks([Track.Source.Camera])
  const remoteCam =
    video && !upgraded
      ? cameraTracks.find((ref) => !ref.participant.isLocal)
      : undefined
  const localCam =
    video && !upgraded
      ? cameraTracks.find((ref) => ref.participant.isLocal)
      : undefined

  // Resolve the peer's display name/avatar, same as CallOverlay: on the
  // callee side the router state only carries the uid (peerName falls back
  // to it), and a state-carried avatar URL is a presigned link that may
  // already be stale — re-resolving covers both.
  const { data: names } = useQuery({
    queryKey: ['im', 'resolve', peer?.uid],
    queryFn: () => resolveImUsers([peer!.uid]),
    enabled: !!peer,
    staleTime: 300_000,
  })
  const resolved = peer ? names?.[peer.uid] : undefined
  const displayName = resolved?.full_name || resolved?.short_name || peer?.name
  const avatarUrl = resolved?.avatar_url || peer?.avatar

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

  // 1:1 semantics: the peer leaving ends the call on this side too (a meeting
  // outlives any participant; a call doesn't). Armed only once the peer has
  // actually been seen, and debounced so the participant-list blip of a
  // LiveKit reconnect doesn't fake a hangup — any list change clears the
  // pending leave. P4: upgrading DISARMS this for good — in the multi-party
  // form people come and go and only a manual hangup leaves.
  const peerSeenRef = useRef(false)
  const remoteParticipants = useRemoteParticipants()
  const { localParticipant } = useLocalParticipant()
  useEffect(() => {
    if (upgraded) return
    if (remoteParticipants.length > 0) {
      peerSeenRef.current = true
      return
    }
    if (!peerSeenRef.current) return
    const timer = setTimeout(handleHangup, 1_500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteParticipants, upgraded])

  const handleInvite = (targets: Parameters<typeof sendMeetInvites>[0]) => {
    sendMeetInvites(targets, {
      media: video ? 'video' : 'audio',
      roomSlug,
      roomName: t('call.meetInviteRoomName', { name: selfName }),
    })
  }

  // Grid model: everyone in the room + still-pending invitees (dimmed chips).
  // LiveKit participant.name is the token's display name; photos aren't
  // carried by LiveKit, so grid tiles use letter avatars (设计 §4.4 兜底).
  const pendingInvites = invites.filter(
    (i) => i.state === 'inviting' || i.state === 'ringing'
  )
  const failedInvites = invites.filter(
    (i) =>
      i.state === 'rejected' ||
      i.state === 'busy' ||
      i.state === 'unreachable' ||
      i.state === 'timeout' ||
      i.state === 'failed'
  )

  return (
    <div className={stageRoot} data-testid="call-stage">
      <RoomAudioRenderer />
      {upgraded ? (
        <div className={centerCol}>
          <div className={gridWrap} data-testid="call-grid">
            <GridTile
              name={localParticipant?.name || selfName || t('call.stage.me')}
              suffix={t('call.stage.me')}
            />
            {remoteParticipants.map((p) => (
              <GridTile
                key={p.identity}
                name={p.name || p.identity}
                speaking={p.isSpeaking}
              />
            ))}
            {pendingInvites.map((i) => (
              <GridTile
                key={i.callId}
                name={i.label}
                dimmed
                stateLabel={t(
                  i.state === 'ringing'
                    ? 'call.invite.stateRinging'
                    : 'call.invite.stateInviting'
                )}
              />
            ))}
          </div>
          {failedInvites.length > 0 && (
            <div className={failedLine}>
              {failedInvites
                .map((i) => `${i.label}: ${inviteStateText(t, i)}`)
                .join('  ·  ')}
            </div>
          )}
          <div className={durationText}>{formatElapsed(elapsed)}</div>
          {remoteParticipants.length === 0 && pendingInvites.length === 0 && (
            <div className={leftAloneText}>{t('call.stage.leftAlone')}</div>
          )}
        </div>
      ) : remoteCam ? (
        <>
          <VideoTrack trackRef={remoteCam} className={remoteVideoCss} />
          <div className={durationPill}>{formatElapsed(elapsed)}</div>
        </>
      ) : (
        <div className={centerCol}>
          <Avatar name={displayName ?? ''} src={avatarUrl} size="7rem" />
          <div className={nameText}>{displayName}</div>
          <div className={durationText}>{formatElapsed(elapsed)}</div>
        </div>
      )}
      {localCam && (
        <div className={selfView}>
          <VideoTrack trackRef={localCam} className={selfVideoCss} />
        </div>
      )}
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
        {video && !upgraded && (
          <RoundButton
            label={t(
              camEnabled ? 'call.stage.cameraOn' : 'call.stage.cameraOff'
            )}
            color={camEnabled ? '#6b7280' : '#9ca3af'}
            onClick={() => void toggleCam()}
          >
            {camEnabled ? (
              <RiVidiconFill size={26} color="white" />
            ) : (
              <RiCameraOffFill size={26} color="white" />
            )}
          </RoundButton>
        )}
        <RoundButton
          label={t('call.stage.addMember')}
          color="#6b7280"
          onClick={() => setShowInvitePicker(true)}
        >
          <RiUserAddLine size={26} color="white" />
        </RoundButton>
      </div>
      {showInvitePicker && (
        <MeetInvitePicker
          onInvite={handleInvite}
          onClose={() => setShowInvitePicker(false)}
        />
      )}
    </div>
  )
}

/** One avatar cell of the voice grid (≤9 shown 3×3; beyond that a "+N"). */
const GridTile = ({
  name,
  suffix,
  dimmed = false,
  speaking = false,
  stateLabel,
}: {
  name: string
  suffix?: string
  dimmed?: boolean
  speaking?: boolean
  stateLabel?: string
}) => (
  <div className={gridTile} style={dimmed ? { opacity: 0.45 } : undefined}>
    <div
      className={css({ borderRadius: '50%' })}
      style={
        speaking ? { boxShadow: '0 0 0 3px #30a46c', borderRadius: '50%' } : undefined
      }
    >
      <Avatar name={name} size="4.5rem" />
    </div>
    <span className={gridTileName}>
      {name}
      {suffix ? `(${suffix})` : ''}
    </span>
    {stateLabel && <span className={gridTileState}>{stateLabel}</span>}
  </div>
)

const inviteStateText = (
  t: (k: string) => string,
  invite: Pick<MeetInvite, 'state'>
): string => {
  switch (invite.state) {
    case 'rejected':
      return t('call.invite.stateRejected')
    case 'busy':
      return t('call.invite.stateBusy')
    case 'unreachable':
      return t('call.invite.stateUnreachable')
    case 'timeout':
      return t('call.invite.stateTimeout')
    default:
      return t('call.invite.stateFailed')
  }
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

const gridWrap = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(6rem, 8rem))',
  gap: '1.25rem 1rem',
  justifyContent: 'center',
  maxHeight: '55vh',
  overflowY: 'auto',
})

const gridTile = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.375rem',
})

const gridTileName = css({
  maxWidth: '7.5rem',
  fontSize: '0.875rem',
  color: 'white',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const gridTileState = css({
  fontSize: '0.75rem',
  color: 'rgba(255,255,255,0.6)',
})

const failedLine = css({
  maxWidth: '80%',
  fontSize: '0.8125rem',
  color: 'rgba(255,255,255,0.55)',
  textAlign: 'center',
})

const leftAloneText = css({
  fontSize: '0.9375rem',
  color: 'rgba(255,255,255,0.7)',
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
  zIndex: 1,
})

const remoteVideoCss = css({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
})

const durationPill = css({
  position: 'absolute',
  top: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '0.25rem 0.75rem',
  borderRadius: '0.75rem',
  backgroundColor: 'rgba(0,0,0,0.35)',
  color: 'white',
  fontSize: '0.875rem',
  fontVariantNumeric: 'tabular-nums',
  zIndex: 1,
})

const selfView = css({
  position: 'absolute',
  top: '1rem',
  right: '1rem',
  width: '8.5rem',
  height: '12rem',
  borderRadius: '0.75rem',
  overflow: 'hidden',
  backgroundColor: 'rgba(0,0,0,0.4)',
  zIndex: 1,
})

const selfVideoCss = css({
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  // Mirror the self-view like every calling app; remote stays un-mirrored.
  transform: 'scaleX(-1)',
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

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
import { resolveRoomUsers } from '@/features/im/api/resolveRoomUsers'
import { useUser } from '@/features/auth'
import { MeetInvitePicker } from '@/features/im/call/MeetInvitePicker'
import {
  meetInviteStore,
  sendMeetInvites,
  type MeetInvite,
} from '@/features/im/call/meetInviteTracker'
import { useSnapshot } from 'valtio'
import { navigateTo } from '@/navigation/navigateTo'

/** One co-participant-broadcast ringing invite (M2 data message). */
export interface RemoteInviteChip {
  label: string
  state: 'inviting' | 'ringing'
  /** Short-lived presigned URL from the inviter's picker — shared so every
   * side of the call renders the same chip avatar. */
  avatarUrl?: string
}

/**
 * Minimal call stage (Feishu/WeChat style) — replaces the full
 * `<VideoConference/>` when the room was entered from a call.
 *
 * VOICE keeps CALL semantics throughout (2026-07-17 现状模型拍板): the form
 * follows the live roster — ≥3 people render the WeChat-group-voice avatar
 * grid, back to 2 falls back to the 1:1 layout, and alone auto-ends like a
 * 1:1 call (held open only while an escalation invite is still ringing).
 * VIDEO escalation instead latches into the full meeting UI at the
 * Conference level (meeting semantics — no fallback, no auto-end).
 *
 * Audio playback needs its own `<RoomAudioRenderer/>` since the prefab's one
 * is gone.
 */
export const CallStage = ({
  peer,
  video = false,
  roomSlug,
  selfName,
  remoteInvites = [],
}: {
  /** 1:1 peer identity; absent when an invitee lands straight in a meet. */
  peer?: { uid: string; name: string; avatar?: string }
  video?: boolean
  /** Current room slug — rides in escalation invites (no new room). */
  roomSlug: string
  /** Inviter display name for the invite's room_name. */
  selfName: string
  /** M2: co-participants' ringing invites (data-message broadcast) — shown
   * as dimmed chips so the whole call sees who is being pulled in. */
  remoteInvites?: RemoteInviteChip[]
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
  const remoteParticipants = useRemoteParticipants()
  const { localParticipant } = useLocalParticipant()
  // Voice form follows the roster: grid at ≥2 remotes, or while invitees are
  // still ringing (self + dimmed chips); otherwise the 1:1 layout.
  const activeInvites = invites.filter(
    (i) => i.state === 'inviting' || i.state === 'ringing'
  )
  const gridMode =
    !video &&
    (remoteParticipants.length >= 2 ||
      activeInvites.length > 0 ||
      remoteInvites.length > 0)
  // Camera tracks for the two 1:1 video surfaces; unsubscribed/muted tracks
  // are absent, so these double as the "is their/our camera on" signal.
  const cameraTracks = useTracks([Track.Source.Camera])
  const remoteCam = video
    ? cameraTracks.find((ref) => !ref.participant.isLocal)
    : undefined
  const localCam = video
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

  // Call semantics: everyone else leaving ends the call on this side too —
  // 1:1 AND multi-party voice alike (现状1/问题5 拍板: a call is a call, only
  // meetings outlive their participants). Armed only once a peer has actually
  // been seen, debounced against LiveKit-reconnect roster blips, and HELD
  // while an escalation invite is still ringing (auto-ending would cancel
  // the invitee mid-ring).
  const peerSeenRef = useRef(false)
  useEffect(() => {
    if (activeInvites.length > 0) return
    if (remoteParticipants.length > 0) {
      peerSeenRef.current = true
      return
    }
    if (!peerSeenRef.current) return
    const timer = setTimeout(handleHangup, 1_500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteParticipants, activeInvites.length])

  const handleInvite = (targets: Parameters<typeof sendMeetInvites>[0]) => {
    sendMeetInvites(targets, {
      media: video ? 'video' : 'audio',
      roomSlug,
      roomName: t('call.meetInviteRoomName', { name: selfName }),
    })
  }

  // Names/avatars are resolved from the DIRECTORY by participant identity
  // (= OIDC sub) — the LiveKit token name is a self-chosen join-preview name
  // (stale "John" / synthetic emails, 实测问题2) and carries no photo. Audio
  // resolves the whole roster (grid tiles AND the 1:1-fallback solo display,
  // whose remaining peer may not be the original callPeer).
  const { user: selfUser } = useUser()
  const identities = !video
    ? [
        ...(localParticipant?.identity ? [localParticipant.identity] : []),
        ...remoteParticipants.map((p) => p.identity),
      ].sort()
    : []
  const { data: roomUsers } = useQuery({
    queryKey: ['rooms', 'resolve-subs', identities],
    queryFn: () => resolveRoomUsers(identities),
    enabled: identities.length > 0,
    staleTime: 300_000,
  })
  const gridProfile = (identity: string, fallback: string) => {
    const entry = roomUsers?.[identity]
    return {
      name: entry?.full_name || entry?.short_name || fallback,
      src: entry?.avatar_url || undefined,
    }
  }
  // Voice 1:1 layout target: the person actually in the room (after a grid →
  // 1:1 fallback that may be someone OTHER than the original callPeer); the
  // router-state peer is the pre-connection fallback.
  const soloRemote = !video ? remoteParticipants[0] : undefined
  const soloProfile = soloRemote
    ? gridProfile(soloRemote.identity, soloRemote.name || soloRemote.identity)
    : undefined
  const soloName = soloProfile?.name || displayName
  const soloAvatar = soloProfile?.src || avatarUrl
  const pendingInvites = activeInvites
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
      {gridMode ? (
        <div className={centerCol}>
          <div className={gridWrap} data-testid="call-grid">
            {(() => {
              const self = gridProfile(
                localParticipant?.identity ?? '',
                selfUser?.full_name || selfName || t('call.stage.me')
              )
              return (
                <GridTile
                  name={self.name}
                  src={self.src || selfUser?.avatar_url || undefined}
                  suffix={t('call.stage.me')}
                />
              )
            })()}
            {remoteParticipants.map((p) => {
              const prof = gridProfile(p.identity, p.name || p.identity)
              return (
                <GridTile
                  key={p.identity}
                  name={prof.name}
                  src={prof.src}
                  speaking={p.isSpeaking}
                />
              )
            })}
            {pendingInvites.map((i) => (
              <GridTile
                key={i.callId}
                name={i.label}
                src={i.avatarUrl}
                dimmed
                stateLabel={t(
                  i.state === 'ringing'
                    ? 'call.invite.stateRinging'
                    : 'call.invite.stateInviting'
                )}
              />
            ))}
            {remoteInvites.map((c, idx) => (
              <GridTile
                key={`remote:${c.label}:${idx}`}
                name={c.label}
                src={c.avatarUrl}
                dimmed
                stateLabel={t(
                  c.state === 'ringing'
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
        </div>
      ) : remoteCam ? (
        <>
          <VideoTrack trackRef={remoteCam} className={remoteVideoCss} />
          <div className={durationPill}>{formatElapsed(elapsed)}</div>
        </>
      ) : (
        <div className={centerCol}>
          <Avatar
            name={(video ? displayName : soloName) ?? ''}
            src={video ? avatarUrl : soloAvatar}
            size="7rem"
          />
          <div className={nameText}>{video ? displayName : soloName}</div>
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
        {video && (
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

/** One avatar cell of the voice grid (3 columns, scrolls beyond 3 rows). */
const GridTile = ({
  name,
  src,
  suffix,
  dimmed = false,
  speaking = false,
  stateLabel,
}: {
  name: string
  src?: string
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
      <Avatar name={name} src={src} size="4.5rem" />
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

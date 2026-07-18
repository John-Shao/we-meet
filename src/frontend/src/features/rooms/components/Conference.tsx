import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  LiveKitRoom,
  usePersistentUserChoices,
} from '@livekit/components-react'
import {
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  RoomOptions,
  VideoPresets,
} from 'livekit-client'
import { useUser } from '@/features/auth'
import { keys } from '@/api/queryKeys'
import { queryClient } from '@/api/queryClient'
import { Screen } from '@/layout/Screen'
import { QueryAware } from '@/components/QueryAware'
import { ErrorScreen } from '@/components/ErrorScreen'
import { fetchRoom } from '../api/fetchRoom'
import { ApiRoom } from '../api/ApiRoom'
import { useCreateRoom } from '../api/createRoom'
import { InviteDialog } from './InviteDialog'
import { VideoConference } from '../livekit/prefabs/VideoConference'
import { CallStage } from './CallStage'
import { css } from '@/styled-system/css'
import { BackgroundProcessorFactory } from '../livekit/components/blur'
import { LocalUserChoices } from '@/stores/userChoices'
import { MediaDeviceErrorAlert } from './MediaDeviceErrorAlert'
import { usePostHog } from 'posthog-js/react'
import { useConfig } from '@/api/useConfig'
import { isFireFox } from '@/utils/livekit'
import { useIsMobile } from '@/utils/useIsMobile'
import { navigateTo } from '@/navigation/navigateTo'
import { connectionObserverStore } from '@/stores/connectionObserver'
import {
  cancelCallRoomLeave,
  scheduleCallRoomLeave,
  setInMeeting,
} from '@/features/im/call/callController'
import {
  cancelPendingMeetInvites,
  meetInviteStore,
  resetMeetInvites,
} from '@/features/im/call/meetInviteTracker'
import type { RemoteInviteChip } from './CallStage'
import { MeetInviteOverlay } from './MeetInviteOverlay'
import { patchRoom } from '../api/patchRoom'
import { useRemoteParticipants, useRoomContext } from '@livekit/components-react'
import { useSnapshot } from 'valtio'

export const Conference = ({
  roomId,
  initialRoomData,
  mode = 'join',
  audioOnly = false,
  callPeer,
  callMeet = false,
}: {
  roomId: string
  mode?: 'join' | 'create'
  initialRoomData?: ApiRoom
  /**
   * P1 一对一语音通话: enter with the camera off, overriding (but not
   * mutating) the user's persisted videoEnabled preference.
   */
  audioOnly?: boolean
  /**
   * Peer of a 1:1 call. Swaps the meeting UI for the minimal call stage —
   * voice (avatar + name + duration + mic/hangup) when [audioOnly], video
   * (full-screen remote + self-view + camera toggle) otherwise.
   */
  callPeer?: { uid: string; name: string; avatar?: string }
  /**
   * P4: this entry is an accepted escalation invite — land straight in the
   * multi-party form (voice grid / full meeting UI), never the 1:1 stage.
   */
  callMeet?: boolean
}) => {
  const posthog = usePostHog()
  const { data: apiConfig } = useConfig()

  const { userChoices: userConfig } = usePersistentUserChoices() as {
    userChoices: LocalUserChoices
  }

  useEffect(() => {
    posthog.capture('visit-room', { slug: roomId })
  }, [roomId, posthog])

  // P1 一对一通话: leaving the room ends the call — the controller persists
  // the "completed + duration" call-log if this device was the caller of a
  // connected 1:1 call. Plain meetings no-op inside.
  // P4: leaving also cancels any still-ringing escalation invites (拍板 #1 —
  // the invite dies with the inviter) and resets the upgrade latch.
  // Debounced: a transient unmount/remount (StrictMode, router blips) must
  // not fake a hangup — the remount cancels the scheduled flush (问题7).
  useEffect(() => {
    cancelCallRoomLeave()
    return () =>
      scheduleCallRoomLeave(() => {
        cancelPendingMeetInvites()
        resetMeetInvites()
      })
  }, [])

  // 标记「本机在房内」——供 callController 对会中新来电立刻回 Busy(而非静默等
  // 超时)。连接中的 1:1 通话此时 callStore 已是 idle,只有这个标记看得见。
  useEffect(() => {
    setInMeeting(true)
    return () => setInMeeting(false)
  }, [])
  const fetchKey = [keys.room, roomId]

  const [isConnectionWarmedUp, setIsConnectionWarmedUp] = useState(false)

  const {
    mutateAsync: createRoom,
    status: createStatus,
    isError: isCreateError,
  } = useCreateRoom({
    onSuccess: (data) => {
      queryClient.setQueryData(fetchKey, data)
    },
  })

  const {
    status: fetchStatus,
    isError: isFetchError,
    data,
  } = useQuery({
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: fetchKey,
    staleTime: 6 * 60 * 60 * 1000, // By default, LiveKit access tokens expire 6 hours after generation
    initialData: initialRoomData,
    queryFn: () =>
      fetchRoom({
        roomId: roomId as string,
        username: userConfig.username,
      }).catch((error) => {
        if (error.statusCode == '404') {
          // Auto-create fallback: user navigated to /:roomId for a slug that
          // doesn't exist yet (mainly the `ALLOW_UNREGISTERED_ROOMS` UX).
          // Use the URL fragment as the room name — backend still generates
          // its own 8-digit joinable slug regardless.
          createRoom({ name: roomId, username: userConfig.username })
        }
      }),
    retry: false,
  })

  const roomOptions = useMemo((): RoomOptions => {
    return {
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: {
        videoCodec: 'vp9',
      },
      videoCaptureDefaults: {
        deviceId: userConfig.videoDeviceId ?? undefined,
        resolution: userConfig.videoPublishResolution
          ? VideoPresets[userConfig.videoPublishResolution].resolution
          : undefined,
      },
      audioCaptureDefaults: {
        deviceId: userConfig.audioDeviceId ?? undefined,
      },
      audioOutput: {
        deviceId: userConfig.audioOutputDeviceId ?? undefined,
      },
    }
    // do not rely on the userConfig object directly as its reference may change on every render
  }, [
    userConfig.videoDeviceId,
    userConfig.videoPublishResolution,
    userConfig.audioDeviceId,
    userConfig.audioOutputDeviceId,
  ])

  const room = useMemo(() => new Room(roomOptions), [roomOptions])

  useEffect(() => {
    /**
     * Warm up connection to LiveKit server before joining room
     * This prefetch helps reduce initial connection latency by establishing
     * an early HTTP connection to the WebRTC signaling server
     *
     * It should cache DNS and TLS keys.
     */
    const prepareConnection = async () => {
      if (!apiConfig || isConnectionWarmedUp) return
      await room.prepareConnection(apiConfig.livekit.url)

      if (isFireFox() && apiConfig.livekit.enable_firefox_proxy_workaround) {
        try {
          const wssUrl =
            apiConfig.livekit.url
              .replace('https://', 'wss://')
              .replace(/\/$/, '') + '/rtc'

          /**
           * FIREFOX + PROXY WORKAROUND:
           *
           * Issue: On Firefox behind proxy configurations, WebSocket signaling fails to establish.
           * Symptom: Client receives HTTP 200 instead of expected 101 (Switching Protocols).
           * Root Cause: Certificate/security issue where the initial request is considered unsecure.
           *
           * Solution: Pre-establish a WebSocket connection to the signaling server, which fails.
           * This "primes" the connection, allowing subsequent WebSocket establishments to work correctly.
           *
           * Note: This issue is reproducible on LiveKit's demo app.
           * Reference: livekit-examples/meet/issues/466
           */
          const ws = new WebSocket(wssUrl)
          // 401 unauthorized response is expected
          ws.onerror = () => ws.readyState <= 1 && ws.close()
        } catch (e) {
          console.debug('Firefox WebSocket workaround failed.', e)
        }
      }

      setIsConnectionWarmedUp(true)
    }
    prepareConnection()
  }, [room, apiConfig, isConnectionWarmedUp])

  const [showInviteDialog, setShowInviteDialog] = useState(mode === 'create')
  const [mediaDeviceError, setMediaDeviceError] = useState<{
    error: MediaDeviceFailure | null
    kind: MediaDeviceKind | null
  }>({
    error: null,
    kind: null,
  })

  const isMobile = useIsMobile()

  /*
   * Ensure stable WebSocket connection URL. This is critical for legacy browser compatibility
   * (Firefox <124, Chrome <125, Edge <125) where HTTPS URLs in WebSocket() constructor
   *  may fail - the force_wss_protocol flag allows explicit WSS protocol conversion
   */
  const serverUrl = useMemo(() => {
    const livekit_url = apiConfig?.livekit.url
    if (!livekit_url) return
    if (apiConfig?.livekit.force_wss_protocol) {
      return livekit_url.replace('https://', 'wss://')
    }
    return livekit_url
  }, [apiConfig?.livekit])

  const { t } = useTranslation('rooms')
  if (isCreateError) {
    // this error screen should be replaced by a proper waiting room for anonymous user.
    return (
      <ErrorScreen
        title={t('error.createRoom.heading')}
        body={t('error.createRoom.body')}
      />
    )
  }

  // Some clients (like DINUM) operate in bandwidth-constrained environments
  // These settings help ensure successful connections in poor network conditions
  const connectOptions = {
    maxRetries: 5, // Default: 1. Only for unreachable server scenarios
    peerConnectionTimeout: 60000, // Default: 15s. Extended for slow TURN/TLS negotiation
  }

  return (
    <QueryAware status={isFetchError ? createStatus : fetchStatus}>
      <Screen header={false} footer={false}>
        <LiveKitRoom
          room={room}
          serverUrl={serverUrl}
          token={data?.livekit?.token}
          connect={isConnectionWarmedUp}
          audio={userConfig.audioEnabled}
          video={
            !audioOnly &&
            // A 1:1 video call starts with the camera ON regardless of the
            // persisted meeting preference (the peer accepted a *video*
            // call); plain meetings keep honouring the user's choice.
            (!!callPeer || userConfig.videoEnabled) && {
              processor: BackgroundProcessorFactory.fromProcessorConfig(
                userConfig.processorConfig
              ),
            }
          }
          connectOptions={connectOptions}
          className={css({
            backgroundColor: 'primaryDark.50 !important',
          })}
          onError={(e) => {
            posthog.captureException(e)
          }}
          onDisconnected={(e) => {
            const metadata = {
              room_id: roomId,
              pc_publisher: connectionObserverStore.publisher && {
                ...connectionObserverStore.publisher,
              },
              pc_subscriber: connectionObserverStore.subscriber && {
                ...connectionObserverStore.subscriber,
              },
              pc_publisher_changes_count:
                connectionObserverStore.publisherChangesCount,
              pc_subscriber_changes_count:
                connectionObserverStore.subscriberChangesCount,
            }

            connectionObserverStore.publisher = null
            connectionObserverStore.publisherChangesCount = 0
            connectionObserverStore.subscriber = null
            connectionObserverStore.subscriberChangesCount = 0

            switch (e) {
              case DisconnectReason.CLIENT_INITIATED:
                navigateTo(
                  'feedback',
                  {},
                  {
                    state: { ...metadata },
                  }
                )
                return
              case DisconnectReason.DUPLICATE_IDENTITY:
              case DisconnectReason.PARTICIPANT_REMOVED:
                navigateTo(
                  'feedback',
                  {},
                  {
                    state: {
                      reason: e,
                      ...metadata,
                    },
                  }
                )
                return
            }
          }}
          onMediaDeviceFailure={(e, kind) => {
            if (e == MediaDeviceFailure.DeviceInUse && !!kind) {
              setMediaDeviceError({ error: e, kind })
            }
          }}
        >
          <CallOrMeeting
            callPeer={callPeer}
            callMeet={callMeet}
            audioOnly={audioOnly}
            roomSlug={roomId}
            selfName={userConfig.username}
            // queryFn's 404-fallback catch types `data` as ApiRoom | void.
            roomData={data ?? undefined}
          />
          {showInviteDialog && !isMobile && (
            <InviteDialog
              isOpen={showInviteDialog}
              onOpenChange={setShowInviteDialog}
              onClose={() => setShowInviteDialog(false)}
            />
          )}
          <MediaDeviceErrorAlert
            {...mediaDeviceError}
            onClose={() => setMediaDeviceError({ error: null, kind: null })}
          />
        </LiveKitRoom>
      </Screen>
    </QueryAware>
  )
}

/** LiveKit data-channel topic for escalation-invite snapshots (M2). */
const MEET_INVITES_TOPIC = 'meet-invites'

/**
 * P4 fork (must live INSIDE LiveKitRoom for the participant hooks) —
 * 2026-07-17 现状模型拍板:
 *
 *   voice: CALL semantics throughout — always the minimal stage, whose form
 *          follows the live roster inside CallStage (grid ↔ 1:1 ↔ auto-end).
 *   video: escalation LATCHES into the full meeting UI (meeting semantics —
 *          no fallback at 2, no auto-end). Latch := entered as an escalation
 *          invitee ∥ this side sent an invite ∥ the room grew past 1:1 ∥ a
 *          co-participant broadcast ringing invites (M2 data message).
 *
 * M2 extras living here because this component survives every form switch:
 *  - broadcast the LOCAL active-invite snapshot over a data message so the
 *    OTHER side of the call renders the ringing chips too (voice) / switches
 *    to the meeting UI before the invitee even joins (video);
 *  - owner-side room rename once the call truly became multi-party, so the
 *    meeting history stops showing a 3-way call as「与X的通话」.
 */
const CallOrMeeting = ({
  callPeer,
  callMeet,
  audioOnly,
  roomSlug,
  selfName,
  roomData,
}: {
  callPeer?: { uid: string; name: string; avatar?: string }
  callMeet: boolean
  audioOnly: boolean
  roomSlug: string
  selfName: string
  roomData?: ApiRoom
}) => {
  const { t } = useTranslation('im')
  const room = useRoomContext()
  const { user } = useUser()
  const remoteParticipants = useRemoteParticipants()
  const remoteCount = remoteParticipants.length
  const snap = useSnapshot(meetInviteStore)

  // -- M2: broadcast the local active-invite snapshot on every change (the
  // empty snapshot clears the peers' chips). Reliable + tiny payload.
  // P4-M3 起不再限 call 入口:普通会议里经参会者面板拉人(P4.1)同样广播,
  // 全员的悬浮 chips 可见「谁在被邀请」(对齐语音宫格的 M2 语义)。
  const activeLocal = snap.invites.filter(
    (i) => i.state === 'inviting' || i.state === 'ringing'
  )
  const activeKey = activeLocal.map((i) => `${i.callId}:${i.state}`).join(',')
  const publishedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (publishedKeyRef.current === activeKey) return
    // Never skip the initial empty publish state — but do skip publishing
    // "empty" before anything was ever sent.
    if (publishedKeyRef.current === null && activeKey === '') return
    publishedKeyRef.current = activeKey
    const payload = JSON.stringify({
      invites: activeLocal.map((i) => ({
        label: i.label,
        state: i.state,
        avatarUrl: i.avatarUrl,
      })),
    })
    void room.localParticipant
      .publishData(new TextEncoder().encode(payload), {
        topic: MEET_INVITES_TOPIC,
        reliable: true,
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, room])

  // -- M2: receive co-participants' snapshots; a sender leaving the room
  // invalidates their snapshot (their invites were canceled on leave).
  const [remoteBySender, setRemoteBySender] = useState<
    Record<string, RemoteInviteChip[]>
  >({})
  useEffect(() => {
    const handler = (
      payload: Uint8Array,
      participant?: { identity: string },
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== MEET_INVITES_TOPIC || !participant) return
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
          invites?: RemoteInviteChip[]
        }
        const chips = (parsed.invites ?? [])
          .filter((c) => c && typeof c.label === 'string')
          .map((c) => ({
            label: c.label,
            state: c.state === 'ringing' ? ('ringing' as const) : ('inviting' as const),
            avatarUrl:
              typeof c.avatarUrl === 'string' && c.avatarUrl
                ? c.avatarUrl
                : undefined,
          }))
        setRemoteBySender((prev) => ({ ...prev, [participant.identity]: chips }))
      } catch {
        // Malformed broadcast — ignore.
      }
    }
    room.on(RoomEvent.DataReceived, handler)
    return () => {
      room.off(RoomEvent.DataReceived, handler)
    }
  }, [room])
  const presentIds = new Set(remoteParticipants.map((p) => p.identity))
  const remoteInvites = Object.entries(remoteBySender)
    .filter(([identity]) => presentIds.has(identity))
    .flatMap(([, chips]) => chips)

  // 拍板(2026-07-17 三次): the video latch flips only when the 3rd person
  // has ACTUALLY joined (remotes ≥ 2) — not at invite time. Both sides stay
  // on the 1:1 video stage while the invitee rings (App 方案 adopted).
  const latchedRef = useRef(callMeet)
  if (callMeet || remoteCount >= 2) latchedRef.current = true

  // -- M2: owner-side rename once the call truly became multi-party. Runs at
  // most once per session; ONLY for the 1:1-escalation entry (callPeer) —
  // group voice calls arrive with callMeet-only and their room is already
  // named「{群名}的语音通话」, which must not be overwritten (P4.1).
  const renamedRef = useRef(false)
  useEffect(() => {
    if (!callPeer || renamedRef.current) return
    if (remoteCount < 2 || !roomData?.is_administrable) return
    renamedRef.current = true
    // selfName is the join-preview preference name — often unset for
    // call-flow entrants (实测:「发起的多人通话」missing the owner). The
    // directory display name is the reliable fallback.
    const ownerName = user?.full_name || selfName
    if (!ownerName) return
    const name = t('call.meetInviteRoomName', { name: ownerName })
    if (roomData.name === name) return
    void patchRoom({ roomId: roomData.id, room: { name } }).catch(
      () => undefined
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteCount, callPeer, roomData, selfName, t])

  // P4-M3: 完整会议 UI 没有语音宫格的占位瓦片,拉人后没有任何反馈——顶部
  // 悬浮 chips 展示 响铃中(本端+他人广播)与本端终态(拒绝/无应答/忙线)。
  const meetingUi = (
    <div className={css({ position: 'relative', height: '100%' })}>
      <VideoConference />
      <MeetInviteOverlay remoteInvites={remoteInvites} />
    </div>
  )
  if (!callPeer && !callMeet) return meetingUi
  if (!audioOnly && latchedRef.current) return meetingUi
  return (
    <CallStage
      peer={callPeer}
      video={!audioOnly}
      roomSlug={roomSlug}
      selfName={selfName}
      remoteInvites={remoteInvites}
    />
  )
}

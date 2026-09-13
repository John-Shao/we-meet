import { useRoomContext } from '@livekit/components-react'
import { useQuery } from '@tanstack/react-query'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { useRoomId } from '@/features/rooms/livekit/hooks/useRoomId'
import { InterpretationContext } from '../interpretationContext'
import {
  decodeInterpretationEvent,
  interpretationDeadline,
  updateInterpretationRows,
  type InterpretationChannel,
  type InterpretationLanguage,
  type InterpretationRow,
  type InterpretationStatus,
  type InterpretationSubscription,
} from '../interpretationEvents'
import { useConnectedMeetingSid } from '../useConnectedMeetingSid'

const ROOT = 'meeting-interpretation/'
type Intent = {
  path: 'channels/' | 'subscription/'
  body: Record<string, string | number | boolean | null>
}
type Lease = {
  channel: InterpretationChannel
  subscription: InterpretationSubscription
  deadline: number
}
type AudioGrant = { identity: string; sid: string }

function readIntent(key: string): Intent | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw || raw.length > 4000) return
    const value = JSON.parse(raw)
    if (
      ['channels/', 'subscription/'].includes(value.path) &&
      typeof value.body?.key === 'string'
    )
      return value
  } catch {
    /* Storage failure keeps mutation controls conservative. */
  }
}

export function InterpretationProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext()
  const roomId = useRoomId()
  const sid = useConnectedMeetingSid()
  const { user, isLoggedIn } = useUser()
  const viewer = isLoggedIn ? user?.id : undefined
  const connectionSid = room.localParticipant.sid
  const scope = `${viewer ?? ''}:${roomId ?? ''}:${sid ?? ''}:${connectionSid}`
  return (
    <InterpretationSession
      key={scope}
      scope={scope}
      roomId={roomId}
      sid={sid}
      viewer={viewer}
      connectionSid={connectionSid}
    >
      {children}
    </InterpretationSession>
  )
}

function InterpretationSession({
  children,
  scope,
  roomId,
  sid,
  viewer,
  connectionSid,
}: {
  children: ReactNode
  scope: string
  roomId?: string
  sid?: string
  viewer?: string
  connectionSid: string
}) {
  const room = useRoomContext()
  const storageKey = `meeting-interpretation-intent:${scope}`
  const [intent, setIntent] = useState<Intent | undefined>(() =>
    readIntent(storageKey)
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [desired, setDesired] = useState<{
    id: string
    revision: number
    channel: string
  }>()
  const [muted, setMuted] = useState(true)
  const [rows, setRows] = useState<InterpretationRow[]>([])
  const [tracks, setTracks] = useState<Record<string, AudioGrant>>({})
  const lease = useRef<Lease>()
  const sender = useRef<AudioGrant>()
  const busy = useRef(false)
  const mounted = useRef(true)
  const currentDesired = useRef(desired)
  currentDesired.current = desired
  const requests = useRef(new Set<AbortController>())
  const status = useQuery({
    queryKey: ['meeting-interpretation', scope, roomId, sid],
    queryFn: async ({ signal }) => {
      const startedAt = performance.now()
      const value = await fetchApi<InterpretationStatus>(
        `${ROOT}channels/?${new URLSearchParams({
          room_id: roomId!,
          livekit_room_sid: sid!,
        })}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }
      )
      return { value, startedAt }
    },
    enabled: !!viewer && !!roomId && !!sid,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) =>
      [401, 403, 404].includes((query.state.error as ApiError)?.statusCode)
        ? false
        : 5000,
  })
  const value = status.data?.value
  const connection = value?.connections.find(
    (row) => row.participant_sid === connectionSid
  )
  const subscription = value?.subscriptions.find(
    (row) => row.participation_id === connection?.id
  )

  const silence = () => {
    lease.current = undefined
    sender.current = undefined
    currentDesired.current = undefined
    setDesired(undefined)
    setMuted(true)
    setTracks({})
    setRows([])
  }
  const authorized = () =>
    !!lease.current &&
    !!currentDesired.current &&
    performance.now() < lease.current.deadline &&
    room.localParticipant.sid === connectionSid &&
    !!viewer &&
    !!sid &&
    !status.isError

  useEffect(() => {
    mounted.current = true
    const inflight = requests.current
    return () => {
      mounted.current = false
      lease.current = undefined
      currentDesired.current = undefined
      inflight.forEach((controller) => controller.abort())
    }
  }, [])

  useEffect(() => {
    if (!desired) return
    const channel = value?.channels.find((row) => row.id === desired.channel)
    if (
      status.isError ||
      !connection ||
      !subscription ||
      !channel ||
      subscription.id !== desired.id ||
      subscription.revision !== desired.revision ||
      subscription.channel_id !== desired.channel ||
      !subscription.active ||
      !['starting', 'translating', 'stopping'].includes(channel.state)
    ) {
      silence()
      return
    }
    const deadline = interpretationDeadline(
      subscription,
      status.data!.startedAt
    )
    if (deadline <= performance.now()) {
      silence()
      setError(true)
    } else lease.current = { channel, subscription, deadline }
    // Each accepted status is a fresh authority snapshot, including revocations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data, status.isError, desired, connectionSid])

  useEffect(() => {
    if (!desired) return
    const timer = window.setInterval(() => {
      if (
        !lease.current ||
        performance.now() >= lease.current.deadline ||
        room.localParticipant.sid !== connectionSid
      ) {
        silence()
        setError(true)
      }
    }, 250)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desired, room, connectionSid])

  useEffect(() => {
    if (!desired || !roomId || !sid) return
    let active = true
    let timer: number
    const controller = new AbortController()
    const renew = async () => {
      if (!active || !lease.current || !currentDesired.current) return
      if (lease.current.channel.state === 'stopping') return
      const before = lease.current
      const startedAt = performance.now()
      try {
        const result = await fetchApi<InterpretationSubscription>(
          `${ROOT}renew/`,
          {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              room_id: roomId,
              livekit_room_sid: sid,
              participation_id: before.subscription.participation_id,
              channel_id: before.channel.id,
              revision: before.subscription.revision,
            }),
          }
        )
        if (!active || currentDesired.current !== desired) return
        if (
          result.id !== desired.id ||
          result.revision !== desired.revision ||
          result.channel_id !== desired.channel ||
          result.participation_id !== before.subscription.participation_id ||
          interpretationDeadline(result, startedAt) <= performance.now()
        )
          throw new Error('stale_lease')
        lease.current = {
          ...before,
          subscription: result,
          deadline: interpretationDeadline(result, startedAt),
        }
      } catch {
        if (active) {
          silence()
          setError(true)
        }
        return
      }
      if (active) timer = window.setTimeout(renew, 5000)
    }
    timer = window.setTimeout(renew, 5000)
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desired, roomId, sid])

  useEffect(() => {
    const receive = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== 'meeting.interpretation.events' || !authorized()) return
      const current = lease.current!
      const event = decodeInterpretationEvent(
        payload,
        participant,
        current.channel,
        current.subscription
      )
      if (
        !event ||
        (sender.current &&
          (sender.current.identity !== participant!.identity ||
            sender.current.sid !== participant!.sid))
      )
        return
      sender.current = {
        identity: participant!.identity,
        sid: participant!.sid,
      }
      const currentSender = sender.current
      if (event.type === 'ready')
        setTracks((previous) => {
          if (
            Object.keys(previous).length >= 32 &&
            !previous[event.audio_track_sid]
          )
            return previous
          return { ...previous, [event.audio_track_sid]: currentSender }
        })
      else setRows((previous) => updateInterpretationRows(previous, event))
    }
    const disconnected = (participant: RemoteParticipant) => {
      if (participant.sid === sender.current?.sid) {
        silence()
        setError(true)
      }
    }
    const reconnecting = () => {
      silence()
      setError(true)
    }
    const unpublished = (publication: { trackSid: string }) => {
      setTracks((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([key]) => key !== publication.trackSid
          )
        )
      )
    }
    room.on(RoomEvent.DataReceived, receive)
    room.on(RoomEvent.ParticipantDisconnected, disconnected)
    room.on(RoomEvent.Reconnecting, reconnecting)
    room.on(RoomEvent.Disconnected, reconnecting)
    room.on(RoomEvent.TrackUnpublished, unpublished)
    return () => {
      room.off(RoomEvent.DataReceived, receive)
      room.off(RoomEvent.ParticipantDisconnected, disconnected)
      room.off(RoomEvent.Reconnecting, reconnecting)
      room.off(RoomEvent.Disconnected, reconnecting)
      room.off(RoomEvent.TrackUnpublished, unpublished)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, status.isError, viewer, sid, connectionSid])

  const post = async (next: Intent) => {
    if (busy.current || !mounted.current || !viewer || !roomId || !sid) return
    busy.current = true
    setPending(true)
    setError(false)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    requests.current.add(controller)
    try {
      // Persist the exact intent before issuing a possibly ambiguous mutation.
      sessionStorage.setItem(storageKey, JSON.stringify(next))
      setIntent(next)
      await fetchApi(`${ROOT}${next.path}`, {
        method: 'POST',
        body: JSON.stringify(next.body),
        signal: controller.signal,
      })
      if (!mounted.current) return
      sessionStorage.removeItem(storageKey)
      setIntent(undefined)
      const refreshed = await status.refetch()
      if (!mounted.current || refreshed.isError) return
      if (next.body.operation === 'join') {
        const data = refreshed.data!
        const own = data.value.subscriptions.find(
          (row) => row.participation_id === next.body.participation_id
        )
        const channel = data.value.channels.find(
          (row) => row.id === next.body.channel_id
        )
        if (
          own?.active &&
          own.channel_id === channel?.id &&
          own.revision === Number(next.body.expected_revision) + 1 &&
          interpretationDeadline(own, data.startedAt) > performance.now()
        ) {
          const selected = {
            id: own.id,
            revision: own.revision,
            channel: own.channel_id,
          }
          lease.current = {
            channel: channel!,
            subscription: own,
            deadline: interpretationDeadline(own, data.startedAt),
          }
          currentDesired.current = selected
          setDesired(selected)
          setMuted(false)
        }
      }
    } catch (err) {
      if (!mounted.current) return
      if (
        err instanceof ApiError &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      ) {
        sessionStorage.removeItem(storageKey)
        setIntent(undefined)
      }
      silence()
      setError(true)
      void status.refetch()
    } finally {
      window.clearTimeout(timeout)
      requests.current.delete(controller)
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  const body = () => ({
    key: crypto.randomUUID(),
    room_id: roomId!,
    livekit_room_sid: sid!,
  })
  const control = async (
    target: InterpretationLanguage,
    operation: 'start' | 'stop',
    saveTranslations = false
  ) => {
    if (intent || busy.current || !value?.can_control) return
    const channel = value.channels.find((row) => row.target === target)
    if (operation === 'start' && (!value.available || status.isError)) return
    await post({
      path: 'channels/',
      body: {
        ...body(),
        target,
        operation,
        expected_channel_id: channel?.id ?? null,
        ...(operation === 'start'
          ? { save_translations: saveTranslations }
          : {}),
      },
    })
  }
  const choose = async (channel?: InterpretationChannel) => {
    if (intent || busy.current || !connection) return
    if (
      channel &&
      (!value?.available ||
        status.isError ||
        !['prepared', 'starting', 'translating'].includes(channel.state))
    )
      return
    const channelId = channel?.id ?? subscription?.channel_id
    silence()
    if (!channelId) return
    if (channel) {
      busy.current = true
      try {
        await room.startAudio()
      } catch {
        setError(true)
        return
      } finally {
        busy.current = false
      }
    }
    await post({
      path: 'subscription/',
      body: {
        ...body(),
        operation: channel ? 'join' : 'leave',
        participation_id: connection.id,
        channel_id: channelId,
        expected_revision: subscription?.revision ?? 0,
      },
    })
  }

  return (
    <InterpretationContext.Provider
      value={{
        visible:
          !!value &&
          ![401, 403, 404].includes((status.error as ApiError)?.statusCode) &&
          (value.available || value.channels.length > 0),
        available: value?.available ?? false,
        archiveAvailable: value?.archive_available ?? false,
        canControl: !!value?.can_control && !status.isError,
        canJoin: !!connection && !status.isError,
        channels: value?.channels ?? [],
        listening: desired?.channel,
        muted,
        ready: Object.keys(tracks).length > 0,
        pending,
        uncertain: !!intent,
        error: error || status.isError,
        rows,
        speakerName: (sourceSid) =>
          [...room.remoteParticipants.values()].find(
            (person) => person.sid === sourceSid
          )?.name,
        control,
        choose,
        resubmit: async () => {
          if (!intent || busy.current) return
          if (intent.body.operation === 'join') {
            busy.current = true
            try {
              await room.startAudio()
            } catch {
              setError(true)
              return
            } finally {
              busy.current = false
            }
          }
          await post(intent)
        },
        toggleSound: () => {
          if (!muted) setMuted(true)
          else
            void room
              .startAudio()
              .then(() => {
                if (mounted.current && authorized()) setMuted(false)
              })
              .catch(() => setError(true))
        },
        canPlay: (participant, trackSid) =>
          authorized() &&
          !muted &&
          participant.isAgent &&
          participant.identity === tracks[trackSid]?.identity &&
          participant.sid === tracks[trackSid]?.sid,
      }}
    >
      {children}
    </InterpretationContext.Provider>
  )
}

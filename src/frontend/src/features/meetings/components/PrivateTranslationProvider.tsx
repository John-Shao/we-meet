import { useRoomContext } from '@livekit/components-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RemoteAudioTrack,
  RoomEvent,
  type RemoteParticipant,
} from 'livekit-client'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { useRoomId } from '@/features/rooms/livekit/hooks/useRoomId'
import {
  PrivateTranslationContext,
  type TranslationOptions,
} from '../translationContext'
import {
  decodeTranslationEvent,
  isTranslationAgent,
  updateTranslationRows,
  type TranslationDirection,
  type TranslationRow,
  type TranslationRun,
} from '../translationEvents'
import { useConnectedMeetingSid } from '../useConnectedMeetingSid'
import { useSummaryIntent } from '../hooks/useSummaryIntent'

interface Status {
  available: boolean
  archive_available?: boolean
  current: TranslationRun | null
  sources: { id: string; participant_sid: string }[]
}
interface Intent extends Partial<TranslationOptions> {
  key: string
  room_id: string
  livekit_room_sid: string
  operation: 'start' | 'stop'
  expected_run_id: string | null
  source_participation_id?: string
}
const PATH = 'meeting-translations/control/'
type Payload = Omit<Intent, 'key'>
const identifier = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
const validPayload = (value: unknown): value is Payload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'room_id',
          'livekit_room_sid',
          'operation',
          'expected_run_id',
          'source_participation_id',
          'source',
          'target',
          'mode',
          'audio',
          'save_translations',
        ].includes(key)
    ) ||
    !identifier(row.room_id) ||
    !identifier(row.livekit_room_sid) ||
    !(row.expected_run_id === null || identifier(row.expected_run_id))
  )
    return false
  if (row.operation === 'stop')
    return identifier(row.expected_run_id) && Object.keys(row).length === 4
  return (
    row.operation === 'start' &&
    identifier(row.source_participation_id) &&
    ['zh', 'en'].includes(String(row.source)) &&
    ['zh', 'en'].includes(String(row.target)) &&
    row.source !== row.target &&
    ['simultaneous', 'push_to_talk'].includes(String(row.mode)) &&
    typeof row.audio === 'boolean' &&
    (row.save_translations === undefined ||
      typeof row.save_translations === 'boolean')
  )
}

export const PrivateTranslationProvider = ({
  children,
}: {
  children: ReactNode
}) => {
  const room = useRoomContext()
  const roomId = useRoomId()
  const sid = useConnectedMeetingSid()
  const { user, isLoggedIn } = useUser()
  return (
    <PrivateTranslationSession
      key={`${isLoggedIn ? user?.id : ''}:${roomId}:${sid}:${room.localParticipant.sid}`}
    >
      {children}
    </PrivateTranslationSession>
  )
}

const PrivateTranslationSession = ({ children }: { children: ReactNode }) => {
  const room = useRoomContext()
  const roomId = useRoomId()
  const sid = useConnectedMeetingSid()
  const { user, isLoggedIn } = useUser()
  const viewerId = isLoggedIn ? user?.id : undefined
  const client = useQueryClient()
  const queryKey = ['meeting-translations', viewerId, roomId, sid]
  const status = useQuery<Status, ApiError>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchApi(
        `${PATH}?${new URLSearchParams({
          room_id: roomId!,
          livekit_room_sid: sid!,
        })}`,
        { signal, cache: 'no-store' }
      ),
    enabled: !!viewerId && !!roomId && !!sid,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) =>
      [401, 403, 404].includes(query.state.error?.statusCode ?? 0)
        ? false
        : 5000,
  })
  const intents = useSummaryIntent(
    'private-translation',
    viewerId ?? '',
    `${roomId}:${sid}`,
    validPayload
  )
  const pendingIntent: Intent | undefined = intents.pending
    ? { ...intents.pending.payload, key: intents.pending.key }
    : undefined
  const [error, setError] = useState(false)
  const [ready, setReady] = useState(false)
  const [muted, setMuted] = useState(true)
  const [held, setHeld] = useState<TranslationDirection | null>(null)
  const [turnBusy, setTurnBusy] = useState(false)
  const [rows, setRows] = useState<TranslationRow[]>([])
  const [audioGrant, setAudioGrant] = useState<{
    viewer: string
    room: string | undefined
    sid: string | undefined
    run: string
    generation: number
    participantSid: string
    identity: string
    trackSid: string | null
  }>()
  const [now, setNow] = useState(() => performance.now())
  const [statusLease, setStatusLease] = useState({ updatedAt: 0, until: 0 })
  const soundEpoch = useRef(0)
  const invalidateSound = useCallback(() => {
    soundEpoch.current++
  }, [])
  const busy = useRef(false)
  const sequence = useRef(0)
  const sender = useRef<string>()
  const heldRef = useRef<TranslationDirection | null>(null)
  const turnBusyRef = useRef(false)
  const outbound = useRef(Promise.resolve())
  const current = status.data?.current
  const active =
    !!current && ['starting', 'translating', 'stopping'].includes(current.state)
  const source = status.data?.sources.find(
    (value) => value.participant_sid === room.localParticipant.sid
  )
  const ownConnection =
    current?.source_participant_sid === room.localParticipant.sid
  const statusFresh =
    status.dataUpdatedAt > 0 &&
    statusLease.updatedAt === status.dataUpdatedAt &&
    now < statusLease.until
  const canPlay = useCallback(
    (participant: RemoteParticipant, trackSid: string) =>
      !!audioGrant &&
      !!viewerId &&
      !!roomId &&
      !!sid &&
      current?.state === 'translating' &&
      current.configuration.audio &&
      ownConnection &&
      ready &&
      !muted &&
      !status.isError &&
      statusFresh &&
      !!status.data?.available &&
      audioGrant.viewer === viewerId &&
      audioGrant.room === roomId &&
      audioGrant.sid === sid &&
      audioGrant.run === current.id &&
      audioGrant.generation === current.generation &&
      participant.isAgent &&
      participant.identity === audioGrant.identity &&
      !!participant.sid &&
      participant.sid === audioGrant.participantSid &&
      !!audioGrant.trackSid &&
      audioGrant.trackSid === trackSid,
    [
      audioGrant,
      viewerId,
      roomId,
      sid,
      current,
      ownConnection,
      ready,
      muted,
      status.isError,
      statusFresh,
      status.data?.available,
    ]
  )
  const requests = useRef(new Set<AbortController>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const pending = requests.current
    return () => {
      mounted.current = false
      pending.forEach((controller) => controller.abort())
    }
  }, [])
  const mutation = useMutation({
    mutationFn: ({ intent, signal }: { intent: Intent; signal: AbortSignal }) =>
      fetchApi<{ current: TranslationRun }>(PATH, {
        method: 'POST',
        signal,
        meetingCommand: {
          key: intent.key,
          scope: {
            room_id: intent.room_id,
            livekit_room_sid: intent.livekit_room_sid,
          },
        },
        body: JSON.stringify(intent),
      }),
    retry: false,
    gcTime: 0,
  })

  const silence = () => {
    invalidateSound()
    setMuted(true)
    room.remoteParticipants.forEach((participant) => {
      if (participant.isAgent && isTranslationAgent(participant.identity)) {
        participant.audioTrackPublications.forEach((publication) => {
          if (publication.track instanceof RemoteAudioTrack)
            publication.track.setVolume(0)
        })
      }
    })
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const received = performance.now()
    setNow(received)
    setStatusLease({ updatedAt: status.dataUpdatedAt, until: received + 15000 })
  }, [status.dataUpdatedAt])

  useEffect(() => {
    setRows([])
    setAudioGrant(undefined)
    setReady(false)
    setHeld(null)
    setTurnBusy(false)
    heldRef.current = null
    turnBusyRef.current = false
    sender.current = undefined
    sequence.current = 0
  }, [current?.id, current?.generation, viewerId, roomId, sid])

  useEffect(() => {
    invalidateSound()
    setError(false)
    setMuted(true)
    return invalidateSound
  }, [viewerId, roomId, sid, invalidateSound])

  useEffect(() => {
    const volume = () =>
      room.remoteParticipants.forEach((participant) => {
        if (!participant.isAgent || !isTranslationAgent(participant.identity))
          return
        participant.audioTrackPublications.forEach((publication) => {
          if (publication.track instanceof RemoteAudioTrack)
            publication.track.setVolume(
              canPlay(participant, publication.trackSid) ? 1 : 0
            )
        })
      })
    volume()
    room.on(RoomEvent.TrackSubscribed, volume)
    return () => {
      room.off(RoomEvent.TrackSubscribed, volume)
      room.remoteParticipants.forEach((participant) => {
        if (participant.isAgent && isTranslationAgent(participant.identity))
          participant.audioTrackPublications.forEach((publication) => {
            if (publication.track instanceof RemoteAudioTrack)
              publication.track.setVolume(0)
          })
      })
    }
  }, [room, canPlay])

  useEffect(() => {
    if (!current || !ownConnection || !viewerId || status.isError) return
    const receive = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== 'meeting.translation.events') return
      const event = decodeTranslationEvent(payload, participant, current)
      if (
        !event ||
        (sender.current && sender.current !== participant!.identity)
      )
        return
      sender.current = participant!.identity
      if (event.type === 'ready') {
        if (event.sequence! < sequence.current) return
        sequence.current = event.sequence!
        setAudioGrant({
          viewer: viewerId,
          room: roomId,
          sid,
          run: current.id,
          generation: current.generation,
          participantSid: participant!.sid,
          identity: participant!.identity,
          trackSid: event.audio_track_sid ?? null,
        })
        setReady(true)
        heldRef.current =
          current.configuration.mode === 'push_to_talk'
            ? (event.direction ?? null)
            : null
        setHeld(heldRef.current)
        turnBusyRef.current = event.awaiting === true
        setTurnBusy(turnBusyRef.current)
      } else if (event.type === 'turn_completed') {
        turnBusyRef.current = false
        setTurnBusy(false)
      } else setRows((previous) => updateTranslationRows(previous, event))
    }
    const sync = () => {
      if (!['starting', 'translating'].includes(current.state)) return
      const destinations = [...room.remoteParticipants.values()]
        .filter(
          (p) =>
            p.isAgent && p.identity.startsWith(`translation-${current.id}-`)
        )
        .map((p) => p.identity)
      if (!destinations.length) return
      void room.localParticipant
        .publishData(
          new TextEncoder().encode(
            JSON.stringify({
              run_id: current.id,
              generation: current.generation,
              action: 'sync',
            })
          ),
          {
            reliable: true,
            topic: 'meeting.translation.control',
            destinationIdentities: destinations,
          }
        )
        .catch(() => setError(true))
    }
    room.on(RoomEvent.DataReceived, receive)
    sync()
    const timer = window.setInterval(sync, 3000)
    return () => {
      window.clearInterval(timer)
      room.off(RoomEvent.DataReceived, receive)
    }
  }, [room, roomId, sid, current, ownConnection, viewerId, status.isError])

  const change = async (options?: TranslationOptions) => {
    if (
      busy.current ||
      !mounted.current ||
      !roomId ||
      !sid ||
      !viewerId ||
      !intents.ready
    )
      return
    if (
      !pendingIntent &&
      ((status.isError && !active) ||
        (!active && (!status.data?.available || !source || !options)))
    )
      return
    busy.current = true
    setError(false)
    const payload: Payload = pendingIntent
      ? intents.pending!.payload
      : {
          room_id: roomId,
          livekit_room_sid: sid,
          operation: active ? 'stop' : 'start',
          expected_run_id: current?.id ?? null,
          ...(!active
            ? { ...options, source_participation_id: source!.id }
            : {}),
        }
    let retained: ReturnType<typeof intents.getOrCreate> | undefined
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    requests.current.add(controller)
    try {
      retained = intents.getOrCreate(payload)
      const intent: Intent = { ...retained.payload, key: retained.key }
      if (intent.operation === 'stop') silence()
      else if (!pendingIntent) {
        void room.startAudio().catch(() => setMuted(true))
        setMuted(false)
      }
      const result = await mutation.mutateAsync({
        intent,
        signal: controller.signal,
      })
      if (!mounted.current || controller.signal.aborted) return
      if (!intents.resolve(retained))
        throw new Error('translation_recovery_unavailable')
      client.setQueryData<Status>(queryKey, (old) =>
        old ? { ...old, current: result.current } : old
      )
      await status.refetch()
    } catch (err) {
      if (!mounted.current) return
      if (err instanceof ApiError && [400, 409, 422].includes(err.statusCode)) {
        if (retained) intents.resolve(retained)
      }
      setError(true)
      silence()
      await status.refetch()
    } finally {
      window.clearTimeout(timeout)
      requests.current.delete(controller)
      busy.current = false
    }
  }

  const press = (direction: TranslationDirection, begin: boolean) => {
    if (
      !current ||
      !sender.current ||
      !ready ||
      !statusFresh ||
      !ownConnection ||
      status.isError ||
      current.state !== 'translating' ||
      current.configuration.mode !== 'push_to_talk'
    )
      return
    if (begin && (heldRef.current || turnBusyRef.current)) return
    if (!begin && heldRef.current !== direction) return
    heldRef.current = begin ? direction : null
    setHeld(heldRef.current)
    if (!begin) {
      turnBusyRef.current = true
      setTurnBusy(true)
    }
    const payload = new TextEncoder().encode(
      JSON.stringify({
        run_id: current.id,
        generation: current.generation,
        sequence: ++sequence.current,
        action: begin ? 'begin' : 'end',
        direction,
      })
    )
    const destination = sender.current
    outbound.current = outbound.current
      .then(() =>
        room.localParticipant.publishData(payload, {
          reliable: true,
          topic: 'meeting.translation.control',
          destinationIdentities: [destination],
        })
      )
      .catch(() => {
        setError(true)
        setReady(false)
        silence()
      })
  }
  return (
    <PrivateTranslationContext.Provider
      value={{
        visible:
          !!status.data &&
          ![401, 403, 404].includes(status.error?.statusCode ?? 0) &&
          (status.data.available || !!current),
        available: status.data?.available ?? false,
        archiveAvailable: status.data?.archive_available ?? false,
        current,
        ownConnection,
        canStart: !!source && !status.isError && intents.ready,
        pending: mutation.isPending,
        uncertain: !!pendingIntent,
        error: error || status.isError || intents.failed,
        ready: ready && statusFresh,
        muted,
        held,
        turnBusy,
        rows,
        change,
        press,
        canPlay,
        toggleSound: () => {
          if (!muted) silence()
          else {
            const epoch = ++soundEpoch.current
            void room
              .startAudio()
              .then(() => {
                if (epoch === soundEpoch.current) setMuted(false)
              })
              .catch(() => {
                if (epoch === soundEpoch.current) setError(true)
              })
          }
        },
      }}
    >
      {children}
    </PrivateTranslationContext.Provider>
  )
}

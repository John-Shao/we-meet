import { useRoomContext } from '@livekit/components-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RemoteAudioTrack,
  RoomEvent,
  type RemoteParticipant,
} from 'livekit-client'
import { type ReactNode, useEffect, useRef, useState } from 'react'

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

interface Status {
  available: boolean
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

export const PrivateTranslationProvider = ({
  children,
}: {
  children: ReactNode
}) => {
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
        { signal }
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
  const [pendingIntent, setPendingIntent] = useState<Intent>()
  const [error, setError] = useState(false)
  const [ready, setReady] = useState(false)
  const [muted, setMuted] = useState(true)
  const [held, setHeld] = useState<TranslationDirection | null>(null)
  const [turnBusy, setTurnBusy] = useState(false)
  const [rows, setRows] = useState<TranslationRow[]>([])
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
  const mutation = useMutation({
    mutationFn: (intent: Intent) =>
      fetchApi<{ current: TranslationRun }>(PATH, {
        method: 'POST',
        body: JSON.stringify(intent),
      }),
    retry: false,
    gcTime: 0,
  })

  const silence = () => {
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
    setRows([])
    setReady(false)
    setHeld(null)
    setTurnBusy(false)
    heldRef.current = null
    turnBusyRef.current = false
    sender.current = undefined
    sequence.current = 0
  }, [current?.id, viewerId, roomId, sid])

  useEffect(() => {
    setPendingIntent(undefined)
    setError(false)
    setMuted(true)
  }, [viewerId, roomId, sid])

  useEffect(() => {
    const volume = () =>
      room.remoteParticipants.forEach((participant) => {
        if (!participant.isAgent || !isTranslationAgent(participant.identity))
          return
        const allowed =
          current?.state === 'translating' &&
          ownConnection &&
          ready &&
          !muted &&
          !status.isError &&
          participant.identity === sender.current
        participant.audioTrackPublications.forEach((publication) => {
          if (publication.track instanceof RemoteAudioTrack)
            publication.track.setVolume(allowed ? 1 : 0)
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
  }, [
    room,
    current?.id,
    current?.state,
    ownConnection,
    ready,
    muted,
    status.isError,
  ])

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
  }, [room, current, ownConnection, viewerId, status.isError])

  const change = async (options?: TranslationOptions) => {
    if (busy.current || !roomId || !sid || !viewerId) return
    if (
      !pendingIntent &&
      ((status.isError && !active) ||
        (!active && (!status.data?.available || !source || !options)))
    )
      return
    busy.current = true
    setError(false)
    const intent: Intent = pendingIntent ?? {
      key: crypto.randomUUID(),
      room_id: roomId,
      livekit_room_sid: sid,
      operation: active ? 'stop' : 'start',
      expected_run_id: current?.id ?? null,
      ...(!active ? { ...options, source_participation_id: source!.id } : {}),
    }
    if (intent.operation === 'stop') silence()
    else {
      void room.startAudio().catch(() => setMuted(true))
      setMuted(false)
    }
    setPendingIntent(intent)
    try {
      const result = await mutation.mutateAsync(intent)
      setPendingIntent(undefined)
      client.setQueryData<Status>(queryKey, (old) =>
        old ? { ...old, current: result.current } : old
      )
      await status.refetch()
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      )
        setPendingIntent(undefined)
      setError(true)
      silence()
      await status.refetch()
    } finally {
      busy.current = false
    }
  }

  const press = (direction: TranslationDirection, begin: boolean) => {
    if (
      !current ||
      !sender.current ||
      !ready ||
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
        current,
        ownConnection,
        canStart: !!source && !status.isError,
        pending: mutation.isPending,
        uncertain: !!pendingIntent,
        error: error || status.isError,
        ready,
        muted,
        held,
        turnBusy,
        rows,
        change,
        press,
        toggleSound: () => {
          if (!muted) silence()
          else
            void room
              .startAudio()
              .then(() => setMuted(false))
              .catch(() => setError(true))
        },
      }}
    >
      {children}
    </PrivateTranslationContext.Provider>
  )
}

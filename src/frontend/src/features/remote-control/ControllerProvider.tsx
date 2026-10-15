import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRoomContext } from '@livekit/components-react'
import {
  ConnectionState,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client'
import { useUser } from '@/features/auth'
import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import {
  ControllerSession,
  type ControllerSessionStatus,
} from '../../../../desktop/src/remote-control/controller-session'
import { type SigningKeyRing } from '../../../../desktop/src/remote-control/signing-trust'
import {
  ControllerContext,
  type RequestAvailability,
} from './ControllerContext'
import { ControllerView } from './ControllerView'
import { timedRemoteRequest } from './api'
import { REMOTE_SIGNAL_TOPIC } from './relay'

type Capability = {
  enabled: boolean
  roomSid: string
  keyRing: SigningKeyRing
  self: { identity: string; participantSid: string }
  participants: {
    userId: string
    identity: string
    participantSid: string
    canControl: boolean
    canBeControlled: boolean
    protocolVersions: number[]
  }[]
}

export function ControllerProvider({
  roomId,
  children,
}: {
  roomId?: string
  children: ReactNode
}) {
  const room = useRoomContext(),
    { user } = useUser(),
    userId = user?.id
  const [capability, setCapability] = useState<Capability>()
  const [state, setState] = useState<ControllerSessionStatus>()
  const session = useRef<ControllerSession>()
  const latest = useRef<Capability>()
  const context = useRef<{
    current: () => boolean
    roomSid: string
    participantSid: string
  }>()
  const supported =
    !!window.crypto?.subtle &&
    (!!window.weMeetDesktop ||
      (!/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) &&
        /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)))

  useEffect(() => {
    if (!roomId || !userId || !supported) return
    let disposed = false,
      busy = false,
      revision = 0
    const snapshot = getAuthSnapshot(),
      deviceSessionId = crypto.randomUUID()
    const end = () => {
      ++revision
      context.current = undefined
      latest.current = undefined
      session.current?.stop('connection_changed')
      setCapability(undefined)
    }
    const refresh = async () => {
      if (disposed || busy || room.state !== ConnectionState.Connected) return
      busy = true
      const operation = revision
      try {
        const roomSid = await room.getSid(),
          participantSid = room.localParticipant.sid
        if (disposed || operation !== revision) return
        const valid = () =>
          !disposed &&
          operation === revision &&
          room.state === ConnectionState.Connected &&
          room.localParticipant.sid === participantSid &&
          sameAuthSession(snapshot)
        const response = await timedRemoteRequest(roomId, 'capabilities')
        if (!valid()) return
        const data = response.data as unknown as Capability
        if (!data.enabled) {
          end()
          return
        }
        if (
          data.roomSid !== roomSid ||
          data.self?.identity !== room.localParticipant.identity ||
          data.self?.participantSid !== participantSid ||
          !Array.isArray(data.participants)
        )
          throw new Error('connection_changed')
        // Electron main owns B's device session/presence. Never overwrite it
        // with a second Renderer device ID just to advertise A capability.
        if (!window.weMeetDesktop?.remoteControl) {
          await timedRemoteRequest(roomId, 'capabilities', {
            body: {
              roomSid,
              participantSid,
              deviceSessionId,
              canControl: true,
              canBeControlled: false,
              protocolVersions: [1],
              platform: 'pc-web',
              helperVersion: '',
            },
          })
          if (!valid()) return
        }
        context.current = { current: valid, roomSid, participantSid }
        latest.current = data
        setCapability(data)
      } catch {
        if (!disposed && operation === revision) end()
      } finally {
        busy = false
      }
    }
    const receive = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== REMOTE_SIGNAL_TOPIC) return
      if (!participant) {
        session.current?.wake()
        return
      }
      session.current?.receive({
        topic,
        participantIdentity: participant.identity,
        participantSid: participant.sid,
        payload,
      })
    }
    const left = (participant: RemoteParticipant) => {
      if (session.current?.status().target.identity === participant.identity)
        session.current.stop('participant_left')
    }
    room
      .on(RoomEvent.Connected, refresh)
      .on(RoomEvent.Reconnected, refresh)
      .on(RoomEvent.Reconnecting, end)
      .on(RoomEvent.SignalReconnecting, end)
      .on(RoomEvent.Disconnected, end)
      .on(RoomEvent.DataReceived, receive)
      .on(RoomEvent.ParticipantDisconnected, left)
    const timer = window.setInterval(() => {
      void refresh()
    }, 5000)
    void refresh()
    return () => {
      disposed = true
      ++revision
      context.current = undefined
      latest.current = undefined
      session.current?.stop('meeting_left')
      session.current = undefined
      window.clearInterval(timer)
      room
        .off(RoomEvent.Connected, refresh)
        .off(RoomEvent.Reconnected, refresh)
        .off(RoomEvent.Reconnecting, end)
        .off(RoomEvent.SignalReconnecting, end)
        .off(RoomEvent.Disconnected, end)
        .off(RoomEvent.DataReceived, receive)
        .off(RoomEvent.ParticipantDisconnected, left)
    }
  }, [room, roomId, userId, supported])

  const requestAvailability = (
    participant: Participant
  ): RequestAvailability => {
    if (
      !capability?.enabled ||
      !context.current?.current() ||
      participant.isLocal ||
      room.remoteParticipants.get(participant.identity)?.sid !== participant.sid
    )
      return 'hidden'
    if (session.current && session.current.status().phase !== 'ended')
      return 'busy'
    const target = capability.participants.find(
      (p) =>
        p.identity === participant.identity &&
        p.participantSid === participant.sid
    )
    if (!target?.canBeControlled) return 'desktopRequired'
    return target.protocolVersions.includes(1) ? 'available' : 'versionMismatch'
  }
  const canRequest = (participant: Participant) =>
    requestAvailability(participant) === 'available'
  const request = (participant: Participant) => {
    if (!roomId || !userId || !canRequest(participant)) return
    const c = context.current!,
      capabilities = latest.current!
    const target = capabilities.participants.find(
      (p) =>
        p.identity === participant.identity &&
        p.participantSid === participant.sid
    )!
    let active: ControllerSession
    try {
      active = new ControllerSession({
        context: {
          roomId,
          roomSid: c.roomSid,
          participantSid: c.participantSid,
          identity: room.localParticipant.identity,
          userId,
        },
        target: { ...target, name: participant.name || participant.identity },
        keyRing: capabilities.keyRing,
        request: (action, options) =>
          timedRemoteRequest(roomId, action, options),
        isCurrent: () =>
          c.current() &&
          session.current === active &&
          room.remoteParticipants.get(target.identity)?.sid ===
            target.participantSid,
        send: async (message) => {
          if (
            !c.current() ||
            room.remoteParticipants.get(target.identity)?.sid !==
              target.participantSid
          )
            throw new Error('connection_changed')
          await room.localParticipant.publishData(message.payload, {
            reliable: true,
            topic: message.topic,
            destinationIdentities: [target.identity],
          })
        },
        onState: (value) => {
          if (session.current === active) setState(value)
        },
      })
    } catch {
      // An invalid capability/key cannot create an authorized controller.
      latest.current = undefined
      setCapability(undefined)
      return
    }
    session.current = active
    setState(active.status())
    void active.start()
  }
  return (
    <ControllerContext.Provider
      value={{ canRequest, requestAvailability, request }}
    >
      {children}
      {state && session.current && (
        <ControllerView
          room={room}
          session={session.current}
          state={state}
          onRetry={
            state.phase === 'ended' &&
            room.remoteParticipants.has(state.target.identity) &&
            canRequest(room.remoteParticipants.get(state.target.identity)!)
              ? () => {
                  const peer = room.remoteParticipants.get(
                    state.target.identity
                  )
                  if (peer) request(peer)
                }
              : undefined
          }
          onClose={() => {
            session.current?.stop('local_stop')
            setState(undefined)
          }}
        />
      )}
    </ControllerContext.Provider>
  )
}

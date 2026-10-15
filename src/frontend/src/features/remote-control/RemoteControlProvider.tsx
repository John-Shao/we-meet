import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRoomContext } from '@livekit/components-react'
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteParticipant,
  type TrackPublication,
  type Participant,
} from 'livekit-client'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import type {
  RemoteCapabilities,
  RemoteDesktopEvent,
} from '../../../../desktop/src/remote-control/bridge'
import { remoteRequest, type RemoteRequest } from './api'
import { RemoteControlContext } from './RemoteControlContext'
import { ControllerProvider } from './ControllerProvider'
import {
  REMOTE_INPUT_TOPIC,
  REMOTE_SIGNAL_TOPIC,
  relayTargetMessage,
} from './relay'

/** Mounted once inside LiveKitRoom, including both conference and call layouts. */
export function RemoteControlProvider({
  roomId,
  children,
}: {
  roomId?: string
  children: ReactNode
}) {
  const room = useRoomContext()
  const { user } = useUser()
  const userId = user?.id
  const { t } = useTranslation('rooms', { keyPrefix: 'remoteControl' })
  const bridge = window.weMeetDesktop?.remoteControl
  const [capability, setCapability] = useState<RemoteCapabilities>()
  const [requests, setRequests] = useState<RemoteRequest[]>([])
  const [needsScreen, setNeedsScreen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const current = useRef<RemoteCapabilities>()
  const refresh = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!bridge || !roomId || !userId) return
    let disposed = false,
      revision = 0,
      syncing = false,
      polling = false,
      binding = false
    let nextCapability = 0
    let watched: MediaStreamTrack | undefined
    const update = (value: RemoteCapabilities | undefined) => {
      current.current = value
      if (!disposed) setCapability(value)
    }
    const stopped = () => {
      const contextId = current.current?.contextId
      if (contextId)
        void bridge
          .stop({ contextId, reason: 'share_stopped' })
          .catch(() => undefined)
    }
    const bind = async () => {
      const c = current.current,
        capture = c?.capture
      if (binding || !c?.contextId || !capture || capture.trackSid) return
      const publication = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare
      )
      const track = publication?.track?.mediaStreamTrack
      if (
        !publication ||
        publication.isMuted ||
        !track ||
        track.readyState !== 'live'
      )
        return
      if (watched !== track) {
        watched?.removeEventListener('ended', stopped)
        watched = track
        watched.addEventListener('ended', stopped)
      }
      binding = true
      try {
        await bridge.bindPublishedTrack({
          contextId: c.contextId,
          shareInstanceId: capture.shareInstanceId,
          trackSid: publication.trackSid,
        })
        if (!disposed && current.current?.contextId === c.contextId)
          setNeedsScreen(false)
      } catch {
        // LiveKit's server snapshot may trail LocalTrackPublished. The bounded
        // main-process capture intent expires if subsequent polls cannot bind it.
      } finally {
        binding = false
      }
    }
    const sync = async () => {
      if (disposed || syncing || room.state !== ConnectionState.Connected)
        return
      syncing = true
      const operation = revision
      try {
        const roomSid = await room.getSid()
        if (disposed || operation !== revision) return
        const value = await bridge.capabilities({
          roomId,
          roomSid,
          participantSid: room.localParticipant.sid,
        })
        if (disposed || operation !== revision) {
          if (value.contextId)
            void bridge
              .stop({
                contextId: value.contextId,
                reason: 'connection_changed',
              })
              .catch(() => undefined)
          return
        }
        update(value)
        nextCapability = performance.now() + 5000
        await bind()
      } catch {
        if (!disposed && operation === revision) {
          update(undefined)
          setRequests([])
        }
      } finally {
        syncing = false
      }
    }
    const poll = async () => {
      if (
        disposed ||
        polling ||
        !current.current?.enabled ||
        room.state !== ConnectionState.Connected
      )
        return
      polling = true
      const operation = revision
      try {
        const result = await remoteRequest<{ sessions: RemoteRequest[] }>(
          roomId,
          'requests'
        )
        if (!disposed && operation === revision)
          setRequests(
            result.sessions.filter(
              (s) =>
                s.state === 'PENDING' &&
                s.request.targetIdentity === room.localParticipant.identity &&
                s.request.targetSid === room.localParticipant.sid
            )
          )
      } catch {
        if (!disposed) setRequests([])
      } finally {
        polling = false
      }
    }
    const receive = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string
    ) => {
      if (![REMOTE_SIGNAL_TOPIC, REMOTE_INPUT_TOPIC].includes(topic ?? ''))
        return
      // Server notifications have no participant and only trigger a fresh HTTP read.
      if (!participant) {
        void poll()
        return
      }
      const contextId = current.current?.contextId
      if (contextId)
        void bridge
          .forwardSignedMessage({
            contextId,
            kind: 'received',
            topic: topic!,
            participantIdentity: participant.identity,
            participantSid: participant.sid,
            payload,
          })
          .catch(() => undefined)
    }
    const event = (event: RemoteDesktopEvent) => {
      const c = current.current
      if (disposed || !c?.contextId) return
      if (event.type === 'send') {
        void relayTargetMessage(room, bridge, event, c.contextId).catch(
          () => undefined
        )
        return
      }
      if (!event.contextId) {
        update(undefined)
        setRequests([])
        return
      }
      if (event.contextId === c.contextId) {
        update({ ...c, status: event.status, capture: event.capture })
        if (['ended', 'blocked'].includes(event.status.phase))
          setNeedsScreen(false)
        if (event.status.phase === 'blocked') setError(true)
        void bind()
      }
    }
    const disconnect = () => {
      ++revision
      const contextId = current.current?.contextId
      update(undefined)
      setRequests([])
      setNeedsScreen(false)
      if (contextId)
        void bridge
          .stop({ contextId, reason: 'connection_changed' })
          .catch(() => undefined)
    }
    const published = (p: LocalTrackPublication) => {
      if (p.source === Track.Source.ScreenShare) void bind()
    }
    const unpublished = (p: LocalTrackPublication) => {
      if (p.source === Track.Source.ScreenShare) stopped()
    }
    const muted = (p: TrackPublication, participant: Participant) => {
      if (
        participant === room.localParticipant &&
        p.source === Track.Source.ScreenShare
      )
        stopped()
    }
    const unsubscribe = bridge.onState(event)
    room
      .on(RoomEvent.Connected, sync)
      .on(RoomEvent.Reconnected, sync)
      .on(RoomEvent.Disconnected, disconnect)
      .on(RoomEvent.Reconnecting, disconnect)
      .on(RoomEvent.SignalReconnecting, disconnect)
      .on(RoomEvent.DataReceived, receive)
      .on(RoomEvent.LocalTrackPublished, published)
      .on(RoomEvent.LocalTrackUnpublished, unpublished)
      .on(RoomEvent.TrackMuted, muted)
    refresh.current = () => {
      void poll()
    }
    const timer = window.setInterval(() => {
      if (performance.now() >= nextCapability) void sync()
      void poll()
      void bind()
    }, 2000)
    void sync()
    return () => {
      disposed = true
      ++revision
      window.clearInterval(timer)
      unsubscribe()
      room
        .off(RoomEvent.Connected, sync)
        .off(RoomEvent.Reconnected, sync)
        .off(RoomEvent.Disconnected, disconnect)
        .off(RoomEvent.Reconnecting, disconnect)
        .off(RoomEvent.SignalReconnecting, disconnect)
        .off(RoomEvent.DataReceived, receive)
        .off(RoomEvent.LocalTrackPublished, published)
        .off(RoomEvent.LocalTrackUnpublished, unpublished)
        .off(RoomEvent.TrackMuted, muted)
      watched?.removeEventListener('ended', stopped)
      const contextId = current.current?.contextId
      current.current = undefined
      if (contextId)
        void bridge
          .stop({ contextId, reason: 'meeting_left' })
          .catch(() => undefined)
    }
  }, [bridge, room, roomId, userId])

  const act = async (request: RemoteRequest, reject = false) => {
    if (!bridge || !roomId || !capability?.contextId || busy) return
    setBusy(true)
    setError(false)
    try {
      if (reject) {
        await remoteRequest(roomId, 'reject', {
          sessionId: request.id,
          body: { stateVersion: request.stateVersion },
        })
        if (needsScreen)
          await bridge.stop({
            contextId: capability.contextId,
            reason: 'local_stop',
          })
        setNeedsScreen(false)
      } else {
        const result = await bridge.showRequest({
          contextId: capability.contextId,
          sessionId: request.id,
        })
        setNeedsScreen(result.needsScreen)
      }
      refresh.current()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  const sharing = room.localParticipant.isScreenShareEnabled
  const active =
    capability &&
    [
      'preparing',
      'confirming',
      'active',
      'pausing',
      'paused',
      'ending',
      'blocked',
    ].includes(capability.status.phase)
  return (
    <RemoteControlContext.Provider
      value={{
        beforeStopSharing: () => {
          const contextId = current.current?.contextId
          if (contextId)
            void bridge
              ?.stop({ contextId, reason: 'share_stopped' })
              .catch(() => undefined)
        },
      }}
    >
      <ControllerProvider roomId={roomId}>{children}</ControllerProvider>
      {capability?.enabled &&
        (requests.length > 0 || active || error || needsScreen) && (
          <aside
            aria-label={t('title')}
            className={css({
              position: 'fixed',
              bottom: '96px',
              right: '16px',
              zIndex: 60,
              width: '360px',
              maxWidth: '90vw',
              borderRadius: '12px',
              padding: '16px',
              backgroundColor: 'surface.default',
              color: 'text.primary',
              boxShadow: 'lg',
            })}
          >
            <strong>{t('title')}</strong>
            {active ? (
              <p role="status">{t(`phase.${capability.status.phase}`)}</p>
            ) : (
              requests.map((request) => (
                <div key={request.id}>
                  <p>
                    {t('request', { name: request.request.controllerName })}
                  </p>
                  <p>{t('scope')}</p>
                  <Button
                    onPress={() => void act(request)}
                    isDisabled={
                      busy || needsScreen || !capability.canBeControlled
                    }
                  >
                    {t('review')}
                  </Button>{' '}
                  <Button
                    onPress={() => void act(request, true)}
                    isDisabled={busy}
                  >
                    {t('reject')}
                  </Button>
                </div>
              ))
            )}
            {needsScreen && (
              <div>
                <p>{t(sharing ? 'replaceShare' : 'chooseScreen')}</p>
                <Button
                  isDisabled={busy}
                  onPress={() => {
                    setBusy(true)
                    setError(false)
                    // Invoke capture directly from this fresh user gesture.
                    void room.localParticipant
                      .setScreenShareEnabled(!sharing, { audio: false })
                      .catch(() => setError(true))
                      .finally(() => setBusy(false))
                  }}
                >
                  {t(sharing ? 'stopShare' : 'chooseScreenButton')}
                </Button>
              </div>
            )}
            {error && <p role="alert">{t('error')}</p>}
            {active && capability.status.phase !== 'blocked' && (
              <Button
                onPress={() => {
                  void bridge
                    ?.stop({
                      contextId: capability.contextId!,
                      reason: 'local_stop',
                    })
                    .catch(() => setError(true))
                }}
              >
                {t('stop')}
              </Button>
            )}
          </aside>
        )}
    </RemoteControlContext.Provider>
  )
}

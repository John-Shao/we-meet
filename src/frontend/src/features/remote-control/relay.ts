import { ConnectionState, type Room } from 'livekit-client'
import type {
  RemoteControlBridge,
  RemoteDesktopEvent,
} from '../../../../desktop/src/remote-control/bridge'

export const REMOTE_SIGNAL_TOPIC = 'we-meet.remote-control.v1.signal'
export const REMOTE_INPUT_TOPIC = 'we-meet.remote-control.v1.input'

/** Completion acknowledges the SDK publish promise, never just delivery to IPC. */
export async function relayTargetMessage(
  room: Pick<Room, 'state' | 'localParticipant' | 'remoteParticipants'>,
  bridge: RemoteControlBridge,
  event: Extract<RemoteDesktopEvent, { type: 'send' }>,
  contextId: string
) {
  if (event.contextId !== contextId) return
  let ok = false
  try {
    if (
      room.state !== ConnectionState.Connected ||
      event.topic !== REMOTE_SIGNAL_TOPIC ||
      !room.remoteParticipants.has(event.destinationIdentity)
    )
      throw new Error('connection_changed')
    await room.localParticipant.publishData(event.payload, {
      reliable: true,
      topic: REMOTE_SIGNAL_TOPIC,
      destinationIdentities: [event.destinationIdentity],
    })
    ok = room.state === ConnectionState.Connected
  } finally {
    await bridge
      .forwardSignedMessage({
        contextId,
        kind: 'sent',
        messageId: event.messageId,
        ok,
      })
      .catch(() => undefined)
  }
}

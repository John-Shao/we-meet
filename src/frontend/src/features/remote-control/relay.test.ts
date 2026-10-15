import { describe, expect, it, vi } from 'vitest'
import { ConnectionState, type Room } from 'livekit-client'
import type {
  RemoteControlBridge,
  RemoteDesktopEvent,
} from '../../../../desktop/src/remote-control/bridge'
import { relayTargetMessage, REMOTE_SIGNAL_TOPIC } from './relay'

function fixture() {
  const publishData = vi.fn().mockResolvedValue(undefined)
  const forwardSignedMessage = vi.fn().mockResolvedValue(undefined)
  const bridge = { forwardSignedMessage } as unknown as RemoteControlBridge
  const room = {
    state: ConnectionState.Connected,
    localParticipant: { publishData },
    remoteParticipants: new Map([
      ['controller', {}],
      ['bystander', {}],
    ]),
  } as unknown as Room
  const event: Extract<RemoteDesktopEvent, { type: 'send' }> = {
    type: 'send',
    contextId: 'context',
    messageId: 'packet',
    topic: REMOTE_SIGNAL_TOPIC,
    destinationIdentity: 'controller',
    payload: new Uint8Array([1, 2]),
  }
  return { room, bridge, event, publishData, forwardSignedMessage }
}

describe('desktop target LiveKit relay', () => {
  it('sends reliably to exactly one peer and acknowledges only after publish completes', async () => {
    const f = fixture()
    let complete!: () => void
    f.publishData.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve
      })
    )
    const sending = relayTargetMessage(f.room, f.bridge, f.event, 'context')
    expect(f.publishData).toHaveBeenCalledWith(f.event.payload, {
      reliable: true,
      topic: REMOTE_SIGNAL_TOPIC,
      destinationIdentities: ['controller'],
    })
    expect(f.forwardSignedMessage).not.toHaveBeenCalled()
    complete()
    await sending
    expect(f.forwardSignedMessage).toHaveBeenCalledWith({
      contextId: 'context',
      kind: 'sent',
      messageId: 'packet',
      ok: true,
    })
  })
  it('does not publish a stale context or broadcast when its destination is absent', async () => {
    const f = fixture()
    await relayTargetMessage(f.room, f.bridge, f.event, 'new-context')
    expect(f.publishData).not.toHaveBeenCalled()
    f.room.remoteParticipants.delete('controller')
    await expect(
      relayTargetMessage(f.room, f.bridge, f.event, 'context')
    ).rejects.toThrow('connection_changed')
    expect(f.publishData).not.toHaveBeenCalled()
    expect(f.forwardSignedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false })
    )
  })
  it('reports failure to main if the SDK rejects or disconnects during publish', async () => {
    const f = fixture()
    f.publishData.mockRejectedValue(new Error('publish_failed'))
    await expect(
      relayTargetMessage(f.room, f.bridge, f.event, 'context')
    ).rejects.toThrow('publish_failed')
    expect(f.forwardSignedMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false })
    )
    f.publishData.mockImplementation(async () => {
      f.room.state = ConnectionState.Reconnecting
    })
    await relayTargetMessage(f.room, f.bridge, f.event, 'context')
    expect(f.forwardSignedMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false })
    )
  })
})

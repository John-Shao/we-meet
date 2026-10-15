import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ConnectionState, RoomEvent, Track } from 'livekit-client'
import type {
  RemoteCapabilities,
  RemoteControlBridge,
  RemoteDesktopEvent,
} from '../../../../desktop/src/remote-control/bridge'

const mocks = vi.hoisted(() => ({ room: null as unknown, api: vi.fn() }))
vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => mocks.room,
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'target-user' } }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./api', () => ({ remoteRequest: mocks.api }))
vi.mock('./ControllerProvider', () => ({
  ControllerProvider: ({ children }: { children: import('react').ReactNode }) =>
    children,
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: import('react').ReactNode
    onPress: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onPress} disabled={isDisabled}>
      {children}
    </button>
  ),
}))
import { RemoteControlProvider } from './RemoteControlProvider'
import { REMOTE_SIGNAL_TOPIC } from './relay'
import { useRemoteControl } from './RemoteControlContext'

function StopShare() {
  const { beforeStopSharing } = useRemoteControl()
  return <button onClick={beforeStopSharing}>stop-sharing-now</button>
}

function fixture(enabled = true) {
  const cap: RemoteCapabilities = {
    enabled,
    contextId: 'context',
    canBeControlled: enabled,
    status: { phase: 'idle', inputOpen: false, cleanupBlocked: false },
  }
  let publication: unknown
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    getSid: vi.fn().mockResolvedValue('RM_room'),
    remoteParticipants: new Map(),
    localParticipant: {
      identity: 'target',
      sid: 'PA_target',
      isScreenShareEnabled: false,
      getTrackPublication: () => publication,
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
    },
  })
  let listener: (event: RemoteDesktopEvent) => void = () => undefined
  const bridge = {
    capabilities: vi.fn().mockResolvedValue(cap),
    showRequest: vi.fn().mockResolvedValue({ needsScreen: true }),
    bindPublishedTrack: vi.fn().mockResolvedValue(undefined),
    forwardSignedMessage: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn().mockImplementation((fn: typeof listener) => {
      listener = fn
      return () => {
        listener = () => undefined
      }
    }),
  } satisfies RemoteControlBridge
  mocks.room = room
  window.weMeetDesktop = {
    isDesktop: true,
    platform: 'win32',
    remoteControl: bridge,
    getStatus: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    retry: vi.fn(),
    onStatus: vi.fn(),
  }
  mocks.api.mockResolvedValue({
    sessions: [
      {
        id: 'request',
        state: 'PENDING',
        stateVersion: 1,
        request: {
          controllerName: 'Controller',
          targetIdentity: 'target',
          targetSid: 'PA_target',
        },
      },
    ],
  })
  const view = render(
    <RemoteControlProvider roomId="room">
      <span>meeting</span>
      <StopShare />
    </RemoteControlProvider>
  )
  return {
    room,
    cap,
    bridge,
    view,
    emit: (event: RemoteDesktopEvent) => listener(event),
    publish: (value: unknown) => {
      publication = value
      room.emit(RoomEvent.LocalTrackPublished, value)
    },
  }
}
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.api.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  delete window.weMeetDesktop
})

describe('target meeting lifecycle', () => {
  it('shows and dismisses an end notice without hiding new requests or clearing a cleanup block', async () => {
    const f = fixture()
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('review')).toBeInTheDocument()
    const ended = {
      phase: 'ended' as const,
      sessionId: 'previous',
      inputOpen: false,
      cleanupBlocked: false,
      reason: 'share_stopped',
    }
    act(() => f.emit({ type: 'state', contextId: 'context', status: ended }))
    expect(screen.getByText('endReason.screen')).toBeInTheDocument()
    expect(screen.getByText('review')).toBeInTheDocument()
    fireEvent.click(screen.getByText('dismiss'))
    expect(screen.queryByText('endReason.screen')).not.toBeInTheDocument()
    expect(screen.getByText('review')).toBeInTheDocument()
    act(() =>
      f.emit({
        type: 'state',
        contextId: 'context',
        status: {
          ...ended,
          sessionId: 'next',
          reason: 'private-server-detail',
        },
      })
    )
    expect(screen.getByText('endReason.generic')).toBeInTheDocument()
    expect(screen.queryByText('private-server-detail')).not.toBeInTheDocument()
    act(() =>
      f.emit({
        type: 'state',
        contextId: 'context',
        status: { ...ended, phase: 'blocked', cleanupBlocked: true },
      })
    )
    expect(screen.getByText('phase.blocked')).toBeInTheDocument()
    expect(screen.queryByText('dismiss')).not.toBeInTheDocument()
    expect(f.bridge.showRequest).not.toHaveBeenCalled()
  })
  it('requests local gate closure before the share button waits for SDK unpublication', async () => {
    const f = fixture()
    await settle()
    fireEvent.click(screen.getByText('stop-sharing-now'))
    expect(f.bridge.stop).toHaveBeenCalledWith({
      contextId: 'context',
      reason: 'share_stopped',
    })
  })
  it('keeps normal meeting content and hides controls when policy disables the feature', async () => {
    fixture(false)
    await settle()
    expect(screen.getByText('meeting')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(mocks.api).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })
  it('reviews through main and waits for a separate user gesture to select a full screen', async () => {
    const f = fixture()
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    fireEvent.click(screen.getByText('review'))
    await settle()
    expect(f.bridge.showRequest).toHaveBeenCalledWith({
      contextId: 'context',
      sessionId: 'request',
    })
    expect(f.room.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('chooseScreenButton'))
    await settle()
    expect(f.room.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      { audio: false }
    )
  })
  it('binds an actual local screen publication and stops as soon as its media track ends', async () => {
    const f = fixture()
    await settle()
    act(() =>
      f.emit({
        type: 'state',
        contextId: 'context',
        status: f.cap.status,
        capture: { shareInstanceId: 'share', width: 1920, height: 1080 },
      })
    )
    const track = Object.assign(new EventTarget(), { readyState: 'live' })
    await act(async () =>
      f.publish({
        source: Track.Source.ScreenShare,
        trackSid: 'TR_screen',
        isMuted: false,
        track: { mediaStreamTrack: track },
      })
    )
    expect(f.bridge.bindPublishedTrack).toHaveBeenCalledWith({
      contextId: 'context',
      shareInstanceId: 'share',
      trackSid: 'TR_screen',
    })
    act(() => track.dispatchEvent(new Event('ended')))
    expect(f.bridge.stop).toHaveBeenCalledWith({
      contextId: 'context',
      reason: 'share_stopped',
    })
  })
  it('does not treat unsigned server hints as input and revokes the context on reconnection', async () => {
    const f = fixture()
    await settle()
    await act(async () => {
      f.room.emit(
        RoomEvent.DataReceived,
        new Uint8Array([1]),
        undefined,
        undefined,
        REMOTE_SIGNAL_TOPIC
      )
    })
    expect(f.bridge.forwardSignedMessage).not.toHaveBeenCalled()
    expect(mocks.api).toHaveBeenCalled()
    act(() => {
      f.room.state = ConnectionState.Reconnecting
      f.room.emit(RoomEvent.SignalReconnecting)
      f.room.emit(
        RoomEvent.DataReceived,
        new Uint8Array([1]),
        { identity: 'controller', sid: 'PA_controller' },
        undefined,
        REMOTE_SIGNAL_TOPIC
      )
    })
    expect(f.bridge.stop).toHaveBeenCalledWith({
      contextId: 'context',
      reason: 'connection_changed',
    })
    expect(f.bridge.forwardSignedMessage).not.toHaveBeenCalled()
  })
  it('closes the same context when the meeting subtree unmounts', async () => {
    const f = fixture()
    await settle()
    f.view.unmount()
    expect(f.bridge.stop).toHaveBeenCalledWith({
      contextId: 'context',
      reason: 'meeting_left',
    })
    expect(f.room.listenerCount(RoomEvent.DataReceived)).toBe(0)
  })
})

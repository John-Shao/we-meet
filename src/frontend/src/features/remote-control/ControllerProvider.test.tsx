import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { webcrypto } from 'node:crypto'
import { ConnectionState, RoomEvent, type Participant } from 'livekit-client'
import type { ControllerSession } from '../../../../desktop/src/remote-control/controller-session'

type Dependencies = ConstructorParameters<typeof ControllerSession>[0]
const mocks = vi.hoisted(() => ({
  room: null as unknown,
  api: vi.fn(),
  current: true,
  deps: null as Dependencies | null,
  session: null as unknown,
}))
vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => mocks.room,
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'controller-user' } }),
}))
vi.mock('@/features/auth/utils/tokenStorage', () => ({
  getAuthSnapshot: () => ({}),
  sameAuthSession: () => mocks.current,
}))
vi.mock('./api', () => ({ timedRemoteRequest: mocks.api }))
vi.mock('./ControllerView', () => ({
  ControllerView: ({ onRetry }: { onRetry?: () => void }) => (
    <div>
      controller-view
      {onRetry && <button onClick={onRetry}>retry</button>}
    </div>
  ),
}))
vi.mock('../../../../desktop/src/remote-control/controller-session', () => ({
  ControllerSession: class {
    phase = 'pending'
    start = vi.fn()
    stop = vi.fn(() => {
      this.phase = 'ended'
    })
    wake = vi.fn()
    receive = vi.fn()
    constructor(readonly deps: Dependencies) {
      mocks.deps = deps
      mocks.session = this
    }
    status() {
      return {
        phase: this.phase,
        target: this.deps.target,
        deliveredText: 0,
        textOutcome: 'idle',
      }
    }
  },
}))
import { ControllerProvider } from './ControllerProvider'
import { useRemoteController } from './ControllerContext'
import { REMOTE_SIGNAL_TOPIC } from './relay'

function RequestButton({ participant }: { participant: Participant }) {
  const { canRequest, request, requestAvailability } = useRemoteController()
  return (
    <>
      <span data-testid="availability">{requestAvailability(participant)}</span>
      <button
        disabled={!canRequest(participant)}
        onClick={() => request(participant)}
      >
        request
      </button>
    </>
  )
}
function fixture(enabled = true, peerCapability: Record<string, unknown> = {}) {
  const peer = { identity: 'B', sid: 'PA_b', isLocal: false, name: 'Target' }
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    getSid: vi.fn().mockResolvedValue('RM_room'),
    remoteParticipants: new Map([['B', peer]]),
    localParticipant: {
      identity: 'A',
      sid: 'PA_a',
      publishData: vi.fn().mockResolvedValue(undefined),
    },
  })
  mocks.room = room
  mocks.api.mockResolvedValue({
    data: {
      enabled,
      roomSid: 'RM_room',
      self: { identity: 'A', participantSid: 'PA_a' },
      keyRing: {},
      participants: [
        {
          userId: 'target-user',
          identity: 'B',
          participantSid: 'PA_b',
          canBeControlled: true,
          protocolVersions: [1],
          ...peerCapability,
        },
      ],
    },
  })
  const rendered = render(
    <ControllerProvider roomId="room">
      <RequestButton participant={peer as Participant} />
    </ControllerProvider>
  )
  return { ...rendered, room, peer }
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.current = true
  mocks.deps = null
  mocks.session = null
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 Windows Chrome/140'
  )
  delete window.weMeetDesktop
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.weMeetDesktop
})

describe('controller meeting adapter', () => {
  it.each([
    [{ canBeControlled: false }, 'desktopRequired'],
    [{ participantSid: 'PA_previous' }, 'desktopRequired'],
    [{ protocolVersions: [2] }, 'versionMismatch'],
  ])(
    'explains unavailable target capability without creating a request: %j',
    async (capability, reason) => {
      fixture(true, capability)
      await flush()
      expect(screen.getByTestId('availability')).toHaveTextContent(reason)
      fireEvent.click(screen.getByText('request'))
      expect(mocks.session).toBeNull()
    }
  )
  it('creates a new session only after explicit retry and hides retry after disconnection', async () => {
    const f = fixture()
    await flush()
    fireEvent.click(screen.getByText('request'))
    const previous = mocks.session as ControllerSession
    expect(screen.getByTestId('availability')).toHaveTextContent('busy')
    expect(screen.queryByText('retry')).not.toBeInTheDocument()
    act(() => {
      previous.stop('authorization_expired')
      mocks.deps!.onState({
        ...previous.status(),
        phase: 'ended',
        reason: 'authorization_expired',
      })
    })
    expect(mocks.session).toBe(previous)
    fireEvent.click(screen.getByText('retry'))
    expect(mocks.session).not.toBe(previous)
    expect((mocks.session as ControllerSession).start).toHaveBeenCalledOnce()
    act(() => f.room.emit(RoomEvent.Reconnecting))
    expect(screen.queryByText('retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('availability')).toHaveTextContent('hidden')
  })
  it('enables only an eligible target and posts browser presence without native control capability', async () => {
    const f = fixture()
    await flush()
    expect(screen.getByText('request')).not.toBeDisabled()
    expect(mocks.api).toHaveBeenCalledWith(
      'room',
      'capabilities',
      expect.objectContaining({
        body: expect.objectContaining({
          platform: 'pc-web',
          canControl: true,
          canBeControlled: false,
        }),
      })
    )
    fireEvent.click(screen.getByText('request'))
    expect((mocks.session as ControllerSession).start).toHaveBeenCalledOnce()
    expect(screen.getByText('controller-view')).toBeInTheDocument()
    expect(mocks.deps?.target).toMatchObject({
      identity: 'B',
      participantSid: 'PA_b',
    })
    await mocks.deps!.send({
      topic: REMOTE_SIGNAL_TOPIC,
      destinationIdentity: 'C',
      payload: new Uint8Array([1]),
    })
    expect(f.room.localParticipant.publishData).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      {
        reliable: true,
        topic: REMOTE_SIGNAL_TOPIC,
        destinationIdentities: ['B'],
      }
    )
  })
  it('does not overwrite Electron main presence with a Renderer device identity', async () => {
    window.weMeetDesktop = { remoteControl: {} } as Window['weMeetDesktop']
    fixture()
    await flush()
    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(screen.getByText('request')).not.toBeDisabled()
  })
  it('disabled features and mobile browsers cannot request control', async () => {
    const f = fixture(false)
    await flush()
    expect(screen.getByText('request')).toBeDisabled()
    f.unmount()
    mocks.api.mockClear()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Android Mobile Chrome/140'
    )
    fixture()
    await flush()
    expect(mocks.api).not.toHaveBeenCalled()
    expect(screen.getByText('request')).toBeDisabled()
  })
  it('server hints only wake HTTP polling and participant packets preserve actual SDK identity/SID', async () => {
    const f = fixture()
    await flush()
    fireEvent.click(screen.getByText('request'))
    const session = mocks.session as ControllerSession,
      bytes = new Uint8Array([1, 2])
    act(() =>
      f.room.emit(
        RoomEvent.DataReceived,
        bytes,
        undefined,
        undefined,
        REMOTE_SIGNAL_TOPIC
      )
    )
    expect(session.wake).toHaveBeenCalledOnce()
    expect(session.receive).not.toHaveBeenCalled()
    act(() =>
      f.room.emit(
        RoomEvent.DataReceived,
        bytes,
        { identity: 'C', sid: 'PA_c' },
        undefined,
        REMOTE_SIGNAL_TOPIC
      )
    )
    expect(session.receive).toHaveBeenCalledExactlyOnceWith({
      topic: REMOTE_SIGNAL_TOPIC,
      participantIdentity: 'C',
      participantSid: 'PA_c',
      payload: bytes,
    })
    act(() =>
      f.room.emit(
        RoomEvent.DataReceived,
        bytes,
        f.peer,
        undefined,
        'other-topic'
      )
    )
    expect(session.receive).toHaveBeenCalledTimes(1)
  })
  it('reconnection, account changes and peer SID replacement invalidate pending sends', async () => {
    const f = fixture()
    await flush()
    fireEvent.click(screen.getByText('request'))
    const deps = mocks.deps!,
      session = mocks.session as ControllerSession
    expect(deps.isCurrent()).toBe(true)
    mocks.current = false
    expect(deps.isCurrent()).toBe(false)
    await expect(
      deps.send({
        topic: REMOTE_SIGNAL_TOPIC,
        destinationIdentity: 'B',
        payload: new Uint8Array(),
      })
    ).rejects.toThrow('connection_changed')
    mocks.current = true
    f.peer.sid = 'PA_reconnected'
    expect(deps.isCurrent()).toBe(false)
    f.peer.sid = 'PA_b'
    act(() => f.room.emit(RoomEvent.Reconnecting))
    expect(session.stop).toHaveBeenCalledWith('connection_changed')
    expect(deps.isCurrent()).toBe(false)
    expect(f.room.localParticipant.publishData).not.toHaveBeenCalled()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { RoomEvent, Track, type Room } from 'livekit-client'
import type {
  ControllerSession,
  ControllerSessionStatus,
} from '../../../../desktop/src/remote-control/controller-session'
import { Kind } from '../../../../desktop/src/remote-control/wire'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
import { ControllerView } from './ControllerView'

let callback: VideoFrameRequestCallback | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  for (const [key, value] of Object.entries({
    readyState: 4,
    paused: false,
    videoWidth: 1920,
    videoHeight: 1080,
  }))
    Object.defineProperty(HTMLVideoElement.prototype, key, {
      configurable: true,
      get: () => value,
    })
  HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn((fn) => {
    callback = fn
    return 1
  })
  HTMLVideoElement.prototype.cancelVideoFrameCallback = vi.fn()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  callback = undefined
})

function fixture(onRetry?: () => void) {
  const track = {
    attach: vi.fn(),
    detach: vi.fn(),
    mediaStreamTrack: { readyState: 'live', muted: false },
  }
  const publication = {
    source: Track.Source.ScreenShare,
    isSubscribed: true,
    isMuted: false,
    setSubscribed: vi.fn(),
    track,
  }
  const peer = {
    sid: 'PA_b',
    trackPublications: new Map([['TR_screen', publication]]),
  }
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map([['B', peer]]),
  })
  const session = {
    setHealth: vi.fn(),
    stop: vi.fn(),
    suspend: vi.fn(),
    capture: vi.fn(),
    text: vi.fn(),
    shortcut: vi.fn(),
    input: vi.fn().mockReturnValue(true),
  }
  let state: ControllerSessionStatus = {
    phase: 'active',
    target: {
      identity: 'B',
      participantSid: 'PA_b',
      userId: 'user',
      name: 'B',
    },
    trackSid: 'TR_screen',
    deliveredText: 0,
    textOutcome: 'idle',
    input: { phase: 'waiting', epoch: 1, oneShot: false },
  }
  const onClose = vi.fn()
  const view = () => (
    <ControllerView
      room={room as unknown as Room}
      session={session as unknown as ControllerSession}
      state={state}
      onClose={onClose}
      onRetry={onRetry}
    />
  )
  const result = render(view())
  const region = screen.getByRole('application'),
    video = region.querySelector('video')!
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 450,
    right: 800,
    bottom: 450,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  const frame = () =>
    act(() => callback?.(performance.now(), {} as VideoFrameCallbackMetadata))
  const update = (patch: Partial<ControllerSessionStatus>) => {
    state = { ...state, ...patch }
    result.rerender(view())
  }
  const open = (generation = 'generation-one') => {
    update({
      input: {
        phase: 'open',
        epoch: 1,
        oneShot: false,
        inputGeneration: generation,
        width: 1920,
        height: 1080,
      },
    })
    act(() => region.focus())
  }
  const pointer = (type: string, x = 400, y = 225) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
    })
    Object.defineProperties(event, {
      pointerType: { value: 'mouse' },
      pointerId: { value: 1 },
    })
    fireEvent(region, event)
  }
  return {
    ...result,
    session,
    room,
    peer,
    publication,
    track,
    region,
    video,
    frame,
    update,
    open,
    pointer,
  }
}

describe('controller input view', () => {
  it('shows the ending reason and requires explicit retry without forwarding ended input', () => {
    const retry = vi.fn()
    const f = fixture(retry)
    f.frame()
    f.open()
    f.update({ phase: 'ended', reason: 'input_ack_timeout' })
    expect(screen.getByText('endReason.unconfirmed')).toBeInTheDocument()
    expect(screen.getByText('retryHint')).toBeInTheDocument()
    expect(screen.getByText('start')).toBeDisabled()
    fireEvent.keyDown(f.region, { code: 'KeyA' })
    expect(f.session.input).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('retry'))
    expect(retry).toHaveBeenCalledOnce()
    expect(f.session.capture).not.toHaveBeenCalled()
  })
  it('uses a generic explanation for unknown reasons without exposing raw errors or offering an unavailable retry', () => {
    const f = fixture()
    f.update({ phase: 'ended', reason: 'private-token-or-server-detail' })
    expect(screen.getByText('endReason.generic')).toBeInTheDocument()
    expect(
      screen.queryByText('private-token-or-server-detail')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('retry')).not.toBeInTheDocument()
    expect(screen.getByText('close')).toBeInTheDocument()
  })
  it('requires a decoded bound screen and an explicit start; clicking focus alone never arms', () => {
    const f = fixture()
    expect(screen.getByText('start')).toBeDisabled()
    act(() => f.region.focus())
    expect(f.session.capture).not.toHaveBeenCalled()
    f.frame()
    expect(screen.getByText('start')).not.toBeDisabled()
    fireEvent.click(screen.getByText('start'))
    expect(f.session.capture).toHaveBeenCalledOnce()
    expect(f.session.setHealth).toHaveBeenLastCalledWith({
      pageActive: true,
      captureFocused: true,
      videoReady: true,
    })
    f.open()
    fireEvent.keyDown(f.region, { key: 'a', code: 'KeyA' })
    expect(f.session.input).toHaveBeenCalledWith(
      expect.objectContaining({ kind: Kind.Key, code: 0x1e, action: 1 })
    )
    fireEvent.keyDown(f.region, { key: 'Escape', code: 'Escape' })
    expect(f.session.suspend).toHaveBeenCalled()
    expect(f.session.input).toHaveBeenCalledTimes(1)
  })
  it('typing in chat/text and IME composition never becomes remote keystrokes', () => {
    const f = fixture()
    f.frame()
    f.open()
    const draft = screen.getByRole('textbox')
    act(() => draft.focus())
    fireEvent.keyDown(draft, { key: 'a', code: 'KeyA' })
    fireEvent.change(draft, { target: { value: '中文草稿' } })
    fireEvent.compositionStart(draft)
    expect(screen.getByText('sendText')).toBeDisabled()
    expect(f.session.input).not.toHaveBeenCalled()
    fireEvent.compositionEnd(draft)
    f.update({ input: { phase: 'suspended', epoch: 1, oneShot: false } })
    fireEvent.click(screen.getByText('sendText'))
    expect(f.session.text).toHaveBeenCalledExactlyOnceWith('中文草稿')
    f.update({ textOutcome: 'pending' })
    expect(draft).toBeDisabled()
    f.update({ textOutcome: 'unconfirmed' })
    expect(draft).toHaveValue('中文草稿')
    expect(screen.getByRole('alert')).toHaveTextContent('textUnconfirmed')
    f.update({ textOutcome: 'applied', deliveredText: 1 })
    expect(draft).toHaveValue('')
  })
  it('drops a queued pointer move after a new generation, blur, or video loss', () => {
    const f = fixture()
    f.frame()
    f.open()
    f.pointer('pointermove')
    f.open('generation-two')
    act(() => vi.advanceTimersByTime(34))
    expect(f.session.input).not.toHaveBeenCalled()
    f.pointer('pointermove')
    act(() => vi.advanceTimersByTime(34))
    expect(f.session.input).toHaveBeenCalledExactlyOnceWith({
      kind: Kind.Move,
      x: 0.5,
      y: 0.5,
    })
    f.pointer('pointermove')
    act(() => screen.getByRole('textbox').focus())
    act(() => vi.advanceTimersByTime(34))
    expect(f.session.input).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(3000))
    expect(f.session.setHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ videoReady: false })
    )
  })
  it('minimizing suspends input, keeps video attached, and expanding does not arm', () => {
    const f = fixture()
    f.frame()
    f.open()
    fireEvent.click(screen.getByText('minimize'))
    expect(f.session.suspend).toHaveBeenCalled()
    expect(f.track.detach).not.toHaveBeenCalled()
    expect(f.region).toHaveAttribute('tabindex', '-1')
    fireEvent.click(screen.getByText('expand'))
    expect(f.session.capture).not.toHaveBeenCalled()
    f.publication.isMuted = true
    act(() => f.room.emit(RoomEvent.TrackMuted))
    expect(f.session.setHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ videoReady: false })
    )
  })
  it('cannot use a replacement peer or another source, and modifiers held before focus cause suspension', () => {
    const f = fixture()
    f.frame()
    f.open()
    fireEvent.keyDown(f.region, { key: 'c', code: 'KeyC', ctrlKey: true })
    expect(f.session.suspend).toHaveBeenCalled()
    expect(f.session.input).not.toHaveBeenCalled()
    f.peer.sid = 'PA_reconnected'
    act(() => f.room.emit(RoomEvent.TrackSubscribed))
    expect(f.session.stop).toHaveBeenCalledWith('connection_changed')
  })
})

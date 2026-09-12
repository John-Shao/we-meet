import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PrivateTranslationContext,
  type PrivateTranslationState,
} from '../translationContext'
import { PrivateTranslationPanel } from './PrivateTranslationPanel'

const mocks = vi.hoisted(() => ({ microphone: true }))
vi.mock('@livekit/components-react', () => ({
  useLocalParticipant: () => ({ isMicrophoneEnabled: mocks.microphone }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { language: string }) =>
      options ? `${key}:${options.language}` : key,
  }),
}))
let state: PrivateTranslationState
const show = () =>
  render(
    <PrivateTranslationContext.Provider value={state}>
      <PrivateTranslationPanel />
    </PrivateTranslationContext.Provider>
  )
beforeEach(() => {
  mocks.microphone = true
  state = {
    visible: true,
    available: true,
    canStart: true,
    ownConnection: true,
    pending: false,
    uncertain: false,
    error: false,
    ready: true,
    muted: false,
    held: null,
    turnBusy: false,
    rows: [],
    change: vi.fn(),
    press: vi.fn(),
    toggleSound: vi.fn(),
    current: {
      id: 'run',
      generation: 1,
      state: 'translating',
      source_participant_sid: 'PA_self',
      configuration: {
        source: 'zh',
        target: 'en',
        mode: 'push_to_talk',
        audio: true,
      },
    },
  }
})
describe('Private voice translation controls', () => {
  it('requires an explicit start and never enables the meeting microphone', () => {
    state.current = null
    mocks.microphone = false
    show()
    expect(screen.getByRole('button', { name: 'start' })).toBeDisabled()
    expect(state.change).not.toHaveBeenCalled()
    expect(screen.getByText('microphone')).toBeInTheDocument()
  })
  it('maps pointer and keyboard releases to the correct direction', () => {
    show()
    const forward = screen.getByRole('button', { name: 'hold:language.zh' })
    fireEvent.pointerDown(forward)
    fireEvent.pointerCancel(forward)
    expect(state.press).toHaveBeenNthCalledWith(1, 'forward', true)
    expect(state.press).toHaveBeenNthCalledWith(2, 'forward', false)
    const reverse = screen.getByRole('button', { name: 'hold:language.en' })
    fireEvent.keyDown(reverse, { key: ' ' })
    fireEvent.keyUp(reverse, { key: ' ' })
    expect(state.press).toHaveBeenNthCalledWith(3, 'reverse', true)
    expect(state.press).toHaveBeenNthCalledWith(4, 'reverse', false)
  })
  it('releases a held turn when the window loses focus or the panel closes', () => {
    state.held = 'forward'
    const page = show()
    fireEvent(window, new Event('blur'))
    expect(state.press).toHaveBeenCalledWith('forward', false)
    page.unmount()
    expect(state.press).toHaveBeenCalledTimes(2)
  })
  it('does not claim stop completion or allow another device to send speech', () => {
    state.ownConnection = false
    state.current!.state = 'stopping'
    show()
    expect(screen.getByRole('button', { name: 'stop' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'hold:language.zh' })
    ).toBeDisabled()
    expect(screen.queryByText('state.stopped')).not.toBeInTheDocument()
    expect(screen.getByText('otherDevice')).toBeInTheDocument()
  })
})

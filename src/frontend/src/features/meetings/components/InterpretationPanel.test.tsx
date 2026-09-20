import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterpretationContext,
  type InterpretationState,
} from '../interpretationContext'
import { InterpretationPanel } from './InterpretationPanel'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { language: string }) =>
      options?.language ? `${key}:${options.language}` : key,
  }),
}))
let state: InterpretationState
const show = () =>
  render(
    <InterpretationContext.Provider value={state}>
      <InterpretationPanel />
    </InterpretationContext.Provider>
  )
beforeEach(() => {
  state = {
    visible: true,
    available: true,
    canControl: false,
    canJoin: true,
    muted: true,
    ready: false,
    pending: false,
    uncertain: false,
    error: false,
    rows: [],
    channels: [
      {
        id: 'en-channel',
        generation: 1,
        target: 'en',
        state: 'translating',
        error_code: '',
      },
    ],
    control: vi.fn(),
    choose: vi.fn(),
    resubmit: vi.fn(),
    toggleSound: vi.fn(),
    canPlay: vi.fn(),
    speakerName: vi.fn(),
  }
})
describe('Meeting interpretation controls', () => {
  it('lets participants choose listening without exposing administrator controls', () => {
    show()
    expect(
      screen.queryByRole('button', { name: /Channel/ })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'join:language.en' }))
    expect(state.choose).toHaveBeenCalledWith(state.channels[0])
    expect(state.control).not.toHaveBeenCalled()
  })
  it('distinguishes leaving personal listening from ending a channel for everyone', () => {
    state.canControl = true
    state.listening = 'en-channel'
    show()
    fireEvent.click(screen.getByRole('button', { name: 'leave:language.en' }))
    expect(state.choose).toHaveBeenCalledWith(undefined)
    fireEvent.click(
      screen.getByRole('button', { name: 'stopChannel:language.en' })
    )
    expect(state.control).toHaveBeenCalledWith('en', 'stop', false)
  })
  it('keeps an uncertain request explicit and blocks new mutations', () => {
    state.uncertain = true
    state.error = true
    show()
    expect(
      screen.getByRole('button', { name: 'join:language.en' })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'resubmit' }))
    expect(state.resubmit).toHaveBeenCalledOnce()
    // 失败必须断言式播报(component-system §「加载、空数据与错误状态」),
    // 所以这里是 alert 而不是礼貌播报的 status。
    expect(screen.getByRole('alert')).toHaveTextContent('uncertain')
  })
  it('requires a separate unchecked choice before retaining translations', () => {
    state.canControl = true
    state.archiveAvailable = true
    state.channels = []
    show()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).not.toBeChecked()
    fireEvent.click(boxes[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'startChannel:language.zh' })
    )
    expect(state.control).toHaveBeenCalledWith('zh', 'start', true)
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { MessageInput } from './MessageInput'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

describe('MessageInput command menu', () => {
  it('stays open after a controlled draft update and disables send', () => {
    const ControlledInput = () => {
      const [draft, setDraft] = useState('')
      return (
        <MessageInput
          initialText={draft}
          onDraftChange={setDraft}
          onSend={vi.fn()}
        />
      )
    }

    render(<ControlledInput />)
    const input = screen.getByTestId('im-msg-input')

    fireEvent.change(input, { target: { value: '/' } })

    expect(screen.getByTestId('im-command-menu')).toBeInTheDocument()
    expect(screen.getByTestId('im-msg-send')).toBeDisabled()
  })

  it('closes on an outside click without deleting the draft', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const input = screen.getByTestId('im-msg-input')

    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByTestId('im-command-menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('im-command-menu')).not.toBeInTheDocument()
    expect(input).toHaveValue('/')

    fireEvent.change(input, { target: { value: '/d' } })
    expect(screen.getByTestId('im-command-menu')).toBeInTheDocument()
  })

  it('closes on blur and Escape', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const input = screen.getByTestId('im-msg-input')

    fireEvent.change(input, { target: { value: '/' } })
    fireEvent.blur(input)
    expect(screen.queryByTestId('im-command-menu')).not.toBeInTheDocument()

    fireEvent.focus(input)
    expect(screen.getByTestId('im-command-menu')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('im-command-menu')).not.toBeInTheDocument()
    expect(input).toHaveValue('/')
  })
})

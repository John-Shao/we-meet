import { fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { RoomMessageComposer } from './RoomMessageComposer'

const renderComposer = (
  overrides: Partial<ComponentProps<typeof RoomMessageComposer>> = {}
) => {
  const onSubmit = vi.fn()
  render(
    <RoomMessageComposer
      inputRef={createRef<HTMLTextAreaElement>()}
      onSubmit={onSubmit}
      placeholder="Write a message"
      inputLabel="Message"
      sendLabel="Send"
      sendingLabel="Sending"
      isSending={false}
      {...overrides}
    />
  )
  return { onSubmit }
}

describe('RoomMessageComposer', () => {
  it('submits with Enter, preserves Shift+Enter, and clears the draft', () => {
    const { onSubmit } = renderComposer()
    const input = screen.getByRole('textbox', { name: 'Message' })
    const send = screen.getByRole('button', { name: 'Send' })

    expect(send).toBeDisabled()
    fireEvent.change(input, { target: { value: 'Hello' } })
    expect(send).toBeEnabled()

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('Hello')
    expect(input).toHaveValue('')
  })

  it('disables the input and exposes the sending label while busy', () => {
    renderComposer({ isSending: true, disabled: true })

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sending' })).toBeDisabled()
  })
})

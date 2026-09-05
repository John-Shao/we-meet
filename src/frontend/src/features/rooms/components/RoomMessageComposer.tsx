import { RiSendPlane2Fill } from '@remixicon/react'
import { useEffect, useState, type RefObject } from 'react'

import { IconButton, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'
import { HStack } from '@/styled-system/jsx'

const MAX_ROWS = 6

interface RoomMessageComposerProps {
  inputRef: RefObject<HTMLTextAreaElement>
  onSubmit: (text: string) => void
  placeholder: string
  inputLabel: string
  sendLabel: string
  sendingLabel: string
  isSending: boolean
  disabled?: boolean
  maxLength?: number
  inputDataAttr?: string
  sendDataAttr?: string
}

/** Shared meeting-side composer used by room chat and meeting AI. */
export const RoomMessageComposer = ({
  inputRef,
  onSubmit,
  placeholder,
  inputLabel,
  sendLabel,
  sendingLabel,
  isSending,
  disabled = false,
  maxLength = 2000,
  inputDataAttr,
  sendDataAttr,
}: RoomMessageComposerProps) => {
  const [text, setText] = useState('')
  const [rows, setRows] = useState(1)
  const submitDisabled = disabled || isSending || !text.trim()

  const handleSubmit = () => {
    if (submitDisabled) return
    onSubmit(text)
    setText('')
  }

  useEffect(() => {
    const textArea = inputRef.current
    if (!textArea) return

    const textAreaLineHeight = 20
    const previousRows = textArea.rows
    textArea.rows = 1

    const currentRows = Math.floor(textArea.scrollHeight / textAreaLineHeight)
    if (currentRows === previousRows) textArea.rows = currentRows

    const nextRows = Math.min(currentRows, MAX_ROWS)
    if (currentRows >= MAX_ROWS) {
      textArea.rows = MAX_ROWS
      textArea.scrollTop = textArea.scrollHeight
    }
    textArea.style.overflowY = currentRows < MAX_ROWS ? 'hidden' : 'auto'
    setRows(nextRows)
  }, [text, inputRef])

  return (
    <HStack className={composerStyle}>
      <TextArea
        ref={inputRef}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          handleSubmit()
        }}
        onKeyUp={(event) => event.stopPropagation()}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={rows || 1}
        style={{
          border: 'none',
          resize: 'none',
          height: 'auto',
          overflowY: 'hidden',
        }}
        placeholderStyle="strong"
        spellCheck={false}
        maxLength={maxLength}
        aria-label={inputLabel}
        disabled={disabled}
        data-attr={inputDataAttr}
      />
      <IconButton
        label={isSending ? sendingLabel : sendLabel}
        variant="tertiaryText"
        size="icon32"
        onPress={handleSubmit}
        isDisabled={submitDisabled}
        data-attr={sendDataAttr}
      >
        <RiSendPlane2Fill aria-hidden="true" />
      </IconButton>
    </HStack>
  )
}

const composerStyle = css({
  marginTop: 'md',
  marginBottom: 'xl',
  padding: 'sm',
  backgroundColor: 'surface.canvas',
  borderRadius: 'control',
})

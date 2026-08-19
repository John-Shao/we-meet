import { useEffect, useRef, useState, KeyboardEvent } from 'react'

import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

import { useRoomAI, RoomAIMessage } from '../hooks/useRoomAI'

const containerStyle = css({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  overflow: 'hidden',
  padding: '0 1rem 1rem',
})

const messagesStyle = css({
  flexGrow: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  paddingTop: '0.75rem',
  paddingBottom: '0.5rem',
})

const bubbleBase = css({
  maxWidth: '90%',
  padding: '0.5rem 0.75rem',
  borderRadius: '12px',
  fontSize: '0.875rem',
  lineHeight: 1.45,
  wordBreak: 'break-word',
})

const userBubble = css({
  alignSelf: 'flex-end',
  backgroundColor: 'primary.100',
  color: 'primary.900',
})

const assistantBubble = css({
  alignSelf: 'flex-start',
  backgroundColor: 'box.bg',
  border: '1px solid',
  borderColor: 'box.border',
  color: 'box.text',
})

const markdownStyle = css({
  '& p': { margin: '0 0 0.4rem' },
  '& p:last-child': { marginBottom: 0 },
  '& ul, & ol': { margin: '0.25rem 0 0.25rem 1.25rem', padding: 0 },
  '& li': { marginBottom: '0.15rem' },
  '& code': {
    backgroundColor: 'box.border',
    padding: '0 0.25rem',
    borderRadius: '3px',
    fontSize: '0.85em',
  },
  '& strong': { fontWeight: 600 },
})

const hintStyle = css({
  fontSize: '0.8125rem',
  color: 'gray.600',
  textAlign: 'center',
  padding: '2rem 1rem',
})

const errorStyle = css({
  fontSize: '0.8125rem',
  color: 'red.600',
  margin: '0.5rem 0',
})

const composerStyle = css({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-end',
  borderTop: '1px solid',
  borderColor: 'box.border',
  paddingTop: '0.75rem',
})

const textareaStyle = css({
  flexGrow: 1,
  minHeight: '2.5rem',
  maxHeight: '8rem',
  padding: '0.5rem',
  borderRadius: '6px',
  border: '1px solid',
  borderColor: 'box.border',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  resize: 'none',
})

const cursorStyle = css({
  display: 'inline-block',
  width: '0.5em',
  marginLeft: '2px',
  animation: 'blink 1s steps(2) infinite',
})

const MessageBubble = ({ message }: { message: RoomAIMessage }) => {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <div className={`${bubbleBase} ${userBubble}`}>
        <span>{message.content}</span>
      </div>
    )
  }
  // Assistant: render markdown (handles partial / unfinished structures
  // gracefully) and append a blinking cursor while the stream is open.
  return (
    <div className={`${bubbleBase} ${assistantBubble}`}>
      <div className={markdownStyle}>
        <ReactMarkdown>{message.content || ''}</ReactMarkdown>
      </div>
      {message.isStreaming && <span className={cursorStyle}>▌</span>}
    </div>
  )
}

export const RoomAIPanel = () => {
  const { t } = useTranslation('room-ai')
  const { messages, ask, isAsking, error, isReady } = useRoomAI()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when a new message lands.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, isAsking])

  const submit = () => {
    const text = draft.trim()
    if (!text || isAsking) return
    setDraft('')
    void ask(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={containerStyle}>
      <div ref={scrollRef} className={messagesStyle}>
        {messages.length === 0 && !isAsking ? (
          <Text className={hintStyle}>{t('hint')}</Text>
        ) : (
          // Streaming bubbles show their own cursor while empty; no
          // need for a separate "thinking…" placeholder.
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {error && (
        <Text className={errorStyle}>
          {t('error', { message: error.message || '' })}
        </Text>
      )}

      <div className={composerStyle}>
        <textarea
          aria-label={t('inputAriaLabel')}
          className={textareaStyle}
          placeholder={t('placeholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={500}
          disabled={!isReady || isAsking}
          data-attr="room-ai-input"
        />
        <Button
          variant="primary"
          onPress={submit}
          isDisabled={!isReady || isAsking || !draft.trim()}
          data-attr="room-ai-send"
        >
          {isAsking ? t('sending') : t('send')}
        </Button>
      </div>
    </div>
  )
}

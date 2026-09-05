import { useEffect, useRef } from 'react'

import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { RoomMessageComposer } from '@/features/rooms/components/RoomMessageComposer'

import { useRoomAI, RoomAIMessage } from '../hooks/useRoomAI'

const containerStyle = css({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  overflow: 'hidden',
  paddingX: 'xl',
})

const messagesStyle = css({
  flexGrow: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  paddingTop: 'md',
  paddingBottom: 'sm',
})

const bubbleBase = css({
  maxWidth: '90%',
  paddingY: 'sm',
  paddingX: 'md',
  borderRadius: 'card',
  textStyle: 'bodyMedium',
  lineHeight: 1.45,
  wordBreak: 'break-word',
})

const userBubble = css({
  alignSelf: 'flex-end',
  backgroundColor: 'action.selected.bg',
  color: 'action.selected.text',
})

const assistantBubble = css({
  alignSelf: 'flex-start',
  backgroundColor: 'surface.default',
  border: '1px solid',
  borderColor: 'border.default',
  color: 'text.primary',
})

const markdownStyle = css({
  '& p': { margin: '0 0 0.4rem' },
  '& p:last-child': { marginBottom: 0 },
  '& ul, & ol': { margin: '0.25rem 0 0.25rem 1.25rem', padding: 0 },
  '& li': { marginBottom: '0.15rem' },
  '& code': {
    backgroundColor: 'surface.canvas',
    padding: '0 0.25rem',
    borderRadius: 'extraSmall',
    fontSize: '0.85em',
  },
  '& strong': { fontWeight: 600 },
})

const hintStyle = css({
  textStyle: 'bodySmall',
  color: 'text.secondary',
  textAlign: 'center',
  paddingY: '2xl',
  paddingX: 'lg',
})

const errorStyle = css({
  textStyle: 'bodySmall',
  color: 'status.danger',
  marginY: 'sm',
})

const cursorStyle = css({
  display: 'inline-block',
  width: '0.5em',
  marginLeft: 'xxs',
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom when a new message lands.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, isAsking])

  const submit = (draft: string) => {
    const text = draft.trim()
    if (!text || isAsking) return
    void ask(text)
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

      <RoomMessageComposer
        inputRef={inputRef}
        onSubmit={submit}
        placeholder={t('placeholder')}
        inputLabel={t('inputAriaLabel')}
        sendLabel={t('send')}
        sendingLabel={t('sending')}
        isSending={isAsking}
        disabled={!isReady || isAsking}
        maxLength={500}
        inputDataAttr="room-ai-input"
        sendDataAttr="room-ai-send"
      />
    </div>
  )
}

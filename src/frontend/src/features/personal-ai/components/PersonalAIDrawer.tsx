import { useEffect, useRef, useState, KeyboardEvent } from 'react'

import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { navigateTo } from '@/navigation/navigateTo'

import { usePersonalAI, PersonalAIMessage } from '../hooks/usePersonalAI'

const drawerStyle = css({
  width: { base: 'min(92vw, 28rem)', md: '32rem' },
  height: { base: 'min(80vh, 36rem)', md: '36rem' },
  backgroundColor: 'greyscale.000',
  borderRadius: '12px',
  boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  outline: 'none',
})

const headerStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.75rem 1rem',
  borderBottom: '1px solid',
  borderColor: 'box.border',
  fontWeight: 600,
  fontSize: '1rem',
})

const messagesStyle = css({
  flexGrow: 1,
  overflowY: 'auto',
  padding: '0.75rem 1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})

const bubbleBase = css({
  maxWidth: '92%',
  padding: '0.5rem 0.75rem',
  borderRadius: '12px',
  fontSize: '0.9rem',
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
  backgroundColor: 'greyscale.50',
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

const chipsRowStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.35rem',
  marginTop: '0.5rem',
})

const chipStyle = css({
  fontSize: '0.75rem',
  padding: '0.15rem 0.5rem',
  borderRadius: '999px',
  backgroundColor: 'primary.50',
  color: 'primary.700',
  cursor: 'pointer',
  border: 'none',
  _hover: { backgroundColor: 'primary.100' },
})

const hintStyle = css({
  fontSize: '0.85rem',
  color: 'gray.600',
  textAlign: 'left',
  padding: '0.75rem 0',
  whiteSpace: 'pre-wrap',
})

const errorStyle = css({
  fontSize: '0.8rem',
  color: 'red.600',
  margin: '0 1rem 0.25rem',
})

const composerStyle = css({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-end',
  borderTop: '1px solid',
  borderColor: 'box.border',
  padding: '0.75rem 1rem',
})

const textareaStyle = css({
  flexGrow: 1,
  minHeight: '2.5rem',
  maxHeight: '8rem',
  padding: '0.5rem',
  borderRadius: '6px',
  border: '1px solid',
  borderColor: 'box.border',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  resize: 'none',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

const cursorStyle = css({
  display: 'inline-block',
  width: '0.5em',
  marginLeft: '2px',
  animation: 'blink 1s steps(2) infinite',
})

const MessageBubble = ({
  message,
  onPickRoom,
}: {
  message: PersonalAIMessage
  onPickRoom: (roomId: string) => void
}) => {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <div className={`${bubbleBase} ${userBubble}`}>
        <span>{message.content}</span>
      </div>
    )
  }
  return (
    <div className={`${bubbleBase} ${assistantBubble}`}>
      <div className={markdownStyle}>
        <ReactMarkdown>{message.content || ''}</ReactMarkdown>
      </div>
      {message.isStreaming && <span className={cursorStyle}>▌</span>}
      {!!message.roomsReferenced?.length && (
        <div className={chipsRowStyle}>
          {message.roomsReferenced.map((r) => (
            <button
              key={r.id}
              type="button"
              className={chipStyle}
              onClick={() => onPickRoom(r.id)}
            >
              《{r.name || '未命名'}》
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const PersonalAIDrawer = ({ onClose }: { onClose?: () => void }) => {
  const { t } = useTranslation('personal-ai')
  const { messages, ask, isAsking, error } = usePersonalAI()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const pickRoom = (roomId: string) => {
    onClose?.()
    navigateTo('meetingDetail', roomId)
  }

  return (
    <div className={drawerStyle} aria-label={t('title')}>
      <div className={headerStyle}>
        <span>{t('title')}</span>
        {onClose && (
          <Button
            invisible
            variant="tertiaryText"
            size="xs"
            onPress={onClose}
            aria-label={t('close')}
          >
            ✕
          </Button>
        )}
      </div>

      <div ref={scrollRef} className={messagesStyle}>
        {messages.length === 0 && !isAsking ? (
          <Text className={hintStyle}>{t('hint')}</Text>
        ) : (
          // Streaming bubbles render their own blinking cursor while
          // empty / mid-stream; no separate "thinking…" placeholder.
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} onPickRoom={pickRoom} />
          ))
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
          disabled={isAsking}
          data-attr="personal-ai-input"
        />
        <Button
          variant="primary"
          onPress={submit}
          isDisabled={isAsking || !draft.trim()}
          data-attr="personal-ai-send"
        >
          {isAsking ? t('sending') : t('send')}
        </Button>
      </div>
    </div>
  )
}

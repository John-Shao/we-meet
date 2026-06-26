import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

interface Props {
  message: Message
  isOwn: boolean
  /** Resolved display name of the sender (group chats); falls back to uid. */
  senderName?: string
  /** Show the sender name + avatar (group, non-own). Direct chats pass false. */
  showSender?: boolean
}

// Deterministic avatar tint from a string, so the same person keeps one colour.
const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2']
const tintFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

export const MessageItem = ({ message, isOwn, senderName, showSender }: Props) => {
  // System messages (member joined/left, rename) render centered + muted, no bubble.
  if (message.content_type === 'system') {
    return (
      <div
        className={css({
          display: 'flex',
          justifyContent: 'center',
          paddingX: '1rem',
          paddingY: '0.375rem',
        })}
        data-testid="im-msg-system"
      >
        <span
          className={css({
            fontSize: '0.75rem',
            color: 'greyscale.500',
            backgroundColor: 'greyscale.100',
            borderRadius: '0.5rem',
            paddingX: '0.625rem',
            paddingY: '0.25rem',
            maxWidth: '80%',
            textAlign: 'center',
          })}
        >
          {message.body}
        </span>
      </div>
    )
  }

  const name = senderName || message.sender_uid

  return (
    <div
      className={css({
        display: 'flex',
        gap: '0.5rem',
        justifyContent: isOwn ? 'flex-end' : 'flex-start',
        paddingX: '1rem',
        paddingY: '0.25rem',
      })}
      data-testid="im-msg"
    >
      {!isOwn && showSender && (
        <span
          aria-hidden="true"
          className={css({
            flexShrink: 0,
            width: '2rem',
            height: '2rem',
            borderRadius: '999px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: '0.8125rem',
            fontWeight: 'bold',
            marginTop: '1.125rem',
          })}
          style={{ backgroundColor: tintFor(name) }}
        >
          {initial(name)}
        </span>
      )}
      <div
        className={css({
          maxWidth: '70%',
          paddingX: '0.75rem',
          paddingY: '0.5rem',
          borderRadius: '0.75rem',
          backgroundColor: isOwn ? 'primary.500' : 'greyscale.100',
          color: isOwn ? 'white' : 'greyscale.900',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        })}
      >
        {!isOwn && showSender && (
          <div
            className={css({
              fontSize: '0.75rem',
              color: 'greyscale.600',
              marginBottom: '0.125rem',
            })}
          >
            {name}
          </div>
        )}
        <div>{message.body}</div>
        <div
          className={css({
            marginTop: '0.25rem',
            fontSize: '0.6875rem',
            opacity: 0.7,
            textAlign: 'right',
          })}
        >
          {new Date(message.ts).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

interface Props {
  message: Message
  isOwn: boolean
}

export const MessageItem = ({ message, isOwn }: Props) => (
  <div
    className={css({
      display: 'flex',
      justifyContent: isOwn ? 'flex-end' : 'flex-start',
      paddingX: '1rem',
      paddingY: '0.25rem',
    })}
    data-testid="im-msg"
  >
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
      {!isOwn && (
        <div
          className={css({
            fontSize: '0.75rem',
            color: 'greyscale.600',
            marginBottom: '0.125rem',
          })}
        >
          {message.sender_uid}
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

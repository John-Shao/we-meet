import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

interface Props {
  message: Message
  isOwn: boolean
  /** Resolved display name of the sender (group chats); falls back to uid. */
  senderName?: string
  /** Uploaded avatar URL of the sender (presigned); '' / undefined → tinted initial. */
  senderAvatarUrl?: string
  /** Presigned URL for an image message (content_type='image'); undefined while resolving. */
  imageUrl?: string
  /** This message has been recalled (a tombstone targets it) → render placeholder. */
  recalled?: boolean
  /** Recall this message (own + recent). Omitted → no recall affordance. */
  onRecall?: (message: Message) => void
  /** Show the sender name + avatar (group, non-own). Direct chats pass false. */
  showSender?: boolean
  /** Names highlightable as @mentions in the body (members + 所有人). */
  mentionNames?: string[]
  /** Subset of mentionNames that mean "you" (self name + 所有人) → stronger style. */
  selfMentionNames?: string[]
}

// Render a message body with @mention tokens highlighted. Matches "@<name>" for
// any known name (longest-first to avoid partial matches); self-mentions (your
// name / 所有人) get an amber pill, others a bold tint.
const renderBody = (
  body: string,
  names: string[],
  selfNames: string[],
  isOwn: boolean,
): ReactNode => {
  if (names.length === 0 || !body.includes('@')) return body
  const sorted = [...names].sort((a, b) => b.length - a.length)
  const out: ReactNode[] = []
  let buf = ''
  let i = 0
  const flush = () => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }
  while (i < body.length) {
    if (body[i] === '@') {
      const rest = body.slice(i + 1)
      const hit = sorted.find((n) => n && rest.startsWith(n))
      if (hit) {
        flush()
        const isSelf = selfNames.includes(hit)
        out.push(
          <span
            key={i}
            style={
              isSelf
                ? { backgroundColor: '#fde68a', color: '#92400e', borderRadius: '3px', padding: '0 2px', fontWeight: 700 }
                : { fontWeight: 700, color: isOwn ? '#dbeafe' : '#2563eb' }
            }
          >
            @{hit}
          </span>,
        )
        i += 1 + hit.length
        continue
      }
    }
    buf += body[i]
    i += 1
  }
  flush()
  return out
}

// Deterministic avatar tint from a string, so the same person keeps one colour.
const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2']
const tintFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

// Recall is allowed only on your own messages within this window (WeChat: 2 min).
const RECALL_WINDOW_MS = 2 * 60 * 1000

export const MessageItem = ({
  message,
  isOwn,
  senderName,
  senderAvatarUrl,
  imageUrl,
  recalled,
  onRecall,
  showSender,
  mentionNames = [],
  selfMentionNames = [],
}: Props) => {
  const { t } = useTranslation('im')
  const isImage = message.content_type === 'image'
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

  // Recalled message → centered muted placeholder (the tombstone itself is
  // filtered out upstream; this is the ORIGINAL message rendered as recalled).
  if (recalled) {
    const text = isOwn
      ? t('recalled.self')
      : showSender
        ? t('recalled.otherNamed', { name })
        : t('recalled.other')
    return (
      <div
        className={css({
          display: 'flex',
          justifyContent: 'center',
          paddingX: '1rem',
          paddingY: '0.375rem',
        })}
        data-testid="im-msg-recalled"
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
          {text}
        </span>
      </div>
    )
  }

  const canRecall =
    !!onRecall &&
    isOwn &&
    message.content_type !== 'system' &&
    Date.now() - message.ts < RECALL_WINDOW_MS

  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        justifyContent: isOwn ? 'flex-end' : 'flex-start',
        paddingX: '1rem',
        paddingY: '0.25rem',
        _hover: { '& [data-role=recall]': { opacity: 1 } },
      })}
      data-testid="im-msg"
    >
      {canRecall && (
        <button
          type="button"
          data-role="recall"
          onClick={() => onRecall?.(message)}
          title={t('actions.recall')}
          aria-label={t('actions.recall')}
          data-testid="im-msg-recall"
          className={css({
            flexShrink: 0,
            order: -1, // sit left of the (right-aligned) own bubble
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.375rem',
            backgroundColor: 'white',
            color: 'greyscale.600',
            fontSize: '0.75rem',
            paddingX: '0.5rem',
            paddingY: '0.1875rem',
            cursor: 'pointer',
            opacity: 0,
            transition: 'opacity 0.15s',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          {t('actions.recall')}
        </button>
      )}
      {!isOwn && showSender && (
        senderAvatarUrl ? (
          <img
            src={senderAvatarUrl}
            alt=""
            aria-hidden="true"
            className={css({
              flexShrink: 0,
              width: '2rem',
              height: '2rem',
              borderRadius: '7px',
              objectFit: 'cover',
              marginTop: '1.125rem',
            })}
          />
        ) : (
          <span
            aria-hidden="true"
            className={css({
              flexShrink: 0,
              width: '2rem',
              height: '2rem',
              borderRadius: '7px',
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
        )
      )}
      <div
        className={css({
          maxWidth: '70%',
          paddingX: isImage ? '0' : '0.75rem',
          paddingY: isImage ? '0' : '0.5rem',
          borderRadius: '0.75rem',
          backgroundColor: isImage
            ? 'transparent'
            : isOwn
              ? 'primary.500'
              : 'greyscale.100',
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
        {isImage ? (
          imageUrl ? (
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={css({ display: 'block' })}
            >
              <img
                src={imageUrl}
                alt={t('image.alt')}
                className={css({
                  display: 'block',
                  maxWidth: '15rem',
                  maxHeight: '20rem',
                  borderRadius: '0.75rem',
                  objectFit: 'contain',
                  cursor: 'pointer',
                })}
              />
            </a>
          ) : (
            // Resolving / expired presign — neutral placeholder box.
            <div
              className={css({
                width: '10rem',
                height: '7.5rem',
                borderRadius: '0.75rem',
                backgroundColor: 'greyscale.100',
              })}
            />
          )
        ) : (
          <div>{renderBody(message.body, mentionNames, selfMentionNames, isOwn)}</div>
        )}
        <div
          className={css({
            marginTop: '0.25rem',
            fontSize: '0.6875rem',
            opacity: 0.7,
            textAlign: 'right',
            color: isImage ? 'greyscale.500' : undefined,
          })}
        >
          {new Date(message.ts).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

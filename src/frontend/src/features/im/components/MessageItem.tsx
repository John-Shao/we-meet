import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RiFile2Line, RiPlayMiniFill, RiPauseMiniFill } from '@remixicon/react'
import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { Avatar } from './Avatar'

/** One aggregated reaction chip under a message. */
export interface ReactionChip {
  emoji: string
  count: number
  /** The current user is among the reactors → highlight + toggle-off on click. */
  mine: boolean
  /** Reactor display label (飞书式:emoji + 名字),few names joined, else count. */
  label: string
}

interface Props {
  message: Message
  isOwn: boolean
  /** Resolved display name of the sender (group chats); falls back to uid. */
  senderName?: string
  /** Uploaded avatar URL of the sender (presigned); '' / undefined → tinted initial. */
  senderAvatarUrl?: string
  /** Presigned URL for an image message (content_type='image'); undefined while resolving. */
  imageUrl?: string
  /** Presigned URL for a file message (content_type='file'); undefined while resolving. */
  fileUrl?: string
  /** Presigned URL for a voice message (content_type='voice'); undefined while resolving. */
  voiceUrl?: string
  /** Voice clip duration in ms (from the message body). */
  voiceDurationMs?: number
  /** Aggregated reactions for this message (P7-b); empty → none rendered. */
  reactions?: ReactionChip[]
  /** Toggle a reaction emoji on this message. */
  onReact?: (emoji: string) => void
  /** This message has been recalled (a tombstone targets it) → render placeholder. */
  recalled?: boolean
  /** Right-click on the message row (opens the caller's context menu). */
  onContextMenu?: (e: React.MouseEvent) => void
  /** Click an image message → open the conversation lightbox at this image. */
  onImageClick?: () => void
  /** Show the sender name + avatar (group, non-own). Direct chats pass false. */
  showSender?: boolean
  /** Names highlightable as @mentions in the body (members + 所有人). */
  mentionNames?: string[]
  /** Subset of mentionNames that mean "you" (self name + 所有人) → stronger style. */
  selfMentionNames?: string[]
}

/** Voice message bubble: play/pause + duration; width scales with length. */
const VoiceBubble = ({
  url,
  durationMs,
  isOwn,
}: {
  url?: string
  durationMs?: number
  isOwn: boolean
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const seconds = Math.max(1, Math.round((durationMs || 0) / 1000))
  // 气泡宽度随时长增长(微信风格):1s≈5rem,60s 封顶 ~15rem。
  const width = `${Math.min(15, 5 + Math.min(seconds, 60) * (10 / 60))}rem`
  const toggle = () => {
    const el = audioRef.current
    if (!el || !url) return
    if (playing) el.pause()
    else void el.play()
  }
  return (
    <span
      className={css({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        minWidth: '5rem',
        maxWidth: '100%',
      })}
      style={{ width }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label="play"
        disabled={!url}
        className={css({
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.75rem',
          height: '1.75rem',
          borderRadius: '999px',
          border: 'none',
          cursor: url ? 'pointer' : 'default',
          color: 'inherit',
          backgroundColor: isOwn ? 'rgba(255,255,255,0.22)' : 'greyscale.200',
        })}
      >
        {playing ? <RiPauseMiniFill size={18} /> : <RiPlayMiniFill size={18} />}
      </button>
      <span
        aria-hidden="true"
        className={css({
          flex: 1,
          height: '3px',
          borderRadius: '999px',
          backgroundColor: isOwn ? 'rgba(255,255,255,0.5)' : 'greyscale.300',
        })}
      />
      <span className={css({ fontSize: '0.75rem', opacity: 0.8 })}>
        {seconds}&quot;
      </span>
      {url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={audioRef}
          src={url}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </span>
  )
}

/** Human-readable byte size for file cards. */
const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

interface FileBody {
  key: string
  name: string
  size: number
}
interface QuoteBody {
  reply_to?: { sender?: string; snippet?: string }
  text?: string
}
const parseJsonBody = <T,>(body: string): T | null => {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
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

export const MessageItem = ({
  message,
  isOwn,
  senderName,
  senderAvatarUrl,
  imageUrl,
  fileUrl,
  voiceUrl,
  voiceDurationMs,
  reactions = [],
  onReact,
  recalled,
  onContextMenu,
  onImageClick,
  showSender,
  mentionNames = [],
  selfMentionNames = [],
}: Props) => {
  const { t } = useTranslation('im')
  const isImage = message.content_type === 'image'
  const isFile = message.content_type === 'file'
  const isVoice = message.content_type === 'voice'
  const isQuote = message.content_type === 'quote'
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

  return (
    <div
      onContextMenu={onContextMenu}
      className={css({
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.5rem',
        justifyContent: isOwn ? 'flex-end' : 'flex-start',
        paddingX: '1rem',
        paddingY: '0.25rem',
      })}
      data-testid="im-msg"
    >
      {/* 接收消息(群聊):左侧发送人头像 */}
      {!isOwn && showSender && (
        <Avatar name={name} src={senderAvatarUrl} size="2rem" />
      )}
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '70%',
          alignItems: isOwn ? 'flex-end' : 'flex-start',
        })}
      >
        {!isOwn && showSender && (
          <div
            className={css({
              fontSize: '0.75rem',
              color: 'greyscale.600',
              marginBottom: '0.25rem',
              paddingX: '0.25rem',
            })}
          >
            {name}
          </div>
        )}
        <div
          title={new Date(message.ts).toLocaleString()}
          className={css({
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
            maxWidth: '100%',
          })}
        >
          {isImage ? (
            imageUrl ? (
              <button
                type="button"
                onClick={onImageClick}
                className={css({
                  display: 'block',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'zoom-in',
                })}
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
                  })}
                />
              </button>
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
          ) : isFile ? (
            (() => {
              const meta = parseJsonBody<FileBody>(message.body)
              const fname = meta?.name || 'file'
              const fsize = meta?.size ? formatBytes(meta.size) : ''
              const inner = (
                <span
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    minWidth: '12rem',
                    maxWidth: '16rem',
                  })}
                >
                  <RiFile2Line size={28} style={{ flexShrink: 0 }} />
                  <span className={css({ minWidth: 0 })}>
                    <span
                      className={css({
                        display: 'block',
                        fontSize: '0.875rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {fname}
                    </span>
                    {fsize && (
                      <span
                        className={css({ fontSize: '0.6875rem', opacity: 0.7 })}
                      >
                        {fsize}
                      </span>
                    )}
                  </span>
                </span>
              )
              return fileUrl ? (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={fname}
                  className={css({ color: 'inherit', textDecoration: 'none' })}
                >
                  {inner}
                </a>
              ) : (
                inner
              )
            })()
          ) : isVoice ? (
            <VoiceBubble
              url={voiceUrl}
              durationMs={voiceDurationMs}
              isOwn={isOwn}
            />
          ) : isQuote ? (
            (() => {
              const q = parseJsonBody<QuoteBody>(message.body)
              return (
                <>
                  <div
                    className={css({
                      borderLeft: '3px solid',
                      borderColor: isOwn
                        ? 'rgba(255,255,255,0.5)'
                        : 'greyscale.300',
                      paddingLeft: '0.5rem',
                      marginBottom: '0.25rem',
                      fontSize: '0.75rem',
                      opacity: 0.85,
                    })}
                  >
                    {q?.reply_to?.sender ? `${q.reply_to.sender}: ` : ''}
                    {q?.reply_to?.snippet || ''}
                  </div>
                  <div>
                    {renderBody(
                      q?.text || '',
                      mentionNames,
                      selfMentionNames,
                      isOwn
                    )}
                  </div>
                </>
              )
            })()
          ) : (
            <div>
              {renderBody(message.body, mentionNames, selfMentionNames, isOwn)}
            </div>
          )}
        </div>
        {reactions.length > 0 && (
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.25rem',
              marginTop: '0.25rem',
            })}
          >
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReact?.(r.emoji)}
                data-testid={`reaction-${r.emoji}`}
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  maxWidth: '14rem',
                  paddingX: '0.5rem',
                  paddingY: '0.125rem',
                  borderRadius: '999px',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  border: '1px solid',
                  borderColor: r.mine ? 'primary.300' : 'greyscale.200',
                  backgroundColor: r.mine ? 'primary.50' : 'greyscale.50',
                  color: r.mine ? 'primary.700' : 'greyscale.600',
                  _hover: { backgroundColor: r.mine ? 'primary.100' : 'greyscale.100' },
                })}
              >
                <span>{r.emoji}</span>
                <span
                  className={css({
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  })}
                >
                  {r.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 自己发的消息(一对一 + 群聊):右侧自己头像,不显示名字 */}
      {isOwn && <Avatar name={name} src={senderAvatarUrl} size="2rem" />}
    </div>
  )
}

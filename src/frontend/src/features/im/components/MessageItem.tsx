import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiFile2Line,
  RiPlayMiniFill,
  RiPauseMiniFill,
  RiChat3Line,
  RiPhoneLine,
  RiVidiconLine,
} from '@remixicon/react'
import type { Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { SenderLabel } from './SenderLabel'
import { RichTextBody } from './RichTextBody'
import { RichCardMessage } from './RichCardMessage'
import type { CardState } from '../api/cardStates'

import { Avatar } from './Avatar'
import { DocCardMessage } from './DocCardMessage'
import { CalendarCardMessage } from './CalendarCardMessage'
import { EventCardMessage } from './EventCardMessage'
import { MeetingCardMessage } from './MeetingCardMessage'
import { IM_SYSTEM_UID } from './eventCard'
import type { MergedBody } from './MergedRecordDialog'

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
  /**
   * Set when the sender is a group bot: renders the 「机器人」chip and the
   * description subtitle next to the name. A JSX marking, never a suffix on the
   * name string — see SenderLabel.
   */
  senderBot?: { description?: string }
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
  /** Open a merged chat-record (content_type='merged') → viewer dialog. */
  onMergedClick?: () => void
  /** P8 日程卡片:点「查看」打开日程详情(content_type='event-card')。 */
  onOpenEvent?: (eventId: string) => void
  /** 分享云文档卡片:点「查看文档」跳转到该文档(content_type='doc-card')。 */
  onOpenDoc?: (card: { doc_id: string; url: string }) => void
  /** P4.1 群语音卡片:点「加入」进入进行中的语音宫格(content_type='group-call')。 */
  onJoinGroupCall?: () => void
  /** P4.1 群语音卡片:该场通话已结束(同流存在同 slug 的结束记录)→ 灰态不可点。 */
  groupCallEnded?: boolean
  /** 多选模式(合并/逐条转发):渲染左侧勾选框,整行点击切换选中。 */
  selectMode?: boolean
  /** This message is currently selected in multi-select mode. */
  selected?: boolean
  /** Toggle this message's selection (multi-select mode). */
  onToggleSelect?: () => void
  /** Show the sender name + avatar (group, non-own). Direct chats pass false. */
  showSender?: boolean
  /** Names highlightable as @mentions in the body (members + 所有人). */
  mentionNames?: string[]
  /** Subset of mentionNames that mean "you" (self name + 所有人) → stronger style. */
  selfMentionNames?: string[]
  /** 卡片按钮的叠加层(A2)。只有 rich-card 用得上。 */
  cardState?: CardState
  /** 点一个 callback 按钮。缺省 = 按钮渲染成禁用态。 */
  onCardButton?: (buttonId: string) => void
  /**
   * 已读回执(P13):仅对自己发的、当前会话最新一条消息传入。direct→已读/未读;
   * group→N 人已读(clickable=true 时可点开名单)。undefined→不显示。
   */
  readReceipt?: {
    label: string
    clickable?: boolean
    onClick?: () => void
  }
  /** Click the sender's avatar → navigate to their personal info page. */
  onAvatarClick?: () => void
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
  isOwn: boolean
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
                ? {
                    backgroundColor: '#fde68a',
                    color: '#92400e',
                    borderRadius: '3px',
                    padding: '0 2px',
                    fontWeight: 700,
                  }
                : { fontWeight: 700, color: isOwn ? '#dbeafe' : '#2563eb' }
            }
          >
            @{hit}
          </span>
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

/** 通话时长 mm:ss (h:mm:ss beyond an hour) for completed call-log rows. */
const formatCallDuration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

export const MessageItem = ({
  message,
  isOwn,
  senderName,
  senderAvatarUrl,
  senderBot,
  imageUrl,
  fileUrl,
  voiceUrl,
  voiceDurationMs,
  reactions = [],
  onReact,
  recalled,
  onContextMenu,
  onImageClick,
  onMergedClick,
  onOpenEvent,
  onOpenDoc,
  onJoinGroupCall,
  groupCallEnded,
  selectMode,
  selected,
  onToggleSelect,
  showSender,
  mentionNames = [],
  selfMentionNames = [],
  cardState,
  onCardButton,
  readReceipt,
  onAvatarClick,
}: Props) => {
  const { t } = useTranslation('im')
  const isImage = message.content_type === 'image'
  const isCustomEmoji = isImage && message.body.startsWith('emoji/')
  const isFile = message.content_type === 'file'
  const isVoice = message.content_type === 'voice'
  const isQuote = message.content_type === 'quote'
  const isMerged = message.content_type === 'merged'
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

  // P3 手机号被查看提示 (phone-viewed) → centered muted notice, like system but
  // perspective-aware: the SENDER is the viewer, so isOwn ⇒ 「你查看了对方的手机
  // 号码」, incoming ⇒ 「对方查看了你的手机号码」(shown to the number's owner).
  if (message.content_type === 'phone-viewed') {
    return (
      <div
        className={css({
          display: 'flex',
          justifyContent: 'center',
          paddingX: '1rem',
          paddingY: '0.375rem',
        })}
        data-testid="im-msg-phone-viewed"
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
          {isOwn ? t('phoneViewed.byMe') : t('phoneViewed.byPeer')}
        </span>
      </div>
    )
  }

  // P4.1 群语音「进行中」卡片 (body = {"slug","media"}) — every member (rung
  // or not, joined later or not) can tap to join the live grid. Once the
  // group's end-record (call-log carrying the same slug) exists downstream,
  // the card renders as ended; a stale "ongoing" card (end-record outside the
  // loaded window) is caught at join time by the room resolve.
  if (message.content_type === 'group-call') {
    const ended = groupCallEnded ?? false
    return (
      <div
        className={css({
          display: 'flex',
          justifyContent: 'center',
          paddingX: '1rem',
          paddingY: '0.375rem',
        })}
        data-testid="im-msg-groupcall"
      >
        <button
          type="button"
          disabled={ended || !onJoinGroupCall}
          onClick={onJoinGroupCall}
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.875rem',
            color: 'greyscale.700',
            backgroundColor: 'greyscale.100',
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '0.75rem',
            paddingX: '0.875rem',
            paddingY: '0.5rem',
            cursor: 'pointer',
            _disabled: { cursor: 'default', opacity: 0.7 },
            _hover: { backgroundColor: 'greyscale.200' },
          })}
        >
          <RiPhoneLine size={16} />
          {t('call.groupCard.title')}
          {' · '}
          {ended ? t('call.groupCard.ended') : t('call.groupCard.ongoing')}
          {!ended && (
            <span
              className={css({
                color: 'primary.600',
                fontWeight: 'medium',
              })}
            >
              {t('call.groupCard.join')}
            </span>
          )}
        </button>
      </div>
    )
  }

  // P1 一对一通话 call-log (body = {"media","result","duration"?}) →
  // bubble-less phone row, mirroring the Android bubble.
  //
  // Perspective-aware wording: the call-log's SENDER is always the caller, so
  // isOwn means "I placed this call". The same declined record must read
  // 「对方已拒绝」 to the caller but 「已拒绝」 to the callee who tapped it.
  // Completed calls render the duration instead — identical on both sides.
  if (message.content_type === 'call-log') {
    let media = 'audio'
    let result = 'missed'
    let duration = 0
    let isMeetInvite = false
    try {
      const parsed = JSON.parse(message.body) as {
        media?: string
        result?: string
        duration?: number
        kind?: string
      }
      media = parsed.media ?? media
      result = parsed.result ?? result
      duration = parsed.duration ?? 0
      // P4-M3: kind:'meet' = 未接通的会议邀请记录,渲染为「会议邀请 · x」
      // 而非未接来电(样式区分是当年允许落这条记录的前提)。
      isMeetInvite = parsed.kind === 'meet'
    } catch {
      // Malformed body — fall through with defaults.
    }
    const base = [
      'canceled',
      'declined',
      'busy',
      'unreachable',
      'completed',
    ].includes(result)
      ? result
      : 'missed'
    const plainText =
      base === 'completed'
        ? formatCallDuration(duration)
        : t(`call.log.${base}${isOwn ? '' : 'Peer'}`)
    const resultText =
      isMeetInvite && base !== 'completed'
        ? `${t('call.log.meetInvite')} · ${plainText}`
        : plainText
    return (
      <div
        className={css({
          display: 'flex',
          justifyContent: isOwn ? 'flex-end' : 'flex-start',
          paddingX: '1rem',
          paddingY: '0.375rem',
        })}
        data-testid="im-msg-calllog"
      >
        <span
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
            color: 'greyscale.700',
            backgroundColor: 'greyscale.100',
            borderRadius: '0.75rem',
            paddingX: '0.75rem',
            paddingY: '0.5rem',
          })}
        >
          {media === 'video' ? (
            <RiVidiconLine size={16} />
          ) : (
            <RiPhoneLine size={16} />
          )}
          {t(media === 'video' ? 'call.log.video' : 'call.log.voice')}
          {' · '}
          {resultText}
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

  // P8-UX 日程卡片:组织者创建卡 = 正常消息行(头像/名字/对齐,可右键转发);
  // 后端 SYSTEM 注入的变更/取消卡 = 居中系统样式。作为 row 参与下方的
  // selectMode 包装 → 多选合并/逐条转发同样可用。
  const row =
    message.content_type === 'meeting-card' ? (
      <MeetingCardMessage
        body={message.body}
        isOwn={isOwn}
        senderName={name}
        senderBot={senderBot}
        senderAvatarUrl={senderAvatarUrl}
        showSender={showSender}
        onAvatarClick={onAvatarClick}
        onContextMenu={onContextMenu}
      />
    ) : message.content_type === 'event-card' ? (
      <EventCardMessage
        body={message.body}
        isOwn={isOwn}
        senderName={name}
        senderBot={senderBot}
        senderAvatarUrl={senderAvatarUrl}
        showSender={showSender}
        system={message.sender_uid === IM_SYSTEM_UID}
        onAvatarClick={onAvatarClick}
        onContextMenu={onContextMenu}
        onOpen={onOpenEvent}
      />
    ) : message.content_type === 'calendar-card' ? (
      <CalendarCardMessage
        body={message.body}
        isOwn={isOwn}
        senderName={name}
        senderBot={senderBot}
        senderAvatarUrl={senderAvatarUrl}
        showSender={showSender}
        onAvatarClick={onAvatarClick}
        onContextMenu={onContextMenu}
      />
    ) : message.content_type === 'doc-card' ? (
      <DocCardMessage
        body={message.body}
        isOwn={isOwn}
        senderName={name}
        senderBot={senderBot}
        senderAvatarUrl={senderAvatarUrl}
        showSender={showSender}
        onAvatarClick={onAvatarClick}
        onContextMenu={onContextMenu}
        onOpen={onOpenDoc}
      />
    ) : (
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
        {/* 接收消息(一对一 + 群聊):左侧对方头像(对齐企业微信/微信;
          发送人名字仅群聊显示,见下方 showSender 分支) */}
        {!isOwn && (
          <button
            type="button"
            disabled={!onAvatarClick}
            aria-label={name}
            onClick={onAvatarClick}
            className={css({
              cursor: onAvatarClick ? 'pointer' : 'default',
              flexShrink: 0,
              padding: 0,
              border: 0,
              background: 'transparent',
            })}
          >
            <Avatar name={name} src={senderAvatarUrl} size="2rem" />
          </button>
        )}
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            maxWidth: '70%',
            alignItems: isOwn ? 'flex-end' : 'flex-start',
          })}
        >
          {!isOwn && showSender && <SenderLabel name={name} bot={senderBot} />}
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
                    alt={
                      isCustomEmoji
                        ? t('preview.emoji', { defaultValue: '表情' })
                        : t('image.alt')
                    }
                    className={css({
                      display: 'block',
                      maxWidth: isCustomEmoji ? '6rem' : '15rem',
                      maxHeight: isCustomEmoji ? '6rem' : '20rem',
                      borderRadius: isCustomEmoji ? '0.25rem' : '0.75rem',
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
                          className={css({
                            fontSize: '0.6875rem',
                            opacity: 0.7,
                          })}
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
                    className={css({
                      color: 'inherit',
                      textDecoration: 'none',
                    })}
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
            ) : isMerged ? (
              (() => {
                const rec = parseJsonBody<MergedBody>(message.body)
                const lines = rec?.items?.slice(0, 3) ?? []
                return (
                  <button
                    type="button"
                    onClick={onMergedClick}
                    data-testid="im-merged-card"
                    className={css({
                      display: 'block',
                      width: '15rem',
                      maxWidth: '100%',
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: 'inherit',
                    })}
                  >
                    <span
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        fontSize: '0.8125rem',
                        fontWeight: 'medium',
                        opacity: 0.9,
                        marginBottom: '0.25rem',
                      })}
                    >
                      <RiChat3Line size={16} style={{ flexShrink: 0 }} />
                      {rec?.title || t('merged.card')}
                    </span>
                    {lines.map((it, i) => (
                      <span
                        key={i}
                        className={css({
                          display: 'block',
                          fontSize: '0.75rem',
                          opacity: 0.7,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        })}
                      >
                        {it.sender}: {it.text}
                      </span>
                    ))}
                    <span
                      className={css({
                        display: 'block',
                        marginTop: '0.375rem',
                        paddingTop: '0.25rem',
                        borderTop: '1px solid',
                        borderColor: isOwn
                          ? 'rgba(255,255,255,0.3)'
                          : 'greyscale.200',
                        fontSize: '0.6875rem',
                        opacity: 0.7,
                      })}
                    >
                      {t('merged.view', { count: rec?.count ?? lines.length })}
                    </span>
                  </button>
                )
              })()
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
            ) : message.content_type === 'rich-text' ? (
              <RichTextBody
                raw={message.body}
                isOwn={isOwn}
                selfMentionNames={selfMentionNames}
              />
            ) : message.content_type === 'rich-card' ? (
              <RichCardMessage
                raw={message.body}
                state={cardState}
                onClickButton={onCardButton}
              />
            ) : (
              <div>
                {renderBody(
                  message.body,
                  mentionNames,
                  selfMentionNames,
                  isOwn
                )}
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
                    // 「我点过」的表态用蓝调 chip;走 brand.* 才会随主题翻转,
                    // 否则深色消息流里是一颗固定亮蓝的小胶囊。
                    borderColor: r.mine ? 'brand.300' : 'greyscale.200',
                    backgroundColor: r.mine ? 'brand.50' : 'greyscale.50',
                    color: r.mine ? 'brand.700' : 'greyscale.600',
                    _hover: {
                      backgroundColor: r.mine ? 'brand.100' : 'greyscale.100',
                    },
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
          {/* 已读回执(P13):自己发的最新一条消息下方,右对齐小字。 */}
          {readReceipt &&
            (readReceipt.clickable ? (
              <button
                type="button"
                onClick={readReceipt.onClick}
                data-testid="im-read-receipt"
                className={css({
                  marginTop: '0.25rem',
                  paddingX: '0.25rem',
                  border: 'none',
                  background: 'transparent',
                  fontSize: '0.6875rem',
                  color: 'greyscale.500',
                  cursor: 'pointer',
                  _hover: { color: 'primary.500' },
                })}
              >
                {readReceipt.label}
              </button>
            ) : (
              <span
                data-testid="im-read-receipt"
                className={css({
                  marginTop: '0.25rem',
                  paddingX: '0.25rem',
                  fontSize: '0.6875rem',
                  color: 'greyscale.500',
                })}
              >
                {readReceipt.label}
              </span>
            ))}
        </div>
        {/* 自己发的消息(一对一 + 群聊):右侧自己头像,不显示名字 */}
        {isOwn && (
          <button
            type="button"
            disabled={!onAvatarClick}
            aria-label={name}
            onClick={onAvatarClick}
            className={css({
              cursor: onAvatarClick ? 'pointer' : 'default',
              flexShrink: 0,
              padding: 0,
              border: 0,
              background: 'transparent',
            })}
          >
            <Avatar name={name} src={senderAvatarUrl} size="2rem" />
          </button>
        )}
      </div>
    )

  // 多选模式(合并/逐条转发):最左侧勾选框,整行点击切换选中;内容禁用指针,
  // 避免误触图片/表情等交互(飞书式左对齐勾选列)。
  if (selectMode) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleSelect?.()
          }
        }}
        data-testid="im-msg-selectable"
        aria-pressed={!!selected}
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingLeft: '1rem',
          cursor: 'pointer',
          _hover: { backgroundColor: 'greyscale.50' },
        })}
      >
        <span
          aria-hidden="true"
          className={css({
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '1.25rem',
            height: '1.25rem',
            borderRadius: '999px',
            border: '1.5px solid',
            borderColor: selected ? 'primary.500' : 'greyscale.400',
            backgroundColor: selected ? 'primary.500' : 'transparent',
            color: 'white',
            fontSize: '0.75rem',
            lineHeight: 1,
          })}
        >
          {selected ? '✓' : ''}
        </span>
        <div className={css({ flex: 1, minWidth: 0, pointerEvents: 'none' })}>
          {row}
        </div>
      </div>
    )
  }

  return row
}

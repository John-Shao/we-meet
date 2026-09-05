import { useTranslation } from 'react-i18next'
import { RiCalendarEventLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

import { SenderLabel } from './SenderLabel'

import { Avatar } from './Avatar'
import { chatCardSize } from './chatCardSize'
import { parseEventCard, type EventCardBody } from './eventCard'

/**
 * 日程时间行:同日 →「7月21日 (周二) 10:00-11:00」;跨日 → 起止各带日期;
 * 全天 → 日期 +「全天」。时间字段坏 → null(只显标题)。
 */
const formatWhen = (
  card: EventCardBody,
  locale: string,
  allDayLabel: string
): string | null => {
  if (card.all_day && card.start_date) {
    const civilDate = (value: string) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      if (!match) return null
      const result = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
      )
      return result.getFullYear() === Number(match[1]) &&
        result.getMonth() === Number(match[2]) - 1 &&
        result.getDate() === Number(match[3])
        ? result
        : null
    }
    const first = civilDate(card.start_date)
    if (first) {
      const lastExclusive = card.end_date ? civilDate(card.end_date) : null
      const last = lastExclusive ? new Date(lastExclusive) : null
      last?.setDate(last.getDate() - 1)
      const formatDate = (value: Date) =>
        value.toLocaleDateString(locale, {
          month: 'long',
          day: 'numeric',
          weekday: 'short',
        })
      return last && last > first
        ? `${formatDate(first)} – ${formatDate(last)} ${allDayLabel}`
        : `${formatDate(first)} ${allDayLabel}`
    }
  }
  const s = new Date(card.start)
  const e = new Date(card.end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null
  const d = (x: Date) =>
    x.toLocaleDateString(locale, {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    })
  const hm = (x: Date) =>
    x.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  if (card.all_day) return `${d(s)} ${allDayLabel}`
  const sameDay = s.toDateString() === e.toDateString()
  return sameDay
    ? `${d(s)} ${hm(s)}-${hm(e)}`
    : `${d(s)} ${hm(s)} → ${d(e)} ${hm(e)}`
}

/**
 * P8 日程卡片消息(content_type='event-card')。
 *
 * P8-UX:创建卡由组织者客户端发出 → 渲染为**正常消息气泡行**(头像/名字/
 * 左右对齐,可右键转发);后端 SYSTEM 注入的变更/取消卡([system]=true)
 * 保持居中系统样式。cancelled 卡降饱和 + 标题删除线;解析失败退灰胶囊。
 */
export const EventCardMessage = ({
  body,
  isOwn = false,
  senderName,
  senderBot,
  senderAvatarUrl,
  showSender = false,
  system = false,
  onAvatarClick,
  onContextMenu,
  onOpen,
}: {
  body: string
  isOwn?: boolean
  senderName?: string
  /** Set when the sender is a group bot — chip + description. */
  senderBot?: { description?: string }
  senderAvatarUrl?: string
  /** 群聊且非自己 → 气泡上方显示发送人名字。 */
  showSender?: boolean
  /** 后端 SYSTEM 注入(变更/取消卡)→ 居中系统样式,无发送者归属。 */
  system?: boolean
  onAvatarClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onOpen?: (eventId: string) => void
}) => {
  const { t, i18n } = useTranslation('im')
  const card = parseEventCard(body)

  let cardEl: React.ReactNode
  if (!card) {
    cardEl = <span className={fallbackCls}>{t('preview.event')}</span>
  } else {
    const inactive = card.kind === 'cancelled' || card.kind === 'removed'
    const privateCard = card.visibility === 'private'
    const displayTitle = privateCard
      ? t('calendar.card.privateEvent')
      : card.title || t('preview.event')
    const badge =
      card.kind === 'invited'
        ? t('calendar.card.invited')
        : card.kind === 'time_changed'
          ? t('calendar.card.timeChanged')
          : card.kind === 'attendees_changed'
            ? t('calendar.card.attendeesChanged')
            : card.kind === 'organizer_changed'
              ? t('calendar.card.organizerChanged')
              : card.kind === 'removed'
                ? t('calendar.card.removed')
                : card.kind === 'rsvp_changed'
                  ? t('calendar.card.rsvpChanged')
                  : card.kind === 'cancelled'
                    ? t('calendar.card.cancelled')
                    : null
    const when = formatWhen(card, i18n.language, t('calendar.card.allDay'))
    const oldWhen =
      card.kind === 'time_changed' && card.old_start && card.old_end
        ? formatWhen(
            {
              ...card,
              start: card.old_start,
              end: card.old_end,
              start_date: card.old_start_date,
              end_date: card.old_end_date,
            },
            i18n.language,
            t('calendar.card.allDay')
          )
        : null
    const recurrenceScope = card.recurrence_scope
      ? t(`calendar.card.recurrenceScope.${card.recurrence_scope}`)
      : null
    const rsvpReply =
      card.kind === 'rsvp_changed' && card.responder_name && card.rsvp_status
        ? t('calendar.card.rsvpReply', {
            name: card.responder_name,
            status: t(`calendar.card.rsvp.${card.rsvp_status}`),
          })
        : null
    const clickable = !!card.event_id && !!onOpen

    cardEl = (
      <button
        type="button"
        disabled={!clickable}
        onClick={() => onOpen?.(card.event_id)}
        className={`${chatCardSize({ size: 'standard' })} ${css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '0.25rem',
          textAlign: 'left',
          backgroundColor: 'greyscale.000',
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '0.75rem',
          paddingX: '0.875rem',
          paddingY: '0.625rem',
          cursor: 'pointer',
          _disabled: { cursor: 'default' },
          _hover: { backgroundColor: 'greyscale.50' },
        })}`}
        style={inactive ? { opacity: 0.65 } : undefined}
      >
        <span
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            color: 'greyscale.900',
          })}
        >
          <RiCalendarEventLine
            size={16}
            className={css({ flexShrink: 0, color: 'primary.600' })}
          />
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
            style={inactive ? { textDecoration: 'line-through' } : undefined}
          >
            {displayTitle}
          </span>
          {badge && (
            <span
              className={css({
                flexShrink: 0,
                fontSize: '0.6875rem',
                fontWeight: 'normal',
                color: inactive ? 'greyscale.500' : 'brand.600',
                backgroundColor: inactive ? 'greyscale.100' : 'brand.50',
                borderRadius: '0.25rem',
                paddingX: '0.25rem',
              })}
            >
              {badge}
            </span>
          )}
        </span>
        {recurrenceScope && (
          <span
            data-testid="im-msg-event-card-recurrence-scope"
            className={css({
              alignSelf: 'flex-start',
              fontSize: '0.6875rem',
              color: 'greyscale.600',
              backgroundColor: 'greyscale.100',
              borderRadius: '0.25rem',
              paddingX: '0.375rem',
            })}
          >
            {recurrenceScope}
          </span>
        )}
        {oldWhen && (
          <span
            className={css({
              fontSize: '0.75rem',
              color: 'greyscale.400',
              textDecoration: 'line-through',
            })}
          >
            {oldWhen}
          </span>
        )}
        {rsvpReply && (
          <span
            className={css({
              fontSize: '0.8125rem',
              color: 'greyscale.700',
              fontWeight: 'medium',
            })}
          >
            {rsvpReply}
          </span>
        )}
        {when && (
          <span
            className={css({ fontSize: '0.8125rem', color: 'greyscale.700' })}
          >
            {when}
          </span>
        )}
        <span
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
            fontSize: '0.75rem',
            color: 'greyscale.500',
          })}
        >
          <span>
            {!privateCard &&
              card.attendee_count != null &&
              t('calendar.card.attendees', { count: card.attendee_count })}
            {!privateCard &&
              card.attendee_count != null &&
              card.organizer_name &&
              ' · '}
            {!privateCard &&
              card.organizer_name &&
              t('calendar.card.organizer', { name: card.organizer_name })}
          </span>
          {clickable && (
            <span
              className={css({ color: 'primary.600', fontWeight: 'medium' })}
            >
              {t('calendar.card.view')}
            </span>
          )}
        </span>
      </button>
    )
  }

  // 后端 SYSTEM 注入的变更/取消通知:居中,无发送者归属。
  if (system) {
    return (
      <div className={centerRowCls} data-testid="im-msg-event-card">
        {cardEl}
      </div>
    )
  }

  // 组织者(创建者)发出:正常消息行 —— 头像/名字/左右对齐,可右键操作。
  const name = senderName || ''
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
      data-testid="im-msg-event-card"
    >
      {!isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={css({
            flexShrink: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            _disabled: { cursor: 'default' },
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
        {cardEl}
      </div>
      {/* 自己发的消息:右侧自己头像(与 MessageItem 常规气泡一致)。 */}
      {isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={css({
            flexShrink: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            _disabled: { cursor: 'default' },
          })}
        >
          <Avatar name={name} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
    </div>
  )
}

const centerRowCls = css({
  display: 'flex',
  justifyContent: 'center',
  paddingX: '1rem',
  paddingY: '0.375rem',
})
const fallbackCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  backgroundColor: 'greyscale.100',
  borderRadius: '0.5rem',
  paddingX: '0.625rem',
  paddingY: '0.25rem',
})

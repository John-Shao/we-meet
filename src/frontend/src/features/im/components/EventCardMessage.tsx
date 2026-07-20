import { useTranslation } from 'react-i18next'
import { RiCalendarEventLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

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
 * P8 日程卡片消息(content_type='event-card')。居中卡片(样式对齐
 * group-call 卡):图标 + 标题(+变更角标)、时间行、N 人参与 · 组织者、
 * 「查看」打开日程详情。cancelled 卡降饱和 + 标题删除线;解析失败退灰胶囊。
 */
export const EventCardMessage = ({
  body,
  onOpen,
}: {
  body: string
  onOpen?: (eventId: string) => void
}) => {
  const { t, i18n } = useTranslation('im')
  const card = parseEventCard(body)

  if (!card) {
    return (
      <div className={rowCls} data-testid="im-msg-event-card">
        <span className={fallbackCls}>{t('preview.event')}</span>
      </div>
    )
  }

  const cancelled = card.kind === 'cancelled'
  const badge =
    card.kind === 'time_changed'
      ? t('calendar.card.timeChanged')
      : card.kind === 'attendees_changed'
        ? t('calendar.card.attendeesChanged')
        : cancelled
          ? t('calendar.card.cancelled')
          : null
  const when = formatWhen(card, i18n.language, t('calendar.card.allDay'))
  const oldWhen =
    card.kind === 'time_changed' && card.old_start && card.old_end
      ? formatWhen(
          { ...card, start: card.old_start, end: card.old_end },
          i18n.language,
          t('calendar.card.allDay')
        )
      : null
  const clickable = !!card.event_id && !!onOpen

  return (
    <div className={rowCls} data-testid="im-msg-event-card">
      <button
        type="button"
        disabled={!clickable}
        onClick={() => onOpen?.(card.event_id)}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '0.25rem',
          minWidth: '240px',
          maxWidth: '320px',
          textAlign: 'left',
          backgroundColor: 'greyscale.000',
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '0.75rem',
          paddingX: '0.875rem',
          paddingY: '0.625rem',
          cursor: 'pointer',
          _disabled: { cursor: 'default' },
          _hover: { backgroundColor: 'greyscale.50' },
        })}
        style={cancelled ? { opacity: 0.65 } : undefined}
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
            style={cancelled ? { textDecoration: 'line-through' } : undefined}
          >
            {card.title || t('preview.event')}
          </span>
          {badge && (
            <span
              className={css({
                flexShrink: 0,
                fontSize: '0.6875rem',
                fontWeight: 'normal',
                color: cancelled ? 'greyscale.500' : 'primary.600',
                backgroundColor: cancelled ? 'greyscale.100' : 'primary.50',
                borderRadius: '0.25rem',
                paddingX: '0.25rem',
              })}
            >
              {badge}
            </span>
          )}
        </span>
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
            fontSize: '0.75rem',
            color: 'greyscale.500',
          })}
        >
          <span>
            {card.attendee_count != null &&
              t('calendar.card.attendees', { count: card.attendee_count })}
            {card.attendee_count != null && card.organizer_name && ' · '}
            {card.organizer_name &&
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
    </div>
  )
}

const rowCls = css({
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

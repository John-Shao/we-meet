import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { RiCalendarTodoFill } from '@remixicon/react'

import { css } from '@/styled-system/css'
import {
  EventDetailHost,
  reminderCountdown,
  reminderTimeRange,
  type CalendarEvent,
} from '@/features/calendar'

import {
  useReminderEntryEnabled,
  useReminderWindow,
} from '../hooks/useReminderEntry'

/**
 * P8 日程提醒页(对标飞书,中栏渲染,占 ChatPane 的位置):
 * 头部「日程提醒」+ 右上「在消息列表提醒日程」开关;最近/进行中日程横幅卡
 * (标题、时间、进入会议);今日安排 / 明日安排分组列表;点条目 →
 * EventDetailHost 详情。开关状态与置顶入口共用 localStorage。
 */
export const ReminderPane = () => {
  const { t, i18n } = useTranslation('im')
  const [, navigate] = useLocation()
  const [enabled, setEnabled] = useReminderEntryEnabled()
  // 页面本身即使开关关闭也可见(用户刚在此关掉开关时不闪退出)。
  const { today, tomorrow, nearest, now } = useReminderWindow(true)
  const [viewEventId, setViewEventId] = useState<string | null>(null)

  const fmtDay = (d: Date) =>
    d.toLocaleDateString(i18n.language, { month: 'long', day: 'numeric' })

  const banner = nearest
  const bannerCountdown = banner ? reminderCountdown(banner, now) : null

  return (
    <div
      className={css({
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      })}
      data-testid="im-reminder-pane"
    >
      {/* Header */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <span
          aria-hidden="true"
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '1.75rem',
            height: '1.75rem',
            borderRadius: '0.375rem',
            backgroundColor: '#f80',
            color: 'white',
          })}
        >
          <RiCalendarTodoFill size={16} />
        </span>
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
            flex: 1,
          })}
        >
          {t('reminder.title')}
        </h2>
        <label
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.8125rem',
            color: 'greyscale.600',
            cursor: 'pointer',
          })}
        >
          {t('reminder.toggle')}
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="reminder-toggle"
          />
        </label>
      </div>

      <div
        className={css({
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        })}
      >
        {/* 最近/进行中日程横幅卡 */}
        {banner && (
          <div
            className={css({
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.75rem',
              padding: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            })}
            data-testid="reminder-banner"
          >
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              })}
            >
              <span
                className={css({
                  fontSize: '1rem',
                  fontWeight: 'bold',
                  color: 'greyscale.900',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
              >
                {banner.title}
              </span>
              {bannerCountdown && (
                <span
                  className={css({
                    flexShrink: 0,
                    fontSize: '0.6875rem',
                    paddingX: '0.375rem',
                    paddingY: '0.0625rem',
                    borderRadius: '0.25rem',
                    backgroundColor: 'rgba(255,136,0,0.14)',
                    color: '#d97706',
                  })}
                >
                  {bannerCountdown.kind === 'now'
                    ? t('reminder.now')
                    : t('reminder.inMinutes', {
                        count: bannerCountdown.minutes,
                      })}
                </span>
              )}
            </div>
            <div
              className={css({ fontSize: '0.875rem', color: 'greyscale.700' })}
            >
              {`${fmtDay(new Date(banner.start_at))} ${
                reminderTimeRange(banner) ?? t('calendar.card.allDay')
              }`}
            </div>
            {banner.room_slug && (
              <div>
                <button
                  type="button"
                  onClick={() => navigate(`/${banner.room_slug}`)}
                  data-testid="reminder-join"
                  className={css({
                    paddingX: '0.875rem',
                    paddingY: '0.375rem',
                    border: '1px solid token(colors.primary.500)',
                    borderRadius: '0.5rem',
                    backgroundColor: 'transparent',
                    color: 'primary.600',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'primary.50' },
                  })}
                >
                  {t('reminder.join')}
                </button>
              </div>
            )}
          </div>
        )}

        {today.length === 0 && tomorrow.length === 0 && (
          <div
            className={css({
              padding: '2rem 0',
              textAlign: 'center',
              fontSize: '0.875rem',
              color: 'greyscale.500',
            })}
          >
            {t('reminder.empty')}
          </div>
        )}

        {today.length > 0 && (
          <ReminderSection
            label={t('reminder.today')}
            events={today}
            onOpen={setViewEventId}
          />
        )}
        {tomorrow.length > 0 && (
          <ReminderSection
            label={t('reminder.tomorrow')}
            events={tomorrow}
            onOpen={setViewEventId}
          />
        )}
      </div>

      {viewEventId && (
        <EventDetailHost
          eventId={viewEventId}
          onClose={() => setViewEventId(null)}
        />
      )}
    </div>
  )
}

const ReminderSection = ({
  label,
  events,
  onOpen,
}: {
  label: string
  events: CalendarEvent[]
  onOpen: (id: string) => void
}) => {
  const { t } = useTranslation('im')
  const hm = (iso: string) => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  }
  return (
    <div>
      <div
        className={css({
          fontSize: '0.875rem',
          fontWeight: 'bold',
          color: 'greyscale.900',
          marginBottom: '0.5rem',
        })}
      >
        {label}
      </div>
      <ul
        className={css({
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.375rem',
        })}
      >
        {events.map((e) => (
          <li key={e.id} className={css({ display: 'flex', gap: '0.75rem' })}>
            <span
              className={css({
                flexShrink: 0,
                width: '3rem',
                paddingTop: '0.5rem',
                fontSize: '0.8125rem',
                color: 'greyscale.600',
                textAlign: 'right',
              })}
            >
              {e.all_day ? t('calendar.card.allDay') : hm(e.start_at)}
            </span>
            <button
              type="button"
              onClick={() => onOpen(e.id)}
              data-testid={`reminder-event-${e.id}`}
              className={css({
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'primary.50',
                paddingX: '0.75rem',
                paddingY: '0.5rem',
                cursor: 'pointer',
                _hover: { backgroundColor: 'primary.100' },
              })}
            >
              <span
                className={css({
                  display: 'block',
                  fontSize: '0.875rem',
                  color: 'primary.700',
                  fontWeight: 'medium',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
              >
                {e.title}
              </span>
              <span
                className={css({ fontSize: '0.75rem', color: 'primary.600' })}
              >
                {e.all_day
                  ? t('calendar.card.allDay')
                  : `${hm(e.start_at)} - ${hm(e.end_at)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

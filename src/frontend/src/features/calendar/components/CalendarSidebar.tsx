import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'
import { useCalendarSettings } from '../hooks/useCalendarSettings'
import {
  dateOnlyToLocalDate,
  instantToZonedDate,
  localDateToDateOnly,
} from '../utils/zonedDate'
import { MiniCalendar } from './MiniCalendar'
import { CalendarListManager } from './CalendarListManager'

/**
 * Calendar module secondary panel (二级导航栏), mirroring the 视频会议 aside.
 * Holds the Feishu-style mini month picker + an "upcoming" agenda peek. The
 * mini picker drives the main grid's date; clicking an upcoming row opens the
 * same detail dialog the grid uses.
 */

const formatWhen = (
  event: CalendarEvent,
  locale: string,
  calendarTimezone: string
) => {
  try {
    const value =
      event.all_day && event.start_date
        ? dateOnlyToLocalDate(event.start_date)
        : instantToZonedDate(event.start_at, calendarTimezone)
    return new Intl.DateTimeFormat(locale || undefined, {
      month: 'short',
      day: 'numeric',
      ...(event.all_day ? {} : { hour: '2-digit', minute: '2-digit' }),
    }).format(value)
  } catch {
    return event.start_date || event.start_at
  }
}

/* ── 表态样式:与网格视图同口径(calendarGridOverrides.css)——
   四态四色、一律实线:接受=蓝、未反馈=紫、待定=琥珀、拒绝=灰(+删除线)。
   紫/琥珀直接写死色值与网格/App 端对齐(网格 CSS 的强调色一律硬编码);
   各状态整类切换,不 cx 叠加同属性(panda-cx-atomic-order-trap)。 */

const barCls = css({
  flexShrink: 0,
  width: '3px',
  borderRadius: '2px',
  backgroundColor: 'primary.500',
})

const barNeedsCls = css({
  flexShrink: 0,
  width: '3px',
  borderRadius: '2px',
  backgroundColor: '#8B5CF6',
  _dark: { backgroundColor: '#A78BFA' },
})

const barTentativeCls = css({
  flexShrink: 0,
  width: '3px',
  borderRadius: '2px',
  backgroundColor: '#F59E0B',
  _dark: { backgroundColor: '#FBBF24' },
})

const barDeclinedCls = css({
  flexShrink: 0,
  width: '3px',
  borderRadius: '2px',
  backgroundColor: 'greyscale.400',
})

const barClsFor = (rsvp: RSVPStatus | null): string => {
  if (rsvp === 'declined') return barDeclinedCls
  if (rsvp === 'tentative') return barTentativeCls
  if (rsvp === 'needs_action') return barNeedsCls
  return barCls
}

const titleCls = css({
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 500,
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const titleDeclinedCls = css({
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 500,
  color: 'greyscale.500',
  textDecoration: 'line-through',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const whenCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})

const whenDeclinedCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
  textDecoration: 'line-through',
})

interface Props {
  date: Date
  onDateChange: (date: Date) => void
  /** Focused-month window — drives the mini calendar's event dots. */
  events: CalendarEvent[]
  /** Now-relative forward window — drives the「即将开始」list (independent of the
   * focused month, so it stays correct when the grid is paged to a far month). */
  upcomingEvents: CalendarEvent[]
  onSelectEvent: (event: CalendarEvent) => void
  onCreate: () => void
  onCalendarChanged: () => void
}

export const CalendarSidebar = ({
  date,
  onDateChange,
  events,
  upcomingEvents,
  onSelectEvent,
  onCreate,
  onCalendarChanged,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const { calendarTimezone } = useCalendarSettings()

  // Upcoming = events whose start is in the future, soonest first, capped.
  const upcoming = useMemo(() => {
    const now = Date.now()
    const today = localDateToDateOnly(
      instantToZonedDate(new Date(now), calendarTimezone)
    )
    return upcomingEvents
      .filter((e) =>
        e.all_day && e.end_date
          ? e.end_date > today
          : new Date(e.start_at).getTime() >= now
      )
      .sort(
        (a, b) =>
          new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      )
      .slice(0, 6)
  }, [calendarTimezone, upcomingEvents])

  return (
    <aside
      className={css({
        width: '100%',
        height: '100%',
        borderRight: '1px solid token(colors.greyscale.200)',
        backgroundColor: 'greyscale.000',
        padding: '1.25rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        overflowY: 'auto',
      })}
    >
      <h1
        className={css({
          fontSize: '1.125rem',
          fontWeight: 'bold',
          color: 'greyscale.900',
        })}
      >
        {t('page.title')}
      </h1>

      <MiniCalendar value={date} onChange={onDateChange} events={events} />

      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}
      >
        <CalendarListManager onChanged={onCalendarChanged} />
      </div>

      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        <h2
          className={css({
            fontSize: '0.875rem',
            fontWeight: 600,
            color: 'greyscale.700',
          })}
        >
          {t('sidebar.upcoming')}
        </h2>
        {upcoming.length === 0 ? (
          <div className={emptyUpcomingCls}>
            <p
              className={css({ fontSize: '0.8125rem', color: 'greyscale.500' })}
            >
              {t('page.empty')}
            </p>
            <button type="button" className={emptyCreateCls} onClick={onCreate}>
              + {t('page.create')}
            </button>
          </div>
        ) : (
          <ul
            className={css({
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
            })}
          >
            {upcoming.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSelectEvent(e)}
                  className={css({
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    borderRadius: '6px',
                    padding: '0.5rem',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'stretch',
                    _hover: { backgroundColor: 'brand.50' },
                  })}
                >
                  <span className={barClsFor(e.my_rsvp)} />
                  <span className={css({ minWidth: 0 })}>
                    <span
                      className={
                        e.my_rsvp === 'declined' ? titleDeclinedCls : titleCls
                      }
                    >
                      {e.title}
                    </span>
                    <span
                      className={
                        e.my_rsvp === 'declined' ? whenDeclinedCls : whenCls
                      }
                    >
                      {formatWhen(e, i18n.language, calendarTimezone)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

const emptyUpcomingCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.375rem',
  padding: '0.5rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.50',
})
const emptyCreateCls = css({
  border: 'none',
  backgroundColor: 'transparent',
  color: 'primary.500',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})

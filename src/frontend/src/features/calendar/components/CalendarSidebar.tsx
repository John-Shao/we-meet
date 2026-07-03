import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import type { CalendarEvent } from '../api/ApiCalendar'
import { MiniCalendar } from './MiniCalendar'

/**
 * Calendar module secondary panel (二级导航栏), mirroring the 视频会议 aside.
 * Holds the Feishu-style mini month picker + an "upcoming" agenda peek. The
 * mini picker drives the main grid's date; clicking an upcoming row opens the
 * same detail dialog the grid uses.
 */

const formatWhen = (iso: string, locale: string) => {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

interface Props {
  date: Date
  onDateChange: (date: Date) => void
  /** Focused-month window — drives the mini calendar's event dots. */
  events: CalendarEvent[]
  /** Now-relative forward window — drives the「即将开始」list (independent of the
   * focused month, so it stays correct when the grid is paged to a far month). */
  upcomingEvents: CalendarEvent[]
  onSelectEvent: (event: CalendarEvent) => void
}

export const CalendarSidebar = ({
  date,
  onDateChange,
  events,
  upcomingEvents,
  onSelectEvent,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')

  // Upcoming = events whose start is in the future, soonest first, capped.
  const upcoming = useMemo(() => {
    const now = Date.now()
    return upcomingEvents
      .filter((e) => new Date(e.start_at).getTime() >= now)
      .sort(
        (a, b) =>
          new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      )
      .slice(0, 6)
  }, [upcomingEvents])

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

      <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}>
        <h2
          className={css({
            fontSize: '0.85rem',
            fontWeight: 600,
            color: 'greyscale.700',
          })}
        >
          {t('sidebar.upcoming')}
        </h2>
        {upcoming.length === 0 ? (
          <p className={css({ fontSize: '0.8rem', color: 'greyscale.500' })}>
            {t('page.empty')}
          </p>
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
                    _hover: { backgroundColor: 'primary.50' },
                  })}
                >
                  <span
                    className={css({
                      flexShrink: 0,
                      width: '3px',
                      borderRadius: '2px',
                      backgroundColor: 'primary.500',
                    })}
                  />
                  <span className={css({ minWidth: 0 })}>
                    <span
                      className={css({
                        display: 'block',
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        color: 'greyscale.900',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {e.title}
                    </span>
                    <span
                      className={css({
                        display: 'block',
                        fontSize: '0.75rem',
                        color: 'greyscale.500',
                      })}
                    >
                      {formatWhen(e.start_at, i18n.language)}
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

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  isWeekend,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { zhCN, enUS, fr, de, nl } from 'date-fns/locale'
import type { Locale } from 'date-fns'

import { css, cx } from '@/styled-system/css'
import { navGlyphCls } from '@/styles/controls'
import { Button } from '@/primitives'
import type { CalendarEvent } from '../api/ApiCalendar'
import { useCalendarSettings } from '../hooks/useCalendarSettings'
import { instantToZonedDate } from '../utils/zonedDate'

/**
 * Feishu-style mini month picker for the calendar secondary panel (二级导航栏).
 * Selecting a day drives the main react-big-calendar grid (`value`/`onChange`);
 * days that have events get a small dot. Month-paging is local to this widget
 * and resets to the selected date's month when `value` jumps.
 */

const localeFor = (lng: string): Locale => {
  if (lng.startsWith('zh')) return zhCN
  const base = lng.slice(0, 2)
  return { fr, de, nl }[base] ?? enUS
}

interface Props {
  value: Date
  onChange: (date: Date) => void
  events: CalendarEvent[]
}

export const MiniCalendar = ({ value, onChange, events }: Props) => {
  const { i18n } = useTranslation('calendar')
  const locale = localeFor(i18n.language)
  // 周起始日跟「日历设置」(P8),覆盖 locale 缺省。
  const { weekStartsOn, calendarTimezone } = useCalendarSettings()
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(value))

  // Days that have at least one event — keyed by yyyy-MM-dd for O(1) lookup.
  const eventDays = useMemo(() => {
    const set = new Set<string>()
    for (const e of events) {
      set.add(
        e.all_day && e.start_date
          ? e.start_date
          : format(
              instantToZonedDate(e.start_at, calendarTimezone),
              'yyyy-MM-dd'
            )
      )
    }
    return set
  }, [calendarTimezone, events])

  const weeks = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewMonth), { locale, weekStartsOn })
    const end = endOfWeek(endOfMonth(viewMonth), { locale, weekStartsOn })
    const days = eachDayOfInterval({ start, end })
    const grid: Date[][] = []
    for (let i = 0; i < days.length; i += 7) grid.push(days.slice(i, i + 7))
    return grid
  }, [viewMonth, locale, weekStartsOn])

  const weekdayLabels =
    weeks[0]?.map((d) => format(d, 'EEEEEE', { locale })) ?? []

  return (
    <div className={css({ userSelect: 'none' })}>
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.5rem',
        })}
      >
        <span
          className={css({
            fontSize: '0.875rem',
            fontWeight: 600,
            color: 'greyscale.900',
          })}
        >
          {format(viewMonth, 'yyyy.MM', { locale })}
        </span>
        <span className={css({ display: 'flex', gap: '0.25rem' })}>
          <Button
            variant="quaternaryText"
            size="icon24"
            className={navGlyphCls}
            aria-label="prev month"
            onPress={() => setViewMonth((m) => addMonths(m, -1))}
          >
            ‹
          </Button>
          <Button
            variant="quaternaryText"
            size="icon24"
            className={navGlyphCls}
            aria-label="next month"
            onPress={() => setViewMonth((m) => addMonths(m, 1))}
          >
            ›
          </Button>
        </span>
      </div>

      <div className={grid}>
        {weekdayLabels.map((w, i) => (
          <span
            key={i}
            className={css({
              textAlign: 'center',
              fontSize: '0.6875rem',
              color: isWeekend(weeks[0][i]) ? 'greyscale.600' : 'greyscale.500',
              paddingY: '0.25rem',
            })}
          >
            {w}
          </span>
        ))}
        {weeks.flat().map((day) => {
          const selected = isSameDay(day, value)
          const outside = !isSameMonth(day, viewMonth)
          const today = isToday(day)
          const weekend = isWeekend(day)
          const hasEvent = eventDays.has(format(day, 'yyyy-MM-dd'))
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onChange(day)}
              aria-pressed={selected}
              aria-current={today ? 'date' : undefined}
              className={cx(
                cell,
                // 背景两分支都显式给值:cell 里的 background 简写与这里的
                // backgroundColor 曾按样式表顺序互撞(memory: panda-cx-
                // atomic-order-trap),cell 已不再设背景。
                css({
                  fontWeight: today ? 700 : 400,
                  ...(selected
                    ? {
                        backgroundColor: 'primary.500',
                        color: 'white',
                        borderColor: 'primary.500',
                        ...(today
                          ? { boxShadow: 'inset 0 0 0 1px white' }
                          : {}),
                      }
                    : {
                        backgroundColor: 'transparent',
                        color: outside
                          ? 'greyscale.400'
                          : today
                            ? 'primary.600'
                            : weekend
                              ? 'greyscale.600'
                              : 'greyscale.800',
                        borderColor: today ? 'primary.500' : 'transparent',
                        _hover: { backgroundColor: 'brand.50' },
                      }),
                })
              )}
            >
              {format(day, 'd')}
              {hasEvent && (
                <span
                  className={css({
                    position: 'absolute',
                    bottom: '3px',
                    width: '4px',
                    height: '4px',
                    borderRadius: '50%',
                    backgroundColor: selected ? 'white' : 'primary.500',
                  })}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const grid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: '2px',
})

const cell = css({
  position: 'relative',
  height: '30px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '6px',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})

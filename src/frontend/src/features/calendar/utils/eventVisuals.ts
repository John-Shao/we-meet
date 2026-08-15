import type { CSSProperties } from 'react'

import type { CalendarEvent } from '../api/ApiCalendar'

export const DEFAULT_CALENDAR_COLOR = '#3370FF'

export type CalendarColorMap = Readonly<Record<string, string>>

const HEX_COLOR = /^#[0-9a-f]{6}$/i

export const normalizeCalendarColor = (color?: string | null): string =>
  color && HEX_COLOR.test(color) ? color.toUpperCase() : DEFAULT_CALENDAR_COLOR

/**
 * Event hue describes ownership (the calendar/user), never RSVP or time state.
 * ``display_calendar_id`` is the backend's already-resolved calendar when an
 * event is visible through more than one calendar.
 */
export const calendarColorForEvent = (
  event: Pick<CalendarEvent, 'display_calendar_id'>,
  colors: CalendarColorMap
): string =>
  normalizeCalendarColor(
    event.display_calendar_id
      ? colors[event.display_calendar_id]
      : DEFAULT_CALENDAR_COLOR
  )

export type CalendarColorStyle = CSSProperties & {
  '--wm-calendar-color': string
}

export const calendarColorStyle = (color: string): CalendarColorStyle => ({
  '--wm-calendar-color': normalizeCalendarColor(color),
})

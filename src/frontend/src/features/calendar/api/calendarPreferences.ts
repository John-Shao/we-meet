import { fetchApi } from '@/api/fetchApi'

export type CalendarTimezoneMode = 'auto' | 'fixed'
export type CalendarWeekStart = 'mon' | 'sun'
export type CalendarTimeRange = 'work' | 'full'

export interface CalendarPreference {
  timezone_mode: CalendarTimezoneMode
  timezone: string | null
  week_start: CalendarWeekStart
  default_duration_minutes: number
  default_reminder_minutes: number | null
  dim_past: boolean
  show_weekend: boolean
  working_start_minutes: number
  working_end_minutes: number
  calendar_time_range: CalendarTimeRange
  meeting_rooms_time_range: CalendarTimeRange
  initialized: boolean
  revision: number
}

export type CalendarPreferenceUpdate = Omit<
  CalendarPreference,
  'initialized' | 'revision'
> & { expected_revision: number }

export const fetchCalendarPreference = (): Promise<CalendarPreference> =>
  fetchApi('/calendar-preferences/me/')

export const updateCalendarPreference = (
  payload: CalendarPreferenceUpdate
): Promise<CalendarPreference> =>
  fetchApi('/calendar-preferences/me/', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

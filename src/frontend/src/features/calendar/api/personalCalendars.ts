import { fetchApi } from '@/api/fetchApi'

import type { CalendarEvent } from './ApiCalendar'

export type CalendarPermission = 'none' | 'free_busy' | 'details'

export interface CalendarPerson {
  id: string
  full_name: string | null
  short_name?: string | null
  avatar_url?: string
  organization?: { id: string; name: string } | null
}

export interface PersonalCalendar {
  id: string
  owner: CalendarPerson
  organization: { id: string; name: string }
  organization_default_access: CalendarPermission
  effective_permission: CalendarPermission
  subscribed: boolean
}

export interface CalendarAccessGrant {
  id: string
  calendar_id: string
  grantee: CalendarPerson
  permission: Exclude<CalendarPermission, 'none'>
  external: boolean
}

export interface CalendarSubscription {
  id: string
  calendar_id: string
  owner: CalendarPerson
  permission: Exclude<CalendarPermission, 'none'>
  enabled: boolean
  color: string
}

export const fetchMyPersonalCalendar = (): Promise<PersonalCalendar> =>
  fetchApi('/personal-calendars/mine/')

export const updatePersonalCalendar = (
  id: string,
  access: CalendarPermission
): Promise<PersonalCalendar> =>
  fetchApi(`/personal-calendars/${encodeURIComponent(id)}/`, {
    method: 'PATCH',
    body: JSON.stringify({ organization_default_access: access }),
  })

export const fetchCalendarGrants = (): Promise<CalendarAccessGrant[]> =>
  fetchApi('/calendar-access-grants/')

export const saveCalendarGrant = (
  userId: string,
  permission: 'free_busy' | 'details'
): Promise<CalendarAccessGrant> =>
  fetchApi('/calendar-access-grants/', {
    method: 'POST',
    body: JSON.stringify({ grantee_user_id: userId, permission }),
  })

export const deleteCalendarGrant = (id: string): Promise<void> =>
  fetchApi(`/calendar-access-grants/${encodeURIComponent(id)}/`, {
    method: 'DELETE',
  }).then(() => undefined)

export const fetchCalendarSubscriptions = (): Promise<CalendarSubscription[]> =>
  fetchApi('/calendar-subscriptions/')

export const subscribeCalendar = (
  ownerUserId: string
): Promise<CalendarSubscription> =>
  fetchApi('/calendar-subscriptions/', {
    method: 'POST',
    body: JSON.stringify({ owner_user_id: ownerUserId }),
  })

export const unsubscribeCalendar = (id: string): Promise<void> =>
  fetchApi(`/calendar-subscriptions/${encodeURIComponent(id)}/`, {
    method: 'DELETE',
  }).then(() => undefined)

export const fetchPersonalCalendarEvents = (
  calendarId: string,
  range: { start: string; end: string }
): Promise<CalendarEvent[]> => {
  const query = new URLSearchParams(range)
  return fetchApi(
    `/personal-calendars/${encodeURIComponent(calendarId)}/events/?${query.toString()}`
  )
}

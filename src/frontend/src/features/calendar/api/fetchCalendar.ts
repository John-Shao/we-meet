import { fetchApi } from '@/api/fetchApi'

import type {
  CalendarEvent,
  CreateEventPayload,
  Paginated,
  RSVPStatus,
  UpdateEventPayload,
} from './ApiCalendar'

/** GET /api/v1.0/calendar-events — events the caller organizes or is invited to. */
export const fetchCalendarEvents = (): Promise<CalendarEvent[]> =>
  fetchApi<Paginated<CalendarEvent>>('/calendar-events/').then((p) => p.results)

/** POST /api/v1.0/calendar-events — create an event (also provisions its Room). */
export const createCalendarEvent = (
  payload: CreateEventPayload
): Promise<CalendarEvent> =>
  fetchApi<CalendarEvent>('/calendar-events/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

/** PATCH /api/v1.0/calendar-events/{id} — edit an event (scalar fields). */
export const updateCalendarEvent = (
  id: string,
  payload: UpdateEventPayload
): Promise<CalendarEvent> =>
  fetchApi<CalendarEvent>(`/calendar-events/${encodeURIComponent(id)}/`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

/** DELETE /api/v1.0/calendar-events/{id} — delete (cancel) an event. */
export const deleteCalendarEvent = (id: string): Promise<void> =>
  fetchApi(`/calendar-events/${encodeURIComponent(id)}/`, {
    method: 'DELETE',
  }).then(() => undefined)

/** POST /api/v1.0/calendar-events/{id}/rsvp — set the caller's RSVP. */
export const rsvpCalendarEvent = (
  id: string,
  status: RSVPStatus
): Promise<void> =>
  fetchApi(`/calendar-events/${encodeURIComponent(id)}/rsvp/`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  }).then(() => undefined)

import { fetchApi } from '@/api/fetchApi'

import type {
  CalendarEvent,
  CreateEventPayload,
  Paginated,
  RSVPStatus,
  UpdateEventPayload,
} from './ApiCalendar'

/** GET /api/v1.0/calendar-events — events the caller organizes or is invited to.
 *  Optional ISO `range` narrows to events overlapping [start, end] (server-side),
 *  so month paging fetches only the visible window instead of the whole calendar. */
export const fetchCalendarEvents = (range?: {
  start: string
  end: string
}): Promise<CalendarEvent[]> => {
  const qs = range
    ? `?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`
    : ''
  return fetchApi<Paginated<CalendarEvent>>(`/calendar-events/${qs}`).then(
    (p) => p.results
  )
}

/** GET /api/v1.0/calendar-events/{id} — one event (P8:IM 日程卡片跳详情用)。 */
export const fetchCalendarEvent = (id: string): Promise<CalendarEvent> =>
  fetchApi<CalendarEvent>(`/calendar-events/${encodeURIComponent(id)}/`)

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

/** DELETE /api/v1.0/calendar-events/{id} — delete (cancel) an event.
 *  P2-M2: `scope=following`(仅重复子场次)= 该场次及之后整段删除;缺省 =
 *  M1 语义(子场次仅此次 / 主事件删系列 / 单次直接删)。 */
export const deleteCalendarEvent = (
  id: string,
  scope?: 'following'
): Promise<void> =>
  fetchApi(
    `/calendar-events/${encodeURIComponent(id)}/${scope ? `?scope=${scope}` : ''}`,
    { method: 'DELETE' }
  ).then(() => undefined)

/** P2-M3 忙闲:一个人在窗口内的 busy 区间(仅区间,无标题/详情)。 */
export interface BusyInterval {
  start: string
  end: string
}
export interface FreeBusyEntry {
  user_id: string
  busy: BusyInterval[]
}

/** GET /api/v1.0/calendar-events/freebusy — 窗口内每人的 busy 区间列表。
 * P8:`excludeEventId` 编辑态传当前日程 id,把它自身从忙闲里剔除(否则原
 * 参与者必在其自身时段被误报忙碌)。 */
export const fetchFreeBusy = (
  attendeeIds: string[],
  start: string,
  end: string,
  excludeEventId?: string
): Promise<FreeBusyEntry[]> =>
  fetchApi<{ results: FreeBusyEntry[] }>(
    `/calendar-events/freebusy/?attendee_ids=${attendeeIds
      .map(encodeURIComponent)
      .join(
        ','
      )}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${
      excludeEventId
        ? `&exclude_event_id=${encodeURIComponent(excludeEventId)}`
        : ''
    }`
  ).then((r) => r.results)

/** POST /api/v1.0/calendar-events/{id}/rsvp — set the caller's RSVP. */
export const rsvpCalendarEvent = (
  id: string,
  status: RSVPStatus
): Promise<void> =>
  fetchApi(`/calendar-events/${encodeURIComponent(id)}/rsvp/`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  }).then(() => undefined)

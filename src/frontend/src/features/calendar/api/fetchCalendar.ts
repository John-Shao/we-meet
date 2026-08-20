import { fetchApi } from '@/api/fetchApi'

import type {
  CalendarEvent,
  CreateEventPayload,
  Paginated,
  RSVPStatus,
  UpdateEventPayload,
} from './ApiCalendar'

/** 每页拉满(后端 max_page_size=100),再按 `next` 翻到底。 */
const EVENTS_PAGE_SIZE = 100
/** 翻页上限(≈1000 条)——纯粹是防御,正常窗口远到不了。 */
const EVENTS_MAX_PAGES = 10

/**
 * GET /api/v1.0/calendar-events — events the caller organizes or is invited to.
 * Optional ISO `range` narrows to events overlapping [start, end] (server-side),
 * so month paging fetches only the visible window instead of the whole calendar.
 *
 * **必须翻页**:后端 DRF 默认 PAGE_SIZE=20 且按 start_at 升序,而日历窗口是
 * ±1 月 —— 只取第一页时,窗口靠后的日程(比如本月下旬)会被前面二十来条挤掉,
 * 网格里**静默消失**(排查过一次:侧栏「即将开始」窗口从今天起算所以有,主网格
 * 窗口从上月 1 日起算所以没有)。App 端 CalendarViewModel 一直是翻页的。
 */
export const fetchCalendarEvents = async (range?: {
  start: string
  end: string
  date_start?: string
  date_end?: string
}): Promise<CalendarEvent[]> => {
  const all: CalendarEvent[] = []
  for (let page = 1; page <= EVENTS_MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(EVENTS_PAGE_SIZE),
    })
    if (range) {
      qs.set('start', range.start)
      qs.set('end', range.end)
      if (range.date_start) qs.set('date_start', range.date_start)
      if (range.date_end) qs.set('date_end', range.date_end)
    }
    const res = await fetchApi<Paginated<CalendarEvent>>(
      `/calendar-events/?${qs.toString()}`
    )
    all.push(...res.results)
    if (!res.next) break
  }
  return all
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

/** Transfer organizer ownership while preserving the existing event resources. */
export const transferCalendarEvent = (
  id: string,
  newOrganizerId: string,
  keepOriginalOrganizer = true
): Promise<CalendarEvent> =>
  fetchApi<CalendarEvent>(
    `/calendar-events/${encodeURIComponent(id)}/transfer/`,
    {
      method: 'POST',
      body: JSON.stringify({
        new_organizer_id: newOrganizerId,
        keep_original_organizer: keepOriginalOrganizer,
      }),
    }
  )

/** DELETE /api/v1.0/calendar-events/{id} — delete (cancel) an event.
 *  P2-M2: `scope=following`(仅重复子场次)= 该场次及之后整段删除;缺省 =
 *  M1 语义(子场次仅此次 / 主事件删系列 / 单次直接删)。 */
export const deleteCalendarEvent = (
  id: string,
  scope?: 'one' | 'following' | 'all'
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

/** DTOs for the calendar / scheduling API (P2). Mirrors core/api/calendar.py. */

export type { Paginated } from '@/api/Paginated'

export type RSVPStatus = 'needs_action' | 'accepted' | 'declined' | 'tentative'

export interface EventAttendee {
  id: string | null
  full_name: string | null
  email: string
  rsvp: RSVPStatus
  role: 'organizer' | 'required' | 'optional'
}

export interface CalendarEvent {
  id: string
  title: string
  description: string
  /** ISO 8601 (UTC). */
  start_at: string
  end_at: string
  timezone: string
  all_day: boolean
  status: string
  visibility: string
  reminders: number[]
  organizer: { id: string; full_name: string | null } | null
  /** Room id (join target) + slug; null when the event has no room. */
  room: string | null
  room_slug: string | null
  attendees: EventAttendee[]
  my_rsvp: RSVPStatus | null
  created_at: string
  /** P2-M1 重复日程:主事件带 RRULE 串;子场次为空串。 */
  recurrence: string
  /** 子场次指回主事件 id;主/单次事件为 null。 */
  recurrence_parent: string | null
}

export interface CreateEventPayload {
  title: string
  /** ISO 8601 (send `new Date(local).toISOString()`). */
  start_at: string
  end_at: string
  all_day?: boolean
  reminders?: number[]
  attendee_ids?: string[]
  description?: string
  timezone?: string
  /**
   * P2-M1: RRULE 串,空/缺省=单次。UNTIL 必须用「浮动本地时刻」(无 Z,如
   * `FREQ=WEEKLY;UNTIL=20261231T235959`)——后端按事件时区墙上钟展开,dateutil
   * 在 naive dtstart 下会拒绝带 Z 的 UTC 形式(400)。见 composeRRule。
   */
  recurrence?: string
}

/** P2-M2 重复日程编辑范围:仅此场次 / 此场次及以后 / 所有场次。 */
export type EditScope = 'one' | 'following' | 'all'

/**
 * PATCH payload for editing an event. Scalar fields only — the backend update
 * path does not (yet) re-sync attendees / Room, so the edit dialog omits the
 * attendee picker and never sends attendee_ids.
 */
export interface UpdateEventPayload {
  title?: string
  description?: string
  start_at?: string
  end_at?: string
  all_day?: boolean
  reminders?: number[]
  /** P2-M2:重复日程子场次的编辑范围;单次事件省略。 */
  edit_scope?: EditScope
}

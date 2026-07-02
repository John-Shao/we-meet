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
}

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
}

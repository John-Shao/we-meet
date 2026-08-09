/**
 * DTOs for the meeting-room API (P9 会议室). Mirrors core/api/meeting_rooms.py.
 *
 * These are *physical* rooms you book for a meeting. Nothing to do with
 * `features/rooms/` or `CalendarEvent.room`, which are LiveKit video rooms.
 */

export type { Paginated } from '@/api/Paginated'

export interface MeetingRoomFacility {
  id: string
  name: string
  /** Stable key clients map to an icon (tv, projector, whiteboard, ...). */
  code: string
  sort_order?: number
}

export type MeetingRoomLevelType =
  | 'country_region'
  | 'city'
  | 'campus'
  | 'building'
  | 'floor'

export const MEETING_ROOM_LEVEL_TYPES: MeetingRoomLevelType[] = [
  'country_region',
  'city',
  'campus',
  'building',
  'floor',
]

export interface MeetingRoomNode {
  id: string
  name: string
  parent: string | null
  /** Materialized ancestor path; a subtree is everything with this prefix. */
  path: string
  depth: number
  level_number: 1 | 2 | 3 | 4 | 5
  level_type: MeetingRoomLevelType
  sort_order: number
  /** null = inherit from the nearest ancestor that sets one. */
  timezone: string | null
  effective_timezone: string
  room_count: number
}

/** The compact form embedded in a calendar event. */
export interface MeetingRoomBrief {
  id: string
  name: string
  code: string
  capacity: number
  node: { id: string; name: string }
  /** 「北京 · A 座 · 3F」— server-composed so clients need no tree loaded. */
  path_label: string
  timezone: string
  /** `conflict` = the occurrence exists but the room could not be held. */
  booking_status?: 'confirmed' | 'pending' | 'conflict' | 'cancelled'
}

export interface MeetingRoom {
  id: string
  name: string
  code: string
  capacity: number
  description: string
  node: { id: string; name: string }
  path_label: string
  timezone: string
  facilities: MeetingRoomFacility[]
  is_active: boolean
  requires_approval: boolean
}

export interface BusyRange {
  start: string
  end: string
}

export interface MeetingRoomAvailability extends MeetingRoom {
  is_available: boolean
  busy: BusyRange[]
}

export interface RoomBooking {
  id: string
  event_id: string | null
  start: string
  end: string
  status: 'confirmed' | 'pending' | 'conflict' | 'cancelled'
  source: 'event' | 'manual' | 'maintenance'
  /** null when the event is private and the caller is not on it. */
  title: string | null
  is_private: boolean
  is_mine: boolean
  organizer: {
    id: string
    full_name: string | null
    avatar_url?: string
  } | null
}

export interface RoomTimelineEntry extends MeetingRoom {
  bookings: RoomBooking[]
}

export interface RoomTimelineResponse {
  start: string
  end: string
  timezone: string | null
  results: RoomTimelineEntry[]
}

export interface RoomFilters {
  /** Node id; matches the node *and its whole subtree*. */
  node?: string | null
  q?: string
  capacityMin?: number | null
  /** Facility ids — AND semantics, a room must have all of them. */
  facilityIds?: string[]
}

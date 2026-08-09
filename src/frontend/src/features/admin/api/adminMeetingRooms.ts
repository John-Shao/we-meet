import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Meeting-room admin client (P9 会议室, M 端).
 *
 * Writes hit the `IsOrgAdmin`-guarded endpoints in
 * `core/api/admin_meeting_rooms.py`. Deletes are soft on the server so historic
 * bookings keep resolving to a name.
 */

export interface AdminMeetingRoomNode {
  id: string
  name: string
  parent: string | null
  path: string
  depth: number
  level_number: 1 | 2 | 3 | 4 | 5
  level_type: MeetingRoomLevelType
  sort_order: number
  /** null = inherit from the nearest ancestor that sets one. */
  timezone: string | null
  effective_timezone: string
  is_active: boolean
  room_count: number
  created_at: string
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

export interface AdminMeetingRoomFacility {
  id: string
  name: string
  code: string
  sort_order: number
  is_active: boolean
}

/** 「预定范围限制」— org = 全部成员, departments = 指定部门(含其下级). */
export type BookingScope = 'org' | 'departments'

export interface AdminMeetingRoom {
  id: string
  name: string
  code: string
  node: string
  node_name: string
  path_label: string
  capacity: number
  description: string
  facilities: { id: string; name: string; code: string }[]
  sort_order: number
  is_active: boolean
  disabled_reason: string
  /* --- 会议室预定限制 --- */
  booking_scope: BookingScope
  bookable_departments: { id: string; name: string }[]
  /** null = 不限时长。 */
  max_booking_minutes: number | null
  /** null = 不限提前天数。 */
  advance_booking_days: number | null
  created_at: string
}

/* --- hierarchy --- */

export const fetchAdminRoomNodes = (): Promise<AdminMeetingRoomNode[]> =>
  fetchApi<AdminMeetingRoomNode[]>('/admin/meeting-room-nodes/')

export interface RoomNodeInput {
  name?: string
  /** Only honoured on create — reparenting goes through `moveRoomNode`. */
  parent?: string | null
  /** IANA name, or '' to inherit from ancestors. */
  timezone?: string | null
  sort_order?: number
}

export const createRoomNode = (
  input: RoomNodeInput
): Promise<AdminMeetingRoomNode> =>
  fetchApi<AdminMeetingRoomNode>('/admin/meeting-room-nodes/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateRoomNode = (
  id: string,
  input: RoomNodeInput
): Promise<AdminMeetingRoomNode> =>
  fetchApi<AdminMeetingRoomNode>(`/admin/meeting-room-nodes/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

/** Reparent a level; the server rewrites the whole subtree's paths. */
export const moveRoomNode = (
  id: string,
  parentId: string | null
): Promise<AdminMeetingRoomNode> =>
  fetchApi<AdminMeetingRoomNode>(`/admin/meeting-room-nodes/${id}/move/`, {
    method: 'POST',
    body: JSON.stringify({ parent: parentId }),
  })

/** Soft-delete. Refused (400) while the level still holds levels or rooms. */
export const deleteRoomNode = (id: string): Promise<unknown> =>
  fetchApi(`/admin/meeting-room-nodes/${id}/`, { method: 'DELETE' })

/* --- rooms --- */

export interface AdminMeetingRoomFilters {
  /** Includes the whole subtree, not just rooms filed directly on the node. */
  node?: string | null
  /** Matches name **or** room number. */
  q?: string
  /** '' = any, '1' = 已启用, '0' = 已禁用. */
  is_active?: string
  /** AND semantics — a room must have every facility listed. */
  facilities?: string[]
  capacity_min?: number | null
  page?: number
}

export const fetchAdminMeetingRooms = (
  params: AdminMeetingRoomFilters = {}
): Promise<Paginated<AdminMeetingRoom>> => {
  const search = new URLSearchParams()
  if (params.node) search.set('node', params.node)
  if (params.q?.trim()) search.set('q', params.q.trim())
  if (params.is_active) search.set('is_active', params.is_active)
  if (params.facilities?.length)
    search.set('facilities', params.facilities.join(','))
  if (params.capacity_min)
    search.set('capacity_min', String(params.capacity_min))
  if (params.page && params.page > 1) search.set('page', String(params.page))
  const qs = search.toString()
  return fetchApi<Paginated<AdminMeetingRoom>>(
    `/admin/meeting-rooms/${qs ? `?${qs}` : ''}`
  )
}

/** One room, for the console's detail view (deep-linkable, so not list-derived). */
export const fetchAdminMeetingRoom = (id: string): Promise<AdminMeetingRoom> =>
  fetchApi<AdminMeetingRoom>(`/admin/meeting-rooms/${id}/`)

export interface MeetingRoomInput {
  name?: string
  code?: string
  node?: string
  capacity?: number
  description?: string
  facility_ids?: string[]
  is_active?: boolean
  disabled_reason?: string
  booking_scope?: BookingScope
  bookable_department_ids?: string[]
  /** null clears the limit; the server also treats 0 as "no limit". */
  max_booking_minutes?: number | null
  advance_booking_days?: number | null
}

export const createMeetingRoom = (
  input: MeetingRoomInput
): Promise<AdminMeetingRoom> =>
  fetchApi<AdminMeetingRoom>('/admin/meeting-rooms/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateMeetingRoom = (
  id: string,
  input: MeetingRoomInput
): Promise<AdminMeetingRoom> =>
  fetchApi<AdminMeetingRoom>(`/admin/meeting-rooms/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

/** Soft-delete. Existing bookings are deliberately left in place. */
export const deleteMeetingRoom = (id: string): Promise<unknown> =>
  fetchApi(`/admin/meeting-rooms/${id}/`, { method: 'DELETE' })

/* --- facilities --- */

export const fetchAdminFacilities = (): Promise<AdminMeetingRoomFacility[]> =>
  fetchApi<AdminMeetingRoomFacility[]>('/admin/meeting-room-facilities/')

export interface FacilityInput {
  name?: string
  code?: string
  sort_order?: number
  is_active?: boolean
}

export const createFacility = (
  input: FacilityInput
): Promise<AdminMeetingRoomFacility> =>
  fetchApi<AdminMeetingRoomFacility>('/admin/meeting-room-facilities/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateFacility = (
  id: string,
  input: FacilityInput
): Promise<AdminMeetingRoomFacility> =>
  fetchApi<AdminMeetingRoomFacility>(`/admin/meeting-room-facilities/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

/**
 * Retires rather than removes: a facility still referenced by rooms comes back
 * as `is_active: false` instead of vanishing, so those rooms keep their label.
 */
export const deleteFacility = (id: string): Promise<unknown> =>
  fetchApi(`/admin/meeting-room-facilities/${id}/`, { method: 'DELETE' })

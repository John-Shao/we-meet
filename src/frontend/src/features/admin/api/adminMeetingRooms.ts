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
  sort_order: number
  /** null = inherit from the nearest ancestor that sets one. */
  timezone: string | null
  effective_timezone: string
  is_active: boolean
  room_count: number
  created_at: string
}

export interface AdminMeetingRoomFacility {
  id: string
  name: string
  code: string
  sort_order: number
  is_active: boolean
}

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

export const fetchAdminMeetingRooms = (
  params: { node?: string | null; q?: string; page?: number } = {}
): Promise<Paginated<AdminMeetingRoom>> => {
  const search = new URLSearchParams()
  if (params.node) search.set('node', params.node)
  if (params.q?.trim()) search.set('q', params.q.trim())
  if (params.page && params.page > 1) search.set('page', String(params.page))
  const qs = search.toString()
  return fetchApi<Paginated<AdminMeetingRoom>>(
    `/admin/meeting-rooms/${qs ? `?${qs}` : ''}`
  )
}

export interface MeetingRoomInput {
  name?: string
  code?: string
  node?: string
  capacity?: number
  description?: string
  facility_ids?: string[]
  is_active?: boolean
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

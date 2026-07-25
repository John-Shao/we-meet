import { fetchApi } from '@/api/fetchApi'

import type {
  MeetingRoom,
  MeetingRoomAvailability,
  MeetingRoomFacility,
  MeetingRoomNode,
  Paginated,
  RoomFilters,
  RoomTimelineResponse,
} from './ApiMeetingRoom'

/** Turn the shared filter object into query params (empty values omitted). */
const filterParams = (filters: RoomFilters = {}): Record<string, string> => {
  const params: Record<string, string> = {}
  if (filters.node) params.node = filters.node
  if (filters.q?.trim()) params.q = filters.q.trim()
  if (filters.capacityMin) params.capacity_min = String(filters.capacityMin)
  if (filters.facilityIds?.length)
    params.facilities = filters.facilityIds.join(',')
  return params
}

const qs = (params: Record<string, string>) => {
  const search = new URLSearchParams(params).toString()
  return search ? `?${search}` : ''
}

/** GET /meeting-room-nodes — the whole hierarchy, flat and unpaginated. */
export const fetchMeetingRoomNodes = (): Promise<MeetingRoomNode[]> =>
  fetchApi<MeetingRoomNode[]>('/meeting-room-nodes/')

/** GET /meeting-room-facilities — the org's facility dictionary. */
export const fetchMeetingRoomFacilities = (): Promise<MeetingRoomFacility[]> =>
  fetchApi<MeetingRoomFacility[]>('/meeting-room-facilities/')

/** GET /meeting-rooms — paginated browse. */
export const fetchMeetingRooms = (
  filters: RoomFilters = {},
  page = 1
): Promise<Paginated<MeetingRoom>> =>
  fetchApi<Paginated<MeetingRoom>>(
    `/meeting-rooms/${qs({ ...filterParams(filters), page: String(page) })}`
  )

/**
 * GET /meeting-rooms/availability — rooms flagged free / busy for a window.
 *
 * `excludeEventId` drops the event being edited (and, for a series, all of its
 * occurrences) so a reschedule does not report the room as taken by itself.
 */
export const fetchMeetingRoomAvailability = (
  start: string,
  end: string,
  filters: RoomFilters = {},
  options: { excludeEventId?: string; onlyAvailable?: boolean } = {}
): Promise<MeetingRoomAvailability[]> => {
  const params: Record<string, string> = {
    ...filterParams(filters),
    start,
    end,
  }
  if (options.excludeEventId) params.exclude_event_id = options.excludeEventId
  if (options.onlyAvailable) params.only_available = 'true'
  return fetchApi<{ results: MeetingRoomAvailability[] }>(
    `/meeting-rooms/availability/${qs(params)}`
  ).then((r) => r.results)
}

/** GET /meeting-rooms/timeline — occupancy per room, for the timeline view. */
export const fetchMeetingRoomTimeline = (
  start: string,
  end: string,
  filters: RoomFilters = {}
): Promise<RoomTimelineResponse> =>
  fetchApi<RoomTimelineResponse>(
    `/meeting-rooms/timeline/${qs({ ...filterParams(filters), start, end })}`
  )

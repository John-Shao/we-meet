/**
 * P9 会议室 — *physical* bookable rooms.
 *
 * Not to be confused with `features/rooms/`, which is the LiveKit video room.
 * Cross-feature imports go through this barrel only.
 */

export { MeetingRoomField } from './components/MeetingRoomField'
export { MeetingRoomSummary } from './components/MeetingRoomSummary'
export { MeetingRoomsPane } from './components/MeetingRoomsPane'
export { MeetingRoomFilters } from './components/MeetingRoomFilters'
export { RoomTimeline } from './components/RoomTimeline'

export type {
  MeetingRoom,
  MeetingRoomAvailability,
  MeetingRoomBrief,
  MeetingRoomFacility,
  MeetingRoomNode,
  RoomBooking,
  RoomFilters,
  RoomTimelineEntry,
} from './api/ApiMeetingRoom'

export {
  fetchMeetingRoomAvailability,
  fetchMeetingRoomFacilities,
  fetchMeetingRoomNodes,
  fetchMeetingRoomTimeline,
  fetchMeetingRooms,
} from './api/fetchMeetingRooms'

export { childrenOf, flattenTree, validMoveTargets } from './utils/roomHierarchy'

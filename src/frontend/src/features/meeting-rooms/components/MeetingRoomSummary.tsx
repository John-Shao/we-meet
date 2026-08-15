import { useTranslation } from 'react-i18next'

import type { MeetingRoom } from '../api/ApiMeetingRoom'
import { roomBuildingIdentifier, roomResourceLabel } from '../utils/roomLabel'

type MeetingRoomSummaryData = Pick<MeetingRoom, 'name' | 'code'> &
  Partial<Pick<MeetingRoom, 'capacity' | 'node' | 'facilities'>>

/**
 * The shared two-line identity used wherever a meeting room appears in a list.
 * Keeping this in one component prevents calendar discovery from drifting away
 * from the room timeline as more room metadata is added.
 */
export const MeetingRoomSummary = ({
  room,
  primaryClassName,
  secondaryClassName,
}: {
  room: MeetingRoomSummaryData
  primaryClassName?: string
  secondaryClassName?: string
}) => {
  const { t } = useTranslation('meeting-rooms')
  // Calendar discovery returned identity-only room objects before the backend
  // started embedding the full meeting-room summary. Keep mixed-version
  // deployments renderable instead of crashing the whole React tree.
  const identity = {
    code: typeof room.code === 'string' ? room.code : '',
    name: typeof room.name === 'string' ? room.name : '',
  }
  const building =
    room.node && typeof room.node.name === 'string' ? room.node.name : ''
  const facilities = Array.isArray(room.facilities)
    ? room.facilities.map((facility) => ({
        name: typeof facility?.name === 'string' ? facility.name : '',
      }))
    : []
  const capacity = Number(room.capacity) || 0
  const identifier = roomBuildingIdentifier(building, identity)
  const capacityLabel =
    capacity > 0 ? t('unit.people', { count: capacity }) : ''
  const summary = roomResourceLabel({ facilities }, capacityLabel)
  const fullResourceLabel = [
    capacityLabel,
    ...facilities.map((facility) => facility.name),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <span className={primaryClassName} title={identifier}>
        {identifier}
      </span>
      <span className={secondaryClassName} title={fullResourceLabel}>
        {summary}
      </span>
    </>
  )
}

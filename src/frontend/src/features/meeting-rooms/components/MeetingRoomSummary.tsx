import { useTranslation } from 'react-i18next'

import type { MeetingRoom } from '../api/ApiMeetingRoom'
import { roomBuildingIdentifier, roomResourceLabel } from '../utils/roomLabel'

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
  room: MeetingRoom
  primaryClassName?: string
  secondaryClassName?: string
}) => {
  const { t } = useTranslation('meeting-rooms')
  const identifier = roomBuildingIdentifier(room.node.name, room)
  const capacityLabel =
    room.capacity > 0 ? t('unit.people', { count: room.capacity }) : ''
  const summary = roomResourceLabel(room, capacityLabel)
  const fullResourceLabel = [
    capacityLabel,
    ...room.facilities.map((facility) => facility.name),
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

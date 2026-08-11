export interface RoomIdentity {
  code: string
  name: string
}

/** Room number is primary; the optional name is only a human-friendly alias. */
export const roomIdentifier = ({ code, name }: RoomIdentity): string => {
  const normalizedCode = code.trim()
  const normalizedName = name.trim()
  if (!normalizedName) return normalizedCode
  if (!normalizedCode) return normalizedName
  return `${normalizedCode} (${normalizedName})`
}

/** Match the app's compact timeline label: building-room number (alias). */
export const roomBuildingIdentifier = (
  building: string,
  room: RoomIdentity
): string => {
  const normalizedBuilding = building.trim()
  const identifier = roomIdentifier(room)
  return [normalizedBuilding, identifier].filter(Boolean).join('-')
}

/** Calendar forms and details use one compact room summary on every viewport. */
export const roomScheduleLabel = (
  building: string,
  room: RoomIdentity,
  capacityLabel: string
): string =>
  [roomBuildingIdentifier(building, room), capacityLabel.trim()]
    .filter(Boolean)
    .join(' · ')

/** Format a UTC offset expressed as minutes east of UTC. */
export const formatGmtOffset = (offsetMinutes: number): string => {
  const roundedMinutes = Math.round(offsetMinutes)
  const sign = roundedMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(roundedMinutes)
  const hours = Math.floor(absoluteMinutes / 60)
  const minutes = absoluteMinutes % 60

  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`
}

/**
 * Return the browser timezone offset for the selected calendar day.
 * Noon avoids edge cases around daylight-saving transitions at midnight.
 */
export const localGmtOffsetLabel = (date: Date): string => {
  const localNoon = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12
  )
  return formatGmtOffset(-localNoon.getTimezoneOffset())
}

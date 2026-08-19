/**
 * Availability / conflict predicates shared by the picker and the timeline (P9).
 *
 * Ranges are half-open `[start, end)` everywhere — the same rule the database
 * exclusion constraint uses — so 10:00–11:00 and 11:00–12:00 are back-to-back
 * bookings, not a clash.
 */

import type { BusyRange, MeetingRoomAvailability } from '../api/ApiMeetingRoom'

const ms = (value: Date | string) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime()

/** Do two half-open ranges overlap? */
export const rangesOverlap = (
  aStart: Date | string,
  aEnd: Date | string,
  bStart: Date | string,
  bEnd: Date | string
): boolean => ms(aStart) < ms(bEnd) && ms(aEnd) > ms(bStart)

/** Is any busy range in the way of `[start, end)`? */
export const hasConflict = (
  busy: BusyRange[],
  start: Date,
  end: Date
): boolean => busy.some((b) => rangesOverlap(b.start, b.end, start, end))

/** Clip a range to a window; null when it falls entirely outside. */
export const clipToWindow = (
  range: BusyRange,
  windowStart: Date,
  windowEnd: Date
): BusyRange | null => {
  if (!rangesOverlap(range.start, range.end, windowStart, windowEnd))
    return null
  return {
    start: new Date(
      Math.max(ms(range.start), windowStart.getTime())
    ).toISOString(),
    end: new Date(Math.min(ms(range.end), windowEnd.getTime())).toISOString(),
  }
}

/** Does the room hold everyone? A capacity of 0 means "unspecified". */
export const capacityFits = (capacity: number, headcount: number): boolean =>
  capacity === 0 || capacity >= headcount

/** Ids of the rooms reported free, for greying out the rest of the list. */
export const availableIdSet = (rows: MeetingRoomAvailability[]): Set<string> =>
  new Set(rows.filter((r) => r.is_available).map((r) => r.id))

/**
 * Is a selected room now unbookable for the chosen slot?
 *
 * Deliberately returns false while availability is unknown (empty list, e.g. a
 * query still in flight): flickering the submit button off and on is worse than
 * letting the server have the last word with a 409.
 */
export const selectionConflicts = (
  selectedId: string | null | undefined,
  rows: MeetingRoomAvailability[]
): boolean => {
  if (!selectedId || rows.length === 0) return false
  const row = rows.find((r) => r.id === selectedId)
  return row ? !row.is_available : false
}

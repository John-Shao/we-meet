/**
 * Time ↔ horizontal-position maths for the meeting-room timeline (P9).
 *
 * Split out from the components so the arithmetic — the part that is easy to
 * get subtly wrong and impossible to eyeball — is unit-testable.
 */

export interface TimelineScale {
  /** Position of an instant as a percentage of the window, clamped to 0–100. */
  pct(value: Date | string | number): number
  /** Width of a range as a percentage; never zero, so a block stays visible. */
  widthPct(from: Date | string | number, to: Date | string | number): number
  /** Inverse of `pct`: a 0–1 ratio back to minutes from the window start. */
  minuteAt(ratio: number): number
  /** Round minutes down to a slot boundary (default: half-hour). */
  snap(minute: number, step?: number): number
  /** Window bounds, handy for callers building Dates from `minuteAt`. */
  start: Date
  end: Date
}

export const TIMELINE_HALF_HOUR_MIN_WIDTH = 64

/** Preserve readable half-hour cells while still filling a wider viewport. */
export const timelineTrackWidth = (
  totalMinutes: number,
  availableWidth: number
): number =>
  Math.max(
    TIMELINE_HALF_HOUR_MIN_WIDTH * Math.ceil(totalMinutes / 30),
    availableWidth
  )

const toMs = (value: Date | string | number): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** Smallest rendered width, so a zero-length booking is still clickable. */
const MIN_WIDTH_PCT = 0.5

export const makeScale = (start: Date, end: Date): TimelineScale => {
  // Measured, not assumed to be 86_400_000: a DST transition makes the local
  // day 23 or 25 hours long, and hard-coding would skew every block that day.
  const total = Math.max(end.getTime() - start.getTime(), 1)

  const pct = (value: Date | string | number) => {
    const ratio = (toMs(value) - start.getTime()) / total
    return Math.min(100, Math.max(0, ratio * 100))
  }

  return {
    start,
    end,
    pct,
    widthPct: (from, to) => Math.max(pct(to) - pct(from), MIN_WIDTH_PCT),
    minuteAt: (ratio) => {
      const clamped = Math.min(1, Math.max(0, ratio))
      return Math.round((total * clamped) / 60_000)
    },
    snap: (minute, step = 30) => Math.floor(minute / step) * step,
  }
}

/** The local midnight-to-midnight window containing `date`. */
export const dayWindow = (date: Date): { start: Date; end: Date } => {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

/** `start` plus `minutes`, as a new Date. */
export const addMinutes = (start: Date, minutes: number): Date =>
  new Date(start.getTime() + minutes * 60_000)

export interface TimelineGridTick {
  minute: number
  value: Date
  offsetPx: number
  isHour: boolean
  showLabel: boolean
}

/** Shared, pixel-aligned grid coordinates for the ruler and timeline body. */
export const timelineGridTicks = (
  start: Date,
  totalMinutes: number,
  trackWidth: number
): TimelineGridTick[] =>
  Array.from({ length: Math.ceil(totalMinutes / 30) }, (_, index) => {
    const minute = index * 30
    const value = addMinutes(start, minute)
    const isHour = value.getMinutes() === 0
    return {
      minute,
      value,
      offsetPx: Math.round((minute / totalMinutes) * trackWidth),
      isHour,
      showLabel: minute === 0 || isHour,
    }
  })

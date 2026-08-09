export type WorkingHours = {
  startMin: number
  endMin: number
}

export type TimeRangeMode = 'work' | 'full'

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  startMin: 9 * 60,
  endMin: 18 * 60,
}

export const WORKING_HOURS_STEP_MIN = 30
export const MIN_WORKING_DURATION_MIN = 6 * 60
export const MAX_WORKING_DURATION_MIN = 12 * 60

export const isValidWorkingHours = ({
  startMin,
  endMin,
}: WorkingHours): boolean => {
  const duration = endMin - startMin
  return (
    Number.isInteger(startMin) &&
    Number.isInteger(endMin) &&
    startMin >= 0 &&
    endMin <= 24 * 60 &&
    startMin % WORKING_HOURS_STEP_MIN === 0 &&
    endMin % WORKING_HOURS_STEP_MIN === 0 &&
    duration >= MIN_WORKING_DURATION_MIN &&
    duration <= MAX_WORKING_DURATION_MIN
  )
}

export const workingWindowForDate = (
  date: Date,
  workingHours: WorkingHours
): { start: Date; end: Date } => {
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const start = new Date(day)
  start.setMinutes(workingHours.startMin)
  const end = new Date(day)
  end.setMinutes(workingHours.endMin)
  return { start, end }
}

/** True when any timed part of the range falls outside that day's work window. */
export const isOutsideWorkingHours = (
  start: Date,
  end: Date,
  workingHours: WorkingHours
): boolean => {
  const window = workingWindowForDate(start, workingHours)
  return start < window.start || end > window.end
}

export const formatMinutes = (minutes: number): string => {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export const clipRangeToWindow = (
  start: Date,
  end: Date,
  windowStart: Date,
  windowEnd: Date
): { start: Date; end: Date } | null => {
  if (end <= windowStart || start >= windowEnd) return null
  return {
    start: start < windowStart ? windowStart : start,
    end: end > windowEnd ? windowEnd : end,
  }
}

export const WORKING_TIME_OPTIONS = Array.from(
  { length: 24 * 2 + 1 },
  (_, index) => index * WORKING_HOURS_STEP_MIN
)

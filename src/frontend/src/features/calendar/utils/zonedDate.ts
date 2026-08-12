import { zoneOffsetMinutes } from '@/utils/timezoneOptions'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

export const deviceTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const isValidTimezone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
    return true
  } catch {
    return false
  }
}

export const dateOnlyToLocalDate = (value: string): Date => {
  const match = DATE_RE.exec(value)
  if (!match) return new Date(Number.NaN)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export const localDateToDateOnly = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`

export const addCivilDays = (value: string, days: number): string => {
  const match = DATE_RE.exec(value)
  if (!match) return value
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  )
  return date.toISOString().slice(0, 10)
}

/** API exclusive end date → form inclusive end date. */
export const inclusiveAllDayEndDate = (
  startDate: string,
  exclusiveEndDate: string
): string => {
  const inclusive = addCivilDays(exclusiveEndDate, -1)
  return inclusive < startDate ? startDate : inclusive
}

/** Form inclusive end date → API exclusive end date. */
export const exclusiveAllDayEndDate = (inclusiveEndDate: string): string =>
  addCivilDays(inclusiveEndDate, 1)

const partsInZone = (instant: Date, zone: string) => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

/** Instant → browser-local proxy whose wall clock matches ``zone`` (for RBC). */
export const instantToZonedDate = (
  value: Date | string,
  zone: string
): Date => {
  const instant = value instanceof Date ? value : new Date(value)
  const parts = partsInZone(instant, zone)
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    instant.getMilliseconds()
  )
}

/** Browser-local wall-clock proxy → the corresponding instant in ``zone``. */
export const zonedDateToInstant = (wallClock: Date, zone: string): Date => {
  const naiveUtc = Date.UTC(
    wallClock.getFullYear(),
    wallClock.getMonth(),
    wallClock.getDate(),
    wallClock.getHours(),
    wallClock.getMinutes(),
    wallClock.getSeconds(),
    wallClock.getMilliseconds()
  )
  let candidate = new Date(
    naiveUtc - zoneOffsetMinutes(zone, new Date(naiveUtc)) * 60_000
  )
  // The first offset probe can sit on the other side of a DST boundary.
  candidate = new Date(naiveUtc - zoneOffsetMinutes(zone, candidate) * 60_000)
  return candidate
}

export const instantToZonedInput = (
  value: Date | string,
  zone: string
): string => {
  const date = instantToZonedDate(value, zone)
  return `${localDateToDateOnly(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export const zonedInputToInstant = (value: string, zone: string): Date => {
  const match = INPUT_RE.exec(value)
  if (!match) return new Date(Number.NaN)
  return zonedDateToInstant(
    new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5])
    ),
    zone
  )
}

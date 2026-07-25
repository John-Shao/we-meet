/**
 * Localized IANA timezone options for `<select>` pickers.
 *
 * `Intl.supportedValuesOf('timeZone')` only gives raw ids like
 * `Africa/Abidjan` — unreadable to anyone who is not an ops engineer, and
 * identical in every language. This renders them the way 飞书 does:
 *
 *     (GMT+08:00) 中国标准时间 · Asia/Shanghai
 *
 * The id is kept as a suffix on purpose: dozens of zones share one display
 * name (every European capital is 「中欧标准时间」), and the id is the only
 * thing that actually identifies the row.
 */

const FALLBACK_ZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
]

export interface TimezoneOption {
  zone: string
  label: string
  /** Offset from UTC in minutes, at the reference instant. Sort key. */
  offsetMinutes: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** All IANA zones the engine knows, or a short curated list if it cannot say. */
export const listTimezones = (): string[] => {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supported === 'function') {
    try {
      const zones = supported('timeZone')
      if (zones.length) return zones
    } catch {
      /* fall through to the curated list */
    }
  }
  return FALLBACK_ZONES
}

/**
 * Offset in minutes at `at` — read back from Intl so DST is accounted for
 * (Europe/Paris is +60 in January and +120 in July).
 */
export const zoneOffsetMinutes = (zone: string, at: Date): number => {
  let name: string | undefined
  try {
    name = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value
  } catch {
    return 0
  }
  // "GMT+08:00" / "GMT-03:30" / plain "GMT" for UTC itself.
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '')
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0))
}

export const formatOffset = (minutes: number): string => {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `GMT${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/**
 * The zone's name in `locale`, or '' when the engine has no localized name.
 *
 * Engines that lack a name echo back a "GMT+08:00"-ish string or the id
 * itself; neither is a name, so both are rejected rather than rendered twice.
 */
export const zoneDisplayName = (
  zone: string,
  locale: string,
  at: Date
): string => {
  for (const style of ['longGeneric', 'long'] as const) {
    try {
      const value = new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        timeZoneName: style,
      })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value
      if (value && !value.startsWith('GMT') && value !== zone) return value
    } catch {
      /* try the next style */
    }
  }
  return ''
}

export const timezoneLabel = (
  zone: string,
  locale: string,
  at: Date
): string => {
  const offset = formatOffset(zoneOffsetMinutes(zone, at))
  const name = zoneDisplayName(zone, locale, at)
  return name ? `(${offset}) ${name} · ${zone}` : `(${offset}) ${zone}`
}

/** Cache per locale: ~400 zones × 3 Intl formatters is not a per-render cost. */
const cache = new Map<string, TimezoneOption[]>()

/**
 * Every zone, labelled and sorted west-to-east then by id.
 *
 * `at` is only exposed for tests; production always wants "now" so the offsets
 * shown match what the DST rules say today.
 */
export const buildTimezoneOptions = (
  locale: string,
  at: Date = new Date()
): TimezoneOption[] => {
  const cached = cache.get(locale)
  if (cached) return cached

  const options = listTimezones()
    .map((zone) => ({
      zone,
      offsetMinutes: zoneOffsetMinutes(zone, at),
      label: timezoneLabel(zone, locale, at),
    }))
    .sort(
      (a, b) =>
        a.offsetMinutes - b.offsetMinutes || a.zone.localeCompare(b.zone)
    )

  cache.set(locale, options)
  return options
}

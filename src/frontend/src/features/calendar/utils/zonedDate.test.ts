import { describe, expect, it } from 'vitest'

import {
  exclusiveAllDayEndDate,
  inclusiveAllDayEndDate,
  instantToZonedDate,
  localDateToDateOnly,
  zonedDateToInstant,
} from './zonedDate'

describe('all-day civil dates', () => {
  it('round-trips single-day and multi-day exclusive ranges', () => {
    expect(inclusiveAllDayEndDate('2026-08-11', '2026-08-12')).toBe(
      '2026-08-11'
    )
    expect(inclusiveAllDayEndDate('2026-08-11', '2026-08-15')).toBe(
      '2026-08-14'
    )
    expect(exclusiveAllDayEndDate('2026-08-14')).toBe('2026-08-15')
  })
})

describe('zoned wall-clock adapter', () => {
  it('renders one instant in the selected calendar timezone', () => {
    const instant = new Date('2026-08-11T01:30:00Z')
    const shanghai = instantToZonedDate(instant, 'Asia/Shanghai')
    const losAngeles = instantToZonedDate(instant, 'America/Los_Angeles')

    expect(localDateToDateOnly(shanghai)).toBe('2026-08-11')
    expect(shanghai.getHours()).toBe(9)
    expect(localDateToDateOnly(losAngeles)).toBe('2026-08-10')
    expect(losAngeles.getHours()).toBe(18)
  })

  it('round-trips wall clocks across a DST offset', () => {
    const wallClock = new Date(2027, 2, 14, 9, 0)
    const instant = zonedDateToInstant(wallClock, 'America/Los_Angeles')
    const rendered = instantToZonedDate(instant, 'America/Los_Angeles')

    expect(instant.toISOString()).toBe('2027-03-14T16:00:00.000Z')
    expect(rendered.getFullYear()).toBe(2027)
    expect(rendered.getMonth()).toBe(2)
    expect(rendered.getDate()).toBe(14)
    expect(rendered.getHours()).toBe(9)
  })
})

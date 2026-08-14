import { describe, expect, it } from 'vitest'

import { CALENDAR_TIME_GRID_INTERVAL } from './timeGridInterval'

describe('calendar day/week grid interval', () => {
  it('snaps four 15-minute slots into each hour', () => {
    expect(CALENDAR_TIME_GRID_INTERVAL.step).toBe(15)
    expect(CALENDAR_TIME_GRID_INTERVAL.timeslots).toBe(4)
    expect(
      CALENDAR_TIME_GRID_INTERVAL.step * CALENDAR_TIME_GRID_INTERVAL.timeslots
    ).toBe(60)
  })
})

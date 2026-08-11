import { describe, expect, it } from 'vitest'

import { allDayApiRange, inclusiveAllDayEnd } from './allDayRange'

const day = (year: number, month: number, date: number) =>
  new Date(year, month - 1, date, 0, 0, 0, 0)
const localDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`

describe('all-day range conversion', () => {
  it('creates a single-day half-open API range', () => {
    const range = allDayApiRange('2026-08-11', '2026-08-11')

    expect(range.start).toEqual(day(2026, 8, 11))
    expect(range.end).toEqual(day(2026, 8, 12))
  })

  it('round-trips a stored single-day event without adding a day', () => {
    const start = day(2026, 8, 11)
    const formEnd = inclusiveAllDayEnd(start, day(2026, 8, 12))
    const range = allDayApiRange('2026-08-11', localDate(formEnd))

    expect(formEnd).toEqual(day(2026, 8, 11))
    expect(range.end).toEqual(day(2026, 8, 12))
  })

  it('round-trips a stored multi-day event without changing its span', () => {
    const start = day(2026, 8, 11)
    const formEnd = inclusiveAllDayEnd(start, day(2026, 8, 15))
    const range = allDayApiRange('2026-08-11', localDate(formEnd))

    expect(formEnd).toEqual(day(2026, 8, 14))
    expect(range.end).toEqual(day(2026, 8, 15))
  })

  it('clamps malformed exclusive ends so the form remains editable', () => {
    const start = day(2026, 8, 11)
    expect(inclusiveAllDayEnd(start, start)).toEqual(start)
  })
})

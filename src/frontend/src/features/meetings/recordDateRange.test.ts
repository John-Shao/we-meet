import { expect, it } from 'vitest'
import { recordDateRange } from './recordDateRange'

it('uses local midnight and includes the entire selected end date', () => {
  const range = recordDateRange('2026-09-20', '2026-09-20')
  expect(range).toEqual({
    created_from: new Date(2026, 8, 20).toISOString(),
    created_before: new Date(2026, 8, 21).toISOString(),
  })
  expect(recordDateRange('', '')).toEqual({
    created_from: undefined,
    created_before: undefined,
  })
})

it.each([
  ['2026-02-30', ''],
  ['2026-9-2', ''],
  ['2026-09-21', '2026-09-20'],
])('rejects invalid or reversed calendar dates %s %s', (from, through) => {
  expect(() => recordDateRange(from, through)).toThrow()
})

import { describe, expect, it } from 'vitest'

import { formatGmtOffset } from './timeZone'

describe('formatGmtOffset', () => {
  it.each([
    [480, 'GMT+8'],
    [-300, 'GMT-5'],
    [0, 'GMT+0'],
    [330, 'GMT+5:30'],
    [-210, 'GMT-3:30'],
    [345, 'GMT+5:45'],
  ])('formats %i minutes as %s', (minutes, expected) => {
    expect(formatGmtOffset(minutes)).toBe(expected)
  })
})

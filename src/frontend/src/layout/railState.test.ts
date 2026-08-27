import { describe, expect, it } from 'vitest'
import { shouldCollapseRailInitially } from './railState'

describe('shouldCollapseRailInitially', () => {
  it('defaults to the compact rail on narrow viewports', () => {
    expect(shouldCollapseRailInitially(null, true)).toBe(true)
    expect(shouldCollapseRailInitially('0', true)).toBe(true)
  })

  it('restores the persisted preference on wider viewports', () => {
    expect(shouldCollapseRailInitially('1', false)).toBe(true)
    expect(shouldCollapseRailInitially('0', false)).toBe(false)
    expect(shouldCollapseRailInitially(null, false)).toBe(false)
  })
})

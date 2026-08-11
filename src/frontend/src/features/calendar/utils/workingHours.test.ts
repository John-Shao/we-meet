import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WORKING_HOURS,
  clipRangeToWindow,
  formatMinutes,
  isOutsideWorkingHours,
  isValidWorkingHours,
  workingWindowForDate,
} from './workingHours'

describe('workingHours', () => {
  it('formats the full-day end boundary as 24:00', () => {
    expect(formatMinutes(24 * 60)).toBe('24:00')
  })

  it('默认工作时间为 09:00–18:00', () => {
    expect(DEFAULT_WORKING_HOURS).toEqual({ startMin: 540, endMin: 1080 })
  })

  it('只接受半小时粒度且总时长为 6–12 小时的同日区间', () => {
    expect(isValidWorkingHours({ startMin: 540, endMin: 900 })).toBe(true)
    expect(isValidWorkingHours({ startMin: 360, endMin: 1080 })).toBe(true)
    expect(isValidWorkingHours({ startMin: 540, endMin: 870 })).toBe(false)
    expect(isValidWorkingHours({ startMin: 555, endMin: 1080 })).toBe(false)
    expect(isValidWorkingHours({ startMin: 1320, endMin: 360 })).toBe(false)
  })

  it('按本地日期生成半点工作区间并判断越界', () => {
    const hours = { startMin: 570, endMin: 1050 }
    const { start, end } = workingWindowForDate(new Date(2026, 7, 9, 15), hours)
    expect(formatMinutes(start.getHours() * 60 + start.getMinutes())).toBe(
      '09:30'
    )
    expect(formatMinutes(end.getHours() * 60 + end.getMinutes())).toBe('17:30')
    expect(
      isOutsideWorkingHours(
        new Date(2026, 7, 9, 9, 30),
        new Date(2026, 7, 9, 10, 30),
        hours
      )
    ).toBe(false)
    expect(
      isOutsideWorkingHours(
        new Date(2026, 7, 9, 9),
        new Date(2026, 7, 9, 10),
        hours
      )
    ).toBe(true)
  })

  it('裁掉跨可见边界的区间，并丢弃完全不可见的区间', () => {
    const windowStart = new Date(2026, 7, 9, 9)
    const windowEnd = new Date(2026, 7, 9, 18)
    expect(
      clipRangeToWindow(
        new Date(2026, 7, 9, 8),
        new Date(2026, 7, 9, 10),
        windowStart,
        windowEnd
      )
    ).toEqual({ start: windowStart, end: new Date(2026, 7, 9, 10) })
    expect(
      clipRangeToWindow(
        new Date(2026, 7, 9, 19),
        new Date(2026, 7, 9, 20),
        windowStart,
        windowEnd
      )
    ).toBeNull()
  })
})

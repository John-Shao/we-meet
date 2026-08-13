import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  effectiveReminder,
  reminderOptionLabel,
  useCalendarSettings,
} from './useCalendarSettings'

beforeEach(() => localStorage.clear())

describe('reminderOptionLabel', () => {
  // 假 t:带 count 回 `key:count`,否则回 key —— 只验分支路由,不验译文本身。
  const t = (key: string, opts?: { count: number }) =>
    opts ? `${key}:${opts.count}` : key

  it('0 → 事件开始时(不再是「0 分钟前」这个回归)', () => {
    expect(reminderOptionLabel(t, 0)).toBe('form.reminderAtTime')
  })

  it('60 → 1 小时(reminderHour)', () => {
    expect(reminderOptionLabel(t, 60)).toBe('form.reminderHour')
  })

  it('1440 → 1 天(不再是「1440 分钟前」这个回归)', () => {
    expect(reminderOptionLabel(t, 1440)).toBe('form.reminderDay')
  })

  it('120 → 2 小时(不是「120 分钟前」)', () => {
    expect(reminderOptionLabel(t, 120)).toBe('form.reminderHours:2')
  })

  it('2880 → 2 天(不是「48 小时前」,更不是分钟)', () => {
    expect(reminderOptionLabel(t, 2880)).toBe('form.reminderDays:2')
  })

  it('其余分钟 → reminderMinutes 带 count', () => {
    expect(reminderOptionLabel(t, 5)).toBe('form.reminderMinutes:5')
    expect(reminderOptionLabel(t, 15)).toBe('form.reminderMinutes:15')
    expect(reminderOptionLabel(t, 30)).toBe('form.reminderMinutes:30')
  })
})

describe('effectiveReminder', () => {
  it('多值取 max —— 后端 push_due_reminders 就是按 max 算触发点', () => {
    expect(effectiveReminder([10, 60, 30])).toBe(60)
  })

  it('空/缺省 → null(不提醒)', () => {
    expect(effectiveReminder([])).toBeNull()
    expect(effectiveReminder(null)).toBeNull()
    expect(effectiveReminder(undefined)).toBeNull()
  })

  it('0(日程开始时)是有效值,不能被当成「没有提醒」', () => {
    expect(effectiveReminder([0])).toBe(0)
  })
})

describe('useCalendarSettings — working hours', () => {
  it('空存储时使用 09:00–18:00，两个时间范围视图默认工作时间', () => {
    const { result } = renderHook(() => useCalendarSettings())
    expect(result.current.workingHours).toEqual({
      startMin: 9 * 60,
      endMin: 18 * 60,
    })
    expect(result.current.calendarTimeRangeMode).toBe('work')
    expect(result.current.meetingRoomsTimeRangeMode).toBe('work')
  })

  it('保存合法半小时区间并在同页其他实例即时同步', () => {
    const a = renderHook(() => useCalendarSettings())
    const b = renderHook(() => useCalendarSettings())

    act(() => a.result.current.setWorkingHours(8 * 60 + 30, 17 * 60))
    expect(a.result.current.workingHours).toEqual({
      startMin: 510,
      endMin: 1020,
    })
    expect(b.result.current.workingHours).toEqual({
      startMin: 510,
      endMin: 1020,
    })
    expect(localStorage.getItem('calendar-work-start')).toBe('510')
    expect(localStorage.getItem('calendar-work-end')).toBe('1020')
  })

  it('拒绝非法设置，并将非法存储回退到默认值', () => {
    const { result, unmount } = renderHook(() => useCalendarSettings())
    act(() => result.current.setWorkingHours(9 * 60, 14 * 60))
    expect(result.current.workingHours).toEqual({
      startMin: 540,
      endMin: 1080,
    })
    unmount()

    localStorage.setItem('calendar-work-start', '555')
    localStorage.setItem('calendar-work-end', '1080')
    const invalid = renderHook(() => useCalendarSettings())
    expect(invalid.result.current.workingHours).toEqual({
      startMin: 540,
      endMin: 1080,
    })
  })

  it('分别持久化日历与会议室的时间范围视图', () => {
    const { result } = renderHook(() => useCalendarSettings())
    act(() => result.current.setCalendarTimeRangeMode('full'))
    expect(result.current.calendarTimeRangeMode).toBe('full')
    expect(result.current.meetingRoomsTimeRangeMode).toBe('work')
    act(() => result.current.setMeetingRoomsTimeRangeMode('full'))
    expect(result.current.meetingRoomsTimeRangeMode).toBe('full')
    expect(localStorage.getItem('calendar-time-range')).toBe('full')
    expect(localStorage.getItem('meeting-rooms-time-range')).toBe('full')
  })
})

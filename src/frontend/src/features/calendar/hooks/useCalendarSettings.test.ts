import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { reminderOptionLabel, useCalendarSettings } from './useCalendarSettings'

const WEEKEND_KEY = 'calendar-show-weekend'

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

  it('其余分钟 → reminderMinutes 带 count', () => {
    expect(reminderOptionLabel(t, 5)).toBe('form.reminderMinutes:5')
    expect(reminderOptionLabel(t, 15)).toBe('form.reminderMinutes:15')
    expect(reminderOptionLabel(t, 30)).toBe('form.reminderMinutes:30')
  })
})

describe('useCalendarSettings — showWeekend', () => {
  it('localStorage 空时默认开(显示整周)', () => {
    const { result } = renderHook(() => useCalendarSettings())
    expect(result.current.showWeekend).toBe(true)
  })

  it('显式存 "0" → 关(收敛成工作周)', () => {
    localStorage.setItem(WEEKEND_KEY, '0')
    const { result } = renderHook(() => useCalendarSettings())
    expect(result.current.showWeekend).toBe(false)
  })

  it('setShowWeekend 更新状态并持久化为 1/0', () => {
    const { result } = renderHook(() => useCalendarSettings())

    act(() => result.current.setShowWeekend(true))
    expect(result.current.showWeekend).toBe(true)
    expect(localStorage.getItem(WEEKEND_KEY)).toBe('1')

    act(() => result.current.setShowWeekend(false))
    expect(result.current.showWeekend).toBe(false)
    expect(localStorage.getItem(WEEKEND_KEY)).toBe('0')
  })

  it('初始读取已存的 "1" → 开', () => {
    localStorage.setItem(WEEKEND_KEY, '1')
    const { result } = renderHook(() => useCalendarSettings())
    expect(result.current.showWeekend).toBe(true)
  })

  it('同页跨实例经 EVT 同步(设置页改动,日历页即时生效)', () => {
    const a = renderHook(() => useCalendarSettings())
    const b = renderHook(() => useCalendarSettings())

    act(() => a.result.current.setShowWeekend(true))
    expect(b.result.current.showWeekend).toBe(true)
  })
})

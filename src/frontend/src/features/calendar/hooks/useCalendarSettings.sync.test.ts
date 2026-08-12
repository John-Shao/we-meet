import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountId: 'account-a',
  fetchPreference: vi.fn(),
  updatePreference: vi.fn(),
}))

vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: mocks.accountId } }),
}))

vi.mock('../api/calendarPreferences', () => ({
  fetchCalendarPreference: mocks.fetchPreference,
  updateCalendarPreference: mocks.updatePreference,
}))

import {
  useCalendarSettings,
  useSyncCalendarSettings,
} from './useCalendarSettings'

const preference = (showWeekend: boolean) => ({
  timezone_mode: 'auto' as const,
  timezone: null,
  week_start: 'mon' as const,
  default_duration_minutes: 60,
  default_reminder_minutes: 10,
  dim_past: true,
  show_weekend: showWeekend,
  working_start_minutes: 540,
  working_end_minutes: 1080,
  calendar_time_range: 'work' as const,
  meeting_rooms_time_range: 'work' as const,
  initialized: true,
  revision: 3,
})

beforeEach(() => {
  localStorage.clear()
  mocks.accountId = 'account-a'
  mocks.fetchPreference.mockReset()
  mocks.updatePreference.mockReset()
})

describe('calendar preference account cache', () => {
  it('keeps transiently failed edits dirty and does not leak them to another account', async () => {
    mocks.fetchPreference.mockImplementation(async () => preference(true))
    mocks.updatePreference.mockRejectedValue(new Error('offline'))

    const settings = renderHook(() => {
      useSyncCalendarSettings()
      return useCalendarSettings()
    })

    await waitFor(() =>
      expect(localStorage.getItem('calendar-settings-revision:account-a')).toBe(
        '3'
      )
    )

    act(() => settings.result.current.setShowWeekend(false))
    await waitFor(() => expect(mocks.updatePreference).toHaveBeenCalled())
    expect(settings.result.current.showWeekend).toBe(false)
    expect(localStorage.getItem('calendar-settings-dirty:account-a')).toBe('1')

    mocks.accountId = 'account-b'
    settings.rerender()

    await waitFor(() =>
      expect(localStorage.getItem('calendar-settings-revision:account-b')).toBe(
        '3'
      )
    )
    expect(settings.result.current.showWeekend).toBe(true)
    expect(localStorage.getItem('calendar-show-weekend:account-a')).toBe('0')
    expect(localStorage.getItem('calendar-show-weekend:account-b')).toBe('1')
  })
})

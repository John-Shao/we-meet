import { describe, expect, it } from 'vitest'

import type { CalendarEvent } from '../api/ApiCalendar'
import { bucketReminderWindow, shouldRemind } from './reminderWindow'

/** 只填提醒分桶用到的字段,其余按 CalendarEvent 兜个空壳。 */
const ev = (o: Partial<CalendarEvent> & { start_at: string; end_at: string }) =>
  ({
    id: o.start_at,
    title: 't',
    description: '',
    timezone: 'Asia/Shanghai',
    all_day: false,
    status: 'confirmed',
    visibility: 'default',
    reminders: [],
    organizer: null,
    room: null,
    room_slug: null,
    meeting_room: null,
    attendees: [],
    my_rsvp: null,
    created_at: o.start_at,
    recurrence: '',
    recurrence_parent: null,
    ...o,
  }) as CalendarEvent

/** 2026-07-30 15:50 本地。 */
const now = new Date(2026, 6, 30, 15, 50)
const at = (h: number, m: number) => new Date(2026, 6, 30, h, m).toISOString()

describe('shouldRemind', () => {
  it('放行普通日程', () => {
    expect(shouldRemind(ev({ start_at: at(16, 0), end_at: at(17, 0) }))).toBe(
      true
    )
  })

  it('排除已取消', () => {
    const e = ev({
      start_at: at(16, 0),
      end_at: at(17, 0),
      status: 'cancelled',
    })
    expect(shouldRemind(e)).toBe(false)
  })

  it('排除我已拒绝的 —— 提醒是行动面,拒了就是不去', () => {
    const e = ev({
      start_at: at(16, 0),
      end_at: at(17, 0),
      my_rsvp: 'declined',
    })
    expect(shouldRemind(e)).toBe(false)
  })

  it('未回复/待定仍然提醒 —— 还没定就还可能去', () => {
    for (const rsvp of ['needs_action', 'tentative', 'accepted'] as const) {
      const e = ev({ start_at: at(16, 0), end_at: at(17, 0), my_rsvp: rsvp })
      expect(shouldRemind(e), rsvp).toBe(true)
    }
  })
})

describe('bucketReminderWindow', () => {
  it('拒掉的会不再顶掉真要去的那场(nearest 回归)', () => {
    const declinedNow = ev({
      start_at: at(15, 30),
      end_at: at(16, 30),
      my_rsvp: 'declined',
      title: 'Daily Meeting',
    })
    const next = ev({
      start_at: at(16, 30),
      end_at: at(17, 30),
      title: 'Code Review',
    })
    const { today, nearest } = bucketReminderWindow([declinedNow, next], now)
    expect(today.map((e) => e.title)).toEqual(['Code Review'])
    expect(nearest?.title).toBe('Code Review')
  })

  it('今日/明日分桶按开始时间升序', () => {
    const a = ev({ start_at: at(9, 0), end_at: at(10, 0), title: 'a' })
    const b = ev({ start_at: at(8, 0), end_at: at(8, 30), title: 'b' })
    const tomorrow = ev({
      start_at: new Date(2026, 6, 31, 9, 0).toISOString(),
      end_at: new Date(2026, 6, 31, 10, 0).toISOString(),
      title: 'c',
    })
    const res = bucketReminderWindow([a, b, tomorrow], now)
    expect(res.today.map((e) => e.title)).toEqual(['b', 'a'])
    expect(res.tomorrow.map((e) => e.title)).toEqual(['c'])
    // nearest 只看今天:今天两场都已结束,不会顺延到明天那场。
    expect(res.nearest).toBeNull()
  })
})

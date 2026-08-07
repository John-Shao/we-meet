import { describe, expect, it } from 'vitest'

import type { CalendarEvent } from '../api/ApiCalendar'
import {
  DEFAULT_COUNTDOWN_WINDOW_MINUTES,
  bucketReminderWindow,
  countdownWindowMinutes,
  reminderCountdown,
  shouldRemind,
} from './reminderWindow'

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

describe('倒计时角标读日程自己的提前量', () => {
  /**
   * 以前这里是写死的 60 分钟,跟 `reminders` 毫无关系 —— 用户选「提前 10 分钟」
   * 之后,列表入口该亮时不亮、不该亮时亮了 50 分钟。真机上发现:一条设了提醒的
   * 日程到点什么都没有,查下去才发现那个开关在这条路径上什么都不驱动。
   */
  it('设了 10 分钟:11 分钟前不亮,10 分钟前亮', () => {
    const e = ev({ start_at: at(16, 0), end_at: at(17, 0), reminders: [10] })
    expect(reminderCountdown(e, new Date(2026, 6, 30, 15, 49))).toBeNull()
    expect(reminderCountdown(e, new Date(2026, 6, 30, 15, 50))).toEqual({
      kind: 'soon',
      minutes: 10,
    })
  })

  it('多个提前量取最大 —— 与服务端 _lead_minutes 同口径', () => {
    // 两边不一致的话,IM 提醒到了而角标还没亮,或者反过来。
    expect(countdownWindowMinutes(ev0([5, 30, 15]))).toBe(30)
  })

  it('没设提前量退 60 分钟 —— 那是兜底窗口,不是「默认提醒时间」', () => {
    expect(countdownWindowMinutes(ev0([]))).toBe(DEFAULT_COUNTDOWN_WINDOW_MINUTES)
    const e = ev({ start_at: at(16, 0), end_at: at(17, 0), reminders: [] })
    expect(reminderCountdown(e, new Date(2026, 6, 30, 15, 5))).toEqual({
      kind: 'soon',
      minutes: 55,
    })
  })

  it('脏数据不把窗口算成 0 或 NaN', () => {
    // reminders 是 JSONField,历史数据里什么都可能有。算成 0 = 角标永不亮。
    expect(countdownWindowMinutes(ev0([0, -5]))).toBe(
      DEFAULT_COUNTDOWN_WINDOW_MINUTES
    )
    expect(
      countdownWindowMinutes(ev0(['15' as unknown as number]))
    ).toBe(15)
  })

  it('进行中永远是「现在」,不看提前量', () => {
    const e = ev({ start_at: at(15, 30), end_at: at(16, 30), reminders: [5] })
    expect(reminderCountdown(e, now)).toEqual({ kind: 'now' })
  })

  it('全天日程不参与倒计时', () => {
    const e = ev({
      start_at: at(16, 0),
      end_at: at(17, 0),
      all_day: true,
      reminders: [10],
    })
    expect(reminderCountdown(e, new Date(2026, 6, 30, 15, 55))).toBeNull()
  })
})

/** 只关心 reminders 的那几条断言用的空壳。 */
const ev0 = (reminders: number[]) =>
  ev({ start_at: at(16, 0), end_at: at(17, 0), reminders })

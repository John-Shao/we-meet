/**
 * P8「在消息列表提醒日程」(对标飞书):今日/明日分桶 + 最近日程 + 倒计时角标。
 * 纯函数,无 React 依赖;Web 会话列表入口与日程提醒页共用。
 */

import type { CalendarEvent } from '../api/ApiCalendar'

export interface ReminderBuckets {
  /** 覆盖今天的日程(按开始时间升序,含全天/跨天)。 */
  today: CalendarEvent[]
  /** 覆盖明天的日程。 */
  tomorrow: CalendarEvent[]
  /** 今天未结束的最早一条 —— 入口行与提醒页横幅卡的主角;无则 null。 */
  nearest: CalendarEvent | null
}

const startOfDay = (d: Date): Date => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

const overlaps = (e: CalendarEvent, from: Date, to: Date): boolean => {
  const s = new Date(e.start_at).getTime()
  const en = new Date(e.end_at).getTime()
  return s < to.getTime() && en > from.getTime()
}

/** 取消的排除;窗口 = [今天 00:00, 后天 00:00)(本地)。 */
export const bucketReminderWindow = (
  events: CalendarEvent[],
  now: Date
): ReminderBuckets => {
  const today0 = startOfDay(now)
  const tomorrow0 = new Date(today0)
  tomorrow0.setDate(tomorrow0.getDate() + 1)
  const after0 = new Date(today0)
  after0.setDate(after0.getDate() + 2)

  const active = events
    .filter((e) => e.status !== 'cancelled')
    .sort(
      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
    )

  const today = active.filter((e) => overlaps(e, today0, tomorrow0))
  const tomorrow = active.filter((e) => overlaps(e, tomorrow0, after0))
  const nearest =
    today.find((e) => new Date(e.end_at).getTime() > now.getTime()) ?? null
  return { today, tomorrow, nearest }
}

export type ReminderCountdown =
  | { kind: 'now' }
  | { kind: 'soon'; minutes: number }
  | null

/** 角标:进行中 →「现在」;1 小时内开始 →「N 分钟后」;其余无。全天不参与。 */
export const reminderCountdown = (
  event: CalendarEvent,
  now: Date
): ReminderCountdown => {
  if (event.all_day) return null
  const s = new Date(event.start_at).getTime()
  const e = new Date(event.end_at).getTime()
  const t = now.getTime()
  if (s <= t && t < e) return { kind: 'now' }
  const diffMin = (s - t) / 60_000
  if (diffMin > 0 && diffMin <= 60) {
    return { kind: 'soon', minutes: Math.max(1, Math.ceil(diffMin)) }
  }
  return null
}

/** 「HH:MM - HH:MM」;全天 → null(调用方显示「全天」)。 */
export const reminderTimeRange = (event: CalendarEvent): string | null => {
  if (event.all_day) return null
  const hm = (iso: string) => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  }
  return `${hm(event.start_at)} - ${hm(event.end_at)}`
}

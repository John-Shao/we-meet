import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  bucketReminderWindow,
  fetchCalendarEvents,
  type ReminderBuckets,
} from '@/features/calendar'

const STORAGE_KEY = 'im-reminder-entry'

/**
 * 「在消息列表提醒日程」开关(P8,对标飞书,默认开)。localStorage 持久化,
 * 监听 storage 事件保证多标签页/入口与提醒页开关联动。
 */
export const useReminderEntryEnabled = (): [boolean, (v: boolean) => void] => {
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem(STORAGE_KEY) !== '0'
  )
  useEffect(() => {
    const sync = () => setEnabled(localStorage.getItem(STORAGE_KEY) !== '0')
    window.addEventListener('storage', sync)
    // 同页内多个使用方之间用自定义事件联动(storage 事件不触发于本页)。
    window.addEventListener('im-reminder-entry-changed', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('im-reminder-entry-changed', sync)
    }
  }, [])
  const set = (v: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
    } catch {
      /* 隐私模式等:仅本次会话生效 */
    }
    setEnabled(v)
    window.dispatchEvent(new Event('im-reminder-entry-changed'))
  }
  return [enabled, set]
}

/**
 * 提醒窗口数据:今天 00:00 → 后天 00:00 的日程,60s 轮询 + 30s 倒计时 tick。
 * 返回分桶结果与当前时刻(供角标计算)。
 */
export const useReminderWindow = (
  enabled: boolean
): ReminderBuckets & { now: Date } => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [enabled])

  const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  const { data: events = [] } = useQuery({
    queryKey: ['calendar', 'reminder-window', dayKey],
    queryFn: () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 2)
      return fetchCalendarEvents({
        start: start.toISOString(),
        end: end.toISOString(),
      })
    },
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  return useMemo(
    () => ({ ...bucketReminderWindow(events, now), now }),
    [events, now]
  )
}

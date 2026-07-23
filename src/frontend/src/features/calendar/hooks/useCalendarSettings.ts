import { useEffect, useState } from 'react'

const WEEK_KEY = 'calendar-week-start'
const DURATION_KEY = 'calendar-default-duration'
const REMINDER_KEY = 'calendar-default-reminder'
const DIM_PAST_KEY = 'calendar-dim-past'
const WEEKEND_KEY = 'calendar-show-weekend'
const EVT = 'calendar-settings-changed'

export type WeekStartPref = 'mon' | 'sun'

/** 新建日程默认时长可选值(分钟)。 */
export const DURATION_OPTIONS = [30, 60, 90] as const

/** 新建日程默认提醒提前量可选值(分钟,另有「不提醒」= null)。
 * 0 = 事件开始时、1440 = 提前 1 天(与 App 端提醒集对齐)。 */
export const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 1440] as const

const readWeekStart = (): WeekStartPref =>
  localStorage.getItem(WEEK_KEY) === 'sun' ? 'sun' : 'mon'

const readDuration = (): number => {
  const raw = Number(localStorage.getItem(DURATION_KEY))
  return (DURATION_OPTIONS as readonly number[]).includes(raw) ? raw : 60
}

const readReminder = (): number | null => {
  const raw = localStorage.getItem(REMINDER_KEY)
  if (raw === 'none') return null
  const n = Number(raw)
  return (REMINDER_OPTIONS as readonly number[]).includes(n) ? n : 10
}

const readDimPast = (): boolean => localStorage.getItem(DIM_PAST_KEY) !== '0'

// 周视图是否显示周末列(对齐 App:默认关,只显周一~周五工作周)。
const readWeekend = (): boolean => localStorage.getItem(WEEKEND_KEY) === '1'

/**
 * 提醒提前量文案:0=事件开始时、60=提前 1 小时、1440=提前 1 天,其余按分钟
 * (口径对齐 App 端 CreateEventScreen 的 reminderLabel)。t 传入以复用调用方
 * 的 calendar 命名空间。
 */
export const reminderOptionLabel = (
  t: (key: string, opts?: { count: number }) => string,
  min: number
): string =>
  min === 0
    ? t('form.reminderAtTime')
    : min === 60
      ? t('form.reminderHour')
      : min === 1440
        ? t('form.reminderDay')
        : t('form.reminderMinutes', { count: min })

/**
 * 日历本地设置(P8 日历设置,对标飞书,纯客户端 localStorage):
 * - weekStart:每周的第一天(mon 默认 / sun),weekStartsOn 供 date-fns;
 * - defaultDurationMin:新建日程默认时长(分钟,默认 60,保持既有行为)。
 * storage 事件覆盖多标签页,自定义事件覆盖同页多使用方(storage 事件
 * 不触发于写入页自身)。
 */
export const useCalendarSettings = () => {
  const [weekStart, setWeekStartState] = useState<WeekStartPref>(readWeekStart)
  const [defaultDurationMin, setDurationState] = useState<number>(readDuration)
  const [defaultReminderMin, setReminderState] = useState<number | null>(
    readReminder
  )
  const [dimPast, setDimPastState] = useState<boolean>(readDimPast)
  const [showWeekend, setShowWeekendState] = useState<boolean>(readWeekend)

  useEffect(() => {
    const sync = () => {
      setWeekStartState(readWeekStart())
      setDurationState(readDuration())
      setReminderState(readReminder())
      setDimPastState(readDimPast())
      setShowWeekendState(readWeekend())
    }
    window.addEventListener('storage', sync)
    window.addEventListener(EVT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(EVT, sync)
    }
  }, [])

  const write = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 隐私模式等:仅本次会话生效 */
    }
    window.dispatchEvent(new Event(EVT))
  }

  const setWeekStart = (v: WeekStartPref) => {
    setWeekStartState(v)
    write(WEEK_KEY, v)
  }

  const setDefaultDuration = (min: number) => {
    setDurationState(min)
    write(DURATION_KEY, String(min))
  }

  const setDefaultReminder = (min: number | null) => {
    setReminderState(min)
    write(REMINDER_KEY, min == null ? 'none' : String(min))
  }

  const setDimPast = (v: boolean) => {
    setDimPastState(v)
    write(DIM_PAST_KEY, v ? '1' : '0')
  }

  const setShowWeekend = (v: boolean) => {
    setShowWeekendState(v)
    write(WEEKEND_KEY, v ? '1' : '0')
  }

  return {
    weekStart,
    /** date-fns weekStartsOn:0=周日,1=周一。 */
    weekStartsOn: (weekStart === 'sun' ? 0 : 1) as 0 | 1,
    defaultDurationMin,
    /** 新建日程默认提醒提前量(分钟);null = 不提醒。 */
    defaultReminderMin,
    /** 降低已结束日程的亮度(对标飞书,默认开)。 */
    dimPast,
    /** 周视图是否显示周末列(对齐 App:默认关,只显工作周 5 列)。 */
    showWeekend,
    setWeekStart,
    setDefaultDuration,
    setDefaultReminder,
    setDimPast,
    setShowWeekend,
  }
}

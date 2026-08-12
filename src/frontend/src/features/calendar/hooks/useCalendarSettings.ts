import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '@/api/ApiError'
import { useUser } from '@/features/auth'

import {
  fetchCalendarPreference,
  updateCalendarPreference,
  type CalendarPreference,
  type CalendarPreferenceUpdate,
  type CalendarTimezoneMode,
} from '../api/calendarPreferences'
import {
  DEFAULT_WORKING_HOURS,
  isValidWorkingHours,
  type TimeRangeMode,
  type WorkingHours,
} from '../utils/workingHours'
import { deviceTimezone, isValidTimezone } from '../utils/zonedDate'

const WEEK_KEY = 'calendar-week-start'
const DURATION_KEY = 'calendar-default-duration'
const REMINDER_KEY = 'calendar-default-reminder'
const DIM_PAST_KEY = 'calendar-dim-past'
const WEEKEND_KEY = 'calendar-show-weekend'
const WORK_START_KEY = 'calendar-work-start'
const WORK_END_KEY = 'calendar-work-end'
const CALENDAR_RANGE_KEY = 'calendar-time-range'
const ROOMS_RANGE_KEY = 'meeting-rooms-time-range'
const TIMEZONE_MODE_KEY = 'calendar-timezone-mode'
const TIMEZONE_KEY = 'calendar-timezone'
const DIRTY_KEY = 'calendar-settings-dirty'
const REVISION_KEY = 'calendar-settings-revision'
const EVT = 'calendar-settings-changed'

let activeCalendarSettingsAccount: string | null = null
let serverRevision: number | null = null
let initialSync: Promise<void> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let syncEpoch = 0
let localGeneration = 0

const accountStorageKey = (key: string): string =>
  activeCalendarSettingsAccount
    ? `${key}:${encodeURIComponent(activeCalendarSettingsAccount)}`
    : key

const storageGet = (key: string): string | null =>
  localStorage.getItem(accountStorageKey(key))

const storageSet = (key: string, value: string) =>
  localStorage.setItem(accountStorageKey(key), value)

export type WeekStartPref = 'mon' | 'sun'
export type { CalendarTimezoneMode }

/** 新建日程默认时长可选值(分钟)。 */
export const DURATION_OPTIONS = [30, 60, 90] as const

/** 日程提醒的可选提前量(分钟,另有「不提醒」= null)。
 * 0 = 日程开始时、60/120 = 提前 1/2 小时、1440/2880 = 提前 1/2 天。
 * 与 App 端 `ui/calendar/CalendarReminderOptions.kt` 的 REMINDER_OPTIONS
 * 同一份,改这里请一起改那边。 */
export const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880] as const

const readWeekStart = (): WeekStartPref =>
  storageGet(WEEK_KEY) === 'sun' ? 'sun' : 'mon'

const readDuration = (): number => {
  const raw = Number(storageGet(DURATION_KEY))
  return (DURATION_OPTIONS as readonly number[]).includes(raw) ? raw : 60
}

const readReminder = (): number | null => {
  const raw = storageGet(REMINDER_KEY)
  if (raw === 'none') return null
  const n = Number(raw)
  return (REMINDER_OPTIONS as readonly number[]).includes(n) ? n : 10
}

const readDimPast = (): boolean => storageGet(DIM_PAST_KEY) !== '0'

// 周视图是否显示周末列。Web 大屏默认开(显示整周);显式存 '0' 才收敛成
// 周一~周五工作周。App 端小屏默认关,刻意按端差异化(见 SettingsStore)。
const readWeekend = (): boolean => storageGet(WEEKEND_KEY) !== '0'

const readWorkingHours = (): WorkingHours => {
  const value = {
    startMin: Number(storageGet(WORK_START_KEY)),
    endMin: Number(storageGet(WORK_END_KEY)),
  }
  return isValidWorkingHours(value) ? value : DEFAULT_WORKING_HOURS
}

const readRangeMode = (key: string): TimeRangeMode =>
  storageGet(key) === 'full' ? 'full' : 'work'

const readTimezoneMode = (): CalendarTimezoneMode =>
  storageGet(TIMEZONE_MODE_KEY) === 'fixed' ? 'fixed' : 'auto'

const readFixedTimezone = (): string => {
  const value = storageGet(TIMEZONE_KEY) || ''
  return value && isValidTimezone(value) ? value : deviceTimezone()
}

const localSnapshot = (): Omit<
  CalendarPreferenceUpdate,
  'expected_revision'
> => ({
  timezone_mode: readTimezoneMode(),
  timezone: readTimezoneMode() === 'fixed' ? readFixedTimezone() : null,
  week_start: readWeekStart(),
  default_duration_minutes: readDuration(),
  default_reminder_minutes: readReminder(),
  dim_past: readDimPast(),
  show_weekend: readWeekend(),
  working_start_minutes: readWorkingHours().startMin,
  working_end_minutes: readWorkingHours().endMin,
  calendar_time_range: readRangeMode(CALENDAR_RANGE_KEY),
  meeting_rooms_time_range: readRangeMode(ROOMS_RANGE_KEY),
})

const dispatchSettingsChanged = () => window.dispatchEvent(new Event(EVT))

const localSettingsDirty = (): boolean => storageGet(DIRTY_KEY) === '1'

const cachedServerRevision = (): number | null => {
  const raw = storageGet(REVISION_KEY)
  if (raw == null) return null
  const revision = Number(raw)
  return Number.isInteger(revision) && revision >= 0 ? revision : null
}

const markLocalSettingsDirty = () => {
  localGeneration += 1
  try {
    storageSet(DIRTY_KEY, '1')
  } catch {
    /* Cache persistence is optional in private browsing mode. */
  }
}

const writeRemoteToCache = (preference: CalendarPreference) => {
  const entries: Array<[string, string]> = [
    [TIMEZONE_MODE_KEY, preference.timezone_mode],
    [WEEK_KEY, preference.week_start],
    [DURATION_KEY, String(preference.default_duration_minutes)],
    [
      REMINDER_KEY,
      preference.default_reminder_minutes == null
        ? 'none'
        : String(preference.default_reminder_minutes),
    ],
    [DIM_PAST_KEY, preference.dim_past ? '1' : '0'],
    [WEEKEND_KEY, preference.show_weekend ? '1' : '0'],
    [WORK_START_KEY, String(preference.working_start_minutes)],
    [WORK_END_KEY, String(preference.working_end_minutes)],
    [CALENDAR_RANGE_KEY, preference.calendar_time_range],
    [ROOMS_RANGE_KEY, preference.meeting_rooms_time_range],
    [DIRTY_KEY, '0'],
    [REVISION_KEY, String(preference.revision)],
  ]
  if (preference.timezone) entries.push([TIMEZONE_KEY, preference.timezone])
  try {
    entries.forEach(([key, value]) => storageSet(key, value))
  } catch {
    /* Cache persistence is optional in private browsing mode. */
  }
  dispatchSettingsChanged()
}

const activateCalendarSettingsAccount = (accountId: string) => {
  if (activeCalendarSettingsAccount === accountId) return
  activeCalendarSettingsAccount = accountId
  serverRevision = null
  initialSync = null
  writeQueue = Promise.resolve()
  localGeneration = 0
  syncEpoch += 1
  // useSyncCalendarSettings is commonly rendered before useCalendarSettings;
  // defer the event until sibling effects have attached their listeners.
  queueMicrotask(dispatchSettingsChanged)
}

const syncCalendarSettings = (): Promise<void> => {
  if (!activeCalendarSettingsAccount) return Promise.resolve()
  if (initialSync) return initialSync
  const epoch = syncEpoch
  initialSync = fetchCalendarPreference()
    .then(async (remote) => {
      if (epoch !== syncEpoch) return
      const shouldImportLocal =
        !remote.initialized ||
        (localSettingsDirty() &&
          (cachedServerRevision() === remote.revision || localGeneration > 0))
      if (!shouldImportLocal) {
        serverRevision = remote.revision
        localGeneration = 0
        writeRemoteToCache(remote)
        return
      }

      const sentGeneration = localGeneration
      const resolved = await updateCalendarPreference({
        ...localSnapshot(),
        expected_revision: remote.revision,
      })
      if (epoch !== syncEpoch) return
      serverRevision = resolved.revision
      if (localGeneration === sentGeneration) {
        localGeneration = 0
        writeRemoteToCache(resolved)
      } else {
        storageSet(REVISION_KEY, String(resolved.revision))
        storageSet(DIRTY_KEY, '1')
      }
    })
    .catch(async (error) => {
      // Offline/anonymous use continues from the local cache.  A later mount
      // retries instead of pinning a rejected singleton promise forever.
      if (epoch !== syncEpoch) return
      initialSync = null
      if (!(error instanceof ApiError) || error.statusCode !== 409) return
      const latest = await fetchCalendarPreference().catch(() => null)
      if (latest && epoch === syncEpoch) {
        serverRevision = latest.revision
        localGeneration = 0
        writeRemoteToCache(latest)
      }
    })
  return initialSync
}

const persistCalendarSettings = () => {
  if (!activeCalendarSettingsAccount) return
  markLocalSettingsDirty()
  const epoch = syncEpoch
  writeQueue = writeQueue.then(async () => {
    await syncCalendarSettings()
    if (epoch !== syncEpoch || serverRevision == null || !localSettingsDirty())
      return
    const sentGeneration = localGeneration
    try {
      const saved = await updateCalendarPreference({
        ...localSnapshot(),
        expected_revision: serverRevision,
      })
      if (epoch !== syncEpoch) return
      serverRevision = saved.revision
      if (localGeneration === sentGeneration) {
        localGeneration = 0
        writeRemoteToCache(saved)
      } else {
        storageSet(REVISION_KEY, String(saved.revision))
        storageSet(DIRTY_KEY, '1')
        persistCalendarSettings()
      }
    } catch (error) {
      if (epoch !== syncEpoch) return
      initialSync = null
      // Only an optimistic-lock conflict is server-authoritative.  Offline,
      // network and 5xx failures retain the local dirty copy for a later retry.
      if (!(error instanceof ApiError) || error.statusCode !== 409) return
      const latest = await fetchCalendarPreference().catch(() => null)
      if (latest && epoch === syncEpoch) {
        serverRevision = latest.revision
        localGeneration = 0
        writeRemoteToCache(latest)
      }
    }
  })
}

/** Load/import the account copy once; localStorage remains the offline cache. */
export const useSyncCalendarSettings = () => {
  const { user } = useUser()

  useEffect(() => {
    if (!user?.id) return
    activateCalendarSettingsAccount(user.id)
    void syncCalendarSettings()
  }, [user?.id])
}

/**
 * 提醒提前量文案:0=日程开始时,整天/整小时走「天/小时」文案(1 与 n 分开,
 * 英法等语言的单复数不能靠 {{count}} 糊过去),其余按分钟。口径对齐 App 端
 * CalendarReminderOptions.kt 的 reminderLabel。t 传入以复用调用方的
 * calendar 命名空间。
 */
export const reminderOptionLabel = (
  t: (key: string, opts?: { count: number }) => string,
  min: number
): string => {
  if (min === 0) return t('form.reminderAtTime')
  if (min % 1440 === 0) {
    const days = min / 1440
    return days === 1
      ? t('form.reminderDay')
      : t('form.reminderDays', { count: days })
  }
  if (min % 60 === 0) {
    const hours = min / 60
    return hours === 1
      ? t('form.reminderHour')
      : t('form.reminderHours', { count: hours })
  }
  return t('form.reminderMinutes', { count: min })
}

/**
 * 一场日程真正会响的那条提醒(分钟);无提醒 → null。
 *
 * 后端 push_due_reminders 按 `max(reminders)` 算触发点并只推一次
 * (reminder_pushed_at 挡住后续),所以历史多值数据里生效的是最大那条。
 * 表单/详情都用它,免得展示一条实际不会响的提醒。
 */
export const effectiveReminder = (
  reminders: number[] | null | undefined
): number | null => {
  const valid = (reminders ?? []).filter((r) => Number.isFinite(r))
  return valid.length ? Math.max(...valid) : null
}

/**
 * 日历本地设置(P8 日历设置,对标飞书,纯客户端 localStorage):
 * - weekStart:每周的第一天(mon 默认 / sun),weekStartsOn 供 date-fns;
 * - defaultDurationMin:新建日程默认时长(分钟,默认 60,保持既有行为)。
 * storage 事件覆盖多标签页,自定义事件覆盖同页多使用方(storage 事件
 * 不触发于写入页自身)。
 */
export const useCalendarSettings = () => {
  const [timezoneMode, setTimezoneModeState] =
    useState<CalendarTimezoneMode>(readTimezoneMode)
  const [fixedTimezone, setFixedTimezoneState] =
    useState<string>(readFixedTimezone)
  const [weekStart, setWeekStartState] = useState<WeekStartPref>(readWeekStart)
  const [defaultDurationMin, setDurationState] = useState<number>(readDuration)
  const [defaultReminderMin, setReminderState] = useState<number | null>(
    readReminder
  )
  const [dimPast, setDimPastState] = useState<boolean>(readDimPast)
  const [showWeekend, setShowWeekendState] = useState<boolean>(readWeekend)
  const [workingHours, setWorkingHoursState] =
    useState<WorkingHours>(readWorkingHours)
  const [calendarTimeRangeMode, setCalendarTimeRangeModeState] =
    useState<TimeRangeMode>(() => readRangeMode(CALENDAR_RANGE_KEY))
  const [meetingRoomsTimeRangeMode, setMeetingRoomsTimeRangeModeState] =
    useState<TimeRangeMode>(() => readRangeMode(ROOMS_RANGE_KEY))

  useEffect(() => {
    const sync = () => {
      setTimezoneModeState(readTimezoneMode())
      setFixedTimezoneState(readFixedTimezone())
      setWeekStartState(readWeekStart())
      setDurationState(readDuration())
      setReminderState(readReminder())
      setDimPastState(readDimPast())
      setShowWeekendState(readWeekend())
      setWorkingHoursState(readWorkingHours())
      setCalendarTimeRangeModeState(readRangeMode(CALENDAR_RANGE_KEY))
      setMeetingRoomsTimeRangeModeState(readRangeMode(ROOMS_RANGE_KEY))
    }
    window.addEventListener('storage', sync)
    window.addEventListener(EVT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(EVT, sync)
    }
  }, [])

  const write = useCallback((key: string, value: string) => {
    try {
      storageSet(key, value)
    } catch {
      /* 隐私模式等:仅本次会话生效 */
    }
    window.dispatchEvent(new Event(EVT))
  }, [])

  const writeMany = useCallback((entries: Array<[string, string]>) => {
    try {
      entries.forEach(([key, value]) => storageSet(key, value))
    } catch {
      /* 隐私模式等:仅本次会话生效 */
    }
    window.dispatchEvent(new Event(EVT))
  }, [])

  const saveRemote = useCallback(() => persistCalendarSettings(), [])

  const setTimezoneMode = useCallback(
    (mode: CalendarTimezoneMode) => {
      setTimezoneModeState(mode)
      write(TIMEZONE_MODE_KEY, mode)
      saveRemote()
    },
    [saveRemote, write]
  )

  const setFixedTimezone = useCallback(
    (timezone: string) => {
      if (!isValidTimezone(timezone)) return
      setFixedTimezoneState(timezone)
      write(TIMEZONE_KEY, timezone)
      saveRemote()
    },
    [saveRemote, write]
  )

  const setWeekStart = useCallback(
    (v: WeekStartPref) => {
      setWeekStartState(v)
      write(WEEK_KEY, v)
      saveRemote()
    },
    [saveRemote, write]
  )

  const setDefaultDuration = useCallback(
    (min: number) => {
      setDurationState(min)
      write(DURATION_KEY, String(min))
      saveRemote()
    },
    [saveRemote, write]
  )

  const setDefaultReminder = useCallback(
    (min: number | null) => {
      setReminderState(min)
      write(REMINDER_KEY, min == null ? 'none' : String(min))
      saveRemote()
    },
    [saveRemote, write]
  )

  const setDimPast = useCallback(
    (v: boolean) => {
      setDimPastState(v)
      write(DIM_PAST_KEY, v ? '1' : '0')
      saveRemote()
    },
    [saveRemote, write]
  )

  const setShowWeekend = useCallback(
    (v: boolean) => {
      setShowWeekendState(v)
      write(WEEKEND_KEY, v ? '1' : '0')
      saveRemote()
    },
    [saveRemote, write]
  )

  const setWorkingHours = useCallback(
    (startMin: number, endMin: number) => {
      const value = { startMin, endMin }
      if (!isValidWorkingHours(value)) return
      setWorkingHoursState(value)
      writeMany([
        [WORK_START_KEY, String(startMin)],
        [WORK_END_KEY, String(endMin)],
      ])
      saveRemote()
    },
    [saveRemote, writeMany]
  )

  const setCalendarTimeRangeMode = useCallback(
    (mode: TimeRangeMode) => {
      setCalendarTimeRangeModeState(mode)
      write(CALENDAR_RANGE_KEY, mode)
      saveRemote()
    },
    [saveRemote, write]
  )

  const setMeetingRoomsTimeRangeMode = useCallback(
    (mode: TimeRangeMode) => {
      setMeetingRoomsTimeRangeModeState(mode)
      write(ROOMS_RANGE_KEY, mode)
      saveRemote()
    },
    [saveRemote, write]
  )

  return {
    timezoneMode,
    fixedTimezone,
    calendarTimezone:
      timezoneMode === 'fixed' ? fixedTimezone : deviceTimezone(),
    weekStart,
    /** date-fns weekStartsOn:0=周日,1=周一。 */
    weekStartsOn: (weekStart === 'sun' ? 0 : 1) as 0 | 1,
    defaultDurationMin,
    /** 新建日程默认提醒提前量(分钟);null = 不提醒。 */
    defaultReminderMin,
    /** 降低已结束日程的亮度(对标飞书,默认开)。 */
    dimPast,
    /** 周视图是否显示周末列(Web 默认开显示整周,关则只显工作周 5 列;App 默认关)。 */
    showWeekend,
    workingHours,
    calendarTimeRangeMode,
    meetingRoomsTimeRangeMode,
    setWeekStart,
    setDefaultDuration,
    setDefaultReminder,
    setDimPast,
    setShowWeekend,
    setWorkingHours,
    setCalendarTimeRangeMode,
    setMeetingRoomsTimeRangeMode,
    setTimezoneMode,
    setFixedTimezone,
  }
}

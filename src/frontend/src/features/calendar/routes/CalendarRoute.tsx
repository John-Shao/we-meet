import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import { RiSettings3Line } from '@remixicon/react'
import { addMonths, addYears, startOfDay, startOfMonth } from 'date-fns'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { ApiError } from '@/api/ApiError'
import { useConfig } from '@/api/useConfig'
import { useConfirm } from '@/components/ConfirmProvider'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import {
  fetchCalendarEvent,
  fetchCalendarEvents,
  rsvpCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from '../api/fetchCalendar'
import type { CalendarEvent, EditScope, RSVPStatus } from '../api/ApiCalendar'
import { openSystemSettings } from '@/stores/systemSettings'
import { CreateEventDialog } from '../components/CreateEventDialog'
import { ResizablePanel } from '@/components/ResizablePanel'
import { CalendarGrid, type SlotDraft } from '../components/CalendarGrid'
import {
  CalendarPageTabs,
  type CalendarPageTab,
} from '../components/CalendarPageTabs'
import { MeetingRoomsPane } from '@/features/meeting-rooms'
import type { MeetingRoomBrief, RoomBooking } from '@/features/meeting-rooms'
import type { View } from 'react-big-calendar'
import { CalendarSidebar } from '../components/CalendarSidebar'
import { EditScopeDialog } from '../components/EditScopeDialog'
import { EventDetailDialog } from '../components/EventDetailDialog'
import { EventShareDialog } from '../components/EventShareDialog'
import { fetchCalendars } from '../api/calendars'
import {
  useCalendarSettings,
  useSyncCalendarSettings,
} from '../hooks/useCalendarSettings'
import {
  instantToZonedDate,
  localDateToDateOnly,
  zonedDateToInstant,
} from '../utils/zonedDate'

const EVENTS_KEY = ['calendar'] as const

/**
 * 改期撞上会议室占用:core/api/calendar.py 的 handle_exception 把它转成 409
 * + `code: meeting_room_unavailable`。日程接口没有别的 409 语义,但仍按 code
 * 兜一层,免得将来加了别的 409 被误判成会议室冲突。
 */
const isRoomConflict = (error: unknown): boolean => {
  if (!(error instanceof ApiError) || error.statusCode !== 409) return false
  const body = error.body
  if (body && typeof body === 'object') {
    const code = (body as Record<string, unknown>).code
    if (typeof code === 'string') return code === 'meeting_room_unavailable'
  }
  return true
}

export const CalendarRoute = () => (
  <RequireAuth>
    <Screen>
      <CalendarAuthenticated />
    </Screen>
  </RequireAuth>
)

const CalendarAuthenticated = () => {
  useSyncCalendarSettings()
  const { data: runtimeConfig } = useConfig()
  const unifiedCalendarEnabled = runtimeConfig?.calendar?.enabled === true
  const { calendarTimezone } = useCalendarSettings()
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const [creating, setCreating] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('we-meet:calendar-sidebar-collapsed') === '1'
  )
  const [draft, setDraft] = useState<SlotDraft | null>(null)
  const [meetingRoomDraft, setMeetingRoomDraft] = useState<{
    room: MeetingRoomBrief
    start: Date
    end: Date
  } | null>(null)
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null)
  // 分享日程到聊天:与详情弹窗并列(而非嵌套),避免弹窗套弹窗。
  const [sharingEvent, setSharingEvent] = useState<CalendarEvent | null>(null)
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null)
  // P2-M2 三选:重复子场次的编辑/删除先弹范围选择;editScope 随编辑对话框提交。
  const [scopeAsk, setScopeAsk] = useState<{
    mode: 'edit' | 'delete'
    event: CalendarEvent
  } | null>(null)
  const [editScope, setEditScope] = useState<EditScope | undefined>(undefined)
  // P1-4:AI 引用/外链可带 ?d=YYYY-MM-DD 定位到该日所在视图(仅初始化时读)。
  const [date, setDate] = useState<Date>(() => {
    const d = new URLSearchParams(window.location.search).get('d')
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const parsed = new Date(`${d}T00:00`)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
    return instantToZonedDate(new Date(), calendarTimezone)
  })
  const previousCalendarTimezone = useRef(calendarTimezone)
  useEffect(() => {
    const previous = previousCalendarTimezone.current
    if (previous === calendarTimezone) return
    previousCalendarTimezone.current = calendarTimezone
    setDate((current) => {
      const now = new Date()
      const oldToday = instantToZonedDate(now, previous)
      return localDateToDateOnly(current) === localDateToDateOnly(oldToday)
        ? instantToZonedDate(now, calendarTimezone)
        : current
    })
  }, [calendarTimezone])
  // P1-4 M3:?event=<id> 事件级定位——窗口数据到位后自动打开该事件详情。
  // 与 ?d= 配套下发(?d 保证事件落在 ±1 月查询窗口内);找不到(超窗/无权限/
  // 已删)则静默放弃,仅按日定位。一次性消费,不随翻月重触发。
  const [pendingEventId, setPendingEventId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('event') || null
  )
  // 视图状态提升到路由层:页头分段切换器(原「日历」标题位)与网格共用。
  const [view, setView] = useState<View>('week')
  // P9:「日历 / 会议室」页面级 Tab。写回 ?tab=rooms 以便刷新/分享保持
  // (沿用本文件读 ?d= 的同款 URLSearchParams 手法)。
  const [tab, setTab] = useState<CalendarPageTab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'rooms'
      ? 'meetingRooms'
      : 'calendar'
  )

  const openCreate = (slot: SlotDraft | null) => {
    if (!slot) setMeetingRoomDraft(null)
    setDraft(slot)
    setCreating(true)
  }

  const toggleSidebar = () =>
    setSidebarCollapsed((current) => {
      const next = !current
      try {
        localStorage.setItem(
          'we-meet:calendar-sidebar-collapsed',
          next ? '1' : '0'
        )
      } catch {
        /* Persistence is optional in private mode. */
      }
      return next
    })

  // 网格容器:用来判断一次点击是落在日历表内还是表外(表外 = 清预选框)。
  const gridRef = useRef<HTMLDivElement>(null)

  // 切视图 / 翻页即作废预选框(它挂在具体时段上,换了窗口就不该留着)。
  useEffect(() => {
    setDraft((d) => (d && !creating ? null : d))
    // creating 不进依赖:弹窗开着时的重渲染不该清掉正在编辑的草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, view])

  useEffect(() => {
    setMeetingRoomDraft(null)
  }, [date, tab])

  const changeTab = (next: CalendarPageTab) => {
    setTab(next)
    const params = new URLSearchParams()
    if (next === 'meetingRooms') params.set('tab', 'rooms')
    const search = params.toString()
    // replace: switching tabs should not pile up browser history entries.
    navigate(`/calendar${search ? `?${search}` : ''}`, { replace: true })
  }
  const closeCreate = () => {
    setCreating(false)
    setDraft(null)
    setMeetingRoomDraft(null)
  }

  // 网格 + 迷你历:聚焦月份 ±1 个月窗口(覆盖月视图 6 周 + 迷你历翻页缓冲);
  // 翻月即换 key 重取,不再一次拉全量。日程视图例外:列表展示锚点日期起
  // 一年,取数窗口同步拉到 [当日, +1年)。
  const monthWindow = useMemo(() => {
    const asWindow = (start: Date, end: Date) => ({
      start: zonedDateToInstant(start, calendarTimezone).toISOString(),
      end: zonedDateToInstant(end, calendarTimezone).toISOString(),
      date_start: localDateToDateOnly(start),
      date_end: localDateToDateOnly(end),
    })
    if (view === 'agenda') {
      const anchor = startOfDay(date)
      return asWindow(anchor, addYears(anchor, 1))
    }
    return asWindow(
      startOfMonth(addMonths(date, -1)),
      startOfMonth(addMonths(date, 2))
    )
  }, [calendarTimezone, date, view])
  const { data: ownEvents = [], isLoading: ownEventsLoading } = useQuery({
    queryKey: ['calendar', 'window', monthWindow],
    queryFn: () => fetchCalendarEvents(monthWindow),
    staleTime: 30_000,
    // 会议室 Tab 不渲染网格,±1 月的事件窗口是纯浪费。
    enabled: tab === 'calendar',
  })
  const { data: calendars = [], isLoading: calendarsLoading } = useQuery({
    queryKey: ['calendar', 'unified'],
    queryFn: fetchCalendars,
    staleTime: 30_000,
    enabled: unifiedCalendarEnabled,
  })
  const enabledCalendarIds = useMemo(
    () => new Set(calendars.filter((row) => row.enabled).map((row) => row.id)),
    [calendars]
  )
  const events = useMemo(() => {
    const merged = new Map<string, CalendarEvent>()
    for (const event of ownEvents) {
      if (
        unifiedCalendarEnabled &&
        event.display_calendar_id &&
        !enabledCalendarIds.has(event.display_calendar_id)
      )
        continue
      const current = merged.get(event.id)
      if (!current || (current.details_redacted && !event.details_redacted)) {
        merged.set(event.id, {
          ...event,
          title: event.details_redacted ? t('sharing.busy') : event.title,
        })
      }
    }
    return [...merged.values()]
  }, [enabledCalendarIds, ownEvents, t, unifiedCalendarEnabled])
  const isLoading =
    ownEventsLoading || (unifiedCalendarEnabled && calendarsLoading)

  const invalidateCalendarData = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: EVENTS_KEY }),
      qc.invalidateQueries({ queryKey: ['meeting-rooms'] }),
    ])

  /**
   * 整块拖动已建日程 = 改期:只 PATCH 起止(其余字段不动 —— 后端 partial
   * 缺省即不改标题/参与者/会议室),乐观改本地缓存,失败回滚 + 提示。
   * 仅「我组织的非重复日程」可拖(见 canMoveEvent)。
   */
  const moveEvent = async (event: CalendarEvent, start: Date, end: Date) => {
    const key = ['calendar', 'window', monthWindow] as const
    const before = qc.getQueryData<CalendarEvent[]>(key)
    const times = event.all_day
      ? {
          start_date: localDateToDateOnly(start),
          end_date: localDateToDateOnly(end),
        }
      : {
          start_at: zonedDateToInstant(start, calendarTimezone).toISOString(),
          end_at: zonedDateToInstant(end, calendarTimezone).toISOString(),
          timezone: calendarTimezone,
        }
    qc.setQueryData<CalendarEvent[]>(key, (list) =>
      (list ?? []).map((e) =>
        e.id === event.id ? ({ ...e, ...times } as CalendarEvent) : e
      )
    )
    try {
      await updateCalendarEvent(event.id, times)
      await invalidateCalendarData()
    } catch (e) {
      // 无权限/网络/会议室被占:一律退回拖动前的时间。
      if (before) qc.setQueryData(key, before)
      // 会议室在新时段被占是最常见的一种,单独给文案 —— 后端只回
      // 「meeting room unavailable」,直接透出来用户看不懂发生了什么。
      void showAlert({
        message: isRoomConflict(e)
          ? t('grid.moveRoomConflict')
          : t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  /** The API projects write permission per event (including shared calendars). */
  const canMoveEvent = (event: CalendarEvent) =>
    !!event.can_edit && !event.recurrence && !event.recurrence_parent

  const openMeetingRoomBooking = async (booking: RoomBooking) => {
    const eventId = booking.event_id
    if (!eventId) return
    setMeetingRoomDraft(null)
    setDraft(null)
    try {
      const event = await qc.fetchQuery({
        queryKey: ['calendar', 'event', eventId],
        queryFn: () => fetchCalendarEvent(eventId),
        staleTime: 15_000,
      })
      setDetailEvent(event)
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  const moveMeetingRoomBooking = async (
    booking: RoomBooking,
    room: MeetingRoomBrief,
    start: Date,
    end: Date
  ) => {
    if (!booking.event_id) return
    try {
      await updateCalendarEvent(booking.event_id, {
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        meeting_room_id: room.id,
      })
      await invalidateCalendarData()
    } catch (e) {
      void showAlert({
        message: isRoomConflict(e)
          ? t('grid.moveRoomConflict')
          : t('form.error', { message: apiErrorMessage(e) }),
      })
      throw e
    }
  }

  useEffect(() => {
    if (!pendingEventId || isLoading) return
    const target = events.find((e) => e.id === pendingEventId)
    if (target) setDetailEvent(target)
    setPendingEventId(null)
  }, [pendingEventId, isLoading, events])

  // 侧栏「即将开始」:与聚焦日期无关,始终 now 起的未来窗口(独立查询,避免聚焦
  // 远月时上游窗口拿不到近期事件)。key 按天,当天内稳定复用。
  const upcomingWindow = useMemo(() => {
    const now = instantToZonedDate(new Date(), calendarTimezone)
    const start = startOfDay(now)
    const end = addMonths(start, 6)
    return {
      start: zonedDateToInstant(start, calendarTimezone).toISOString(),
      end: zonedDateToInstant(end, calendarTimezone).toISOString(),
      date_start: localDateToDateOnly(start),
      date_end: localDateToDateOnly(end),
    }
  }, [calendarTimezone])
  const { data: ownUpcomingEvents = [] } = useQuery({
    queryKey: ['calendar', 'upcoming', upcomingWindow],
    queryFn: () => fetchCalendarEvents(upcomingWindow),
    staleTime: 30_000,
  })
  const upcomingEvents = useMemo(() => {
    const merged = new Map<string, CalendarEvent>()
    for (const event of ownUpcomingEvents) {
      if (
        event.display_calendar_id &&
        !enabledCalendarIds.has(event.display_calendar_id)
      )
        continue
      const current = merged.get(event.id)
      if (!current || (current.details_redacted && !event.details_redacted)) {
        merged.set(event.id, {
          ...event,
          title: event.details_redacted ? t('sharing.busy') : event.title,
        })
      }
    }
    return [...merged.values()]
  }, [enabledCalendarIds, ownUpcomingEvents, t])

  const setRsvp = async (event: CalendarEvent, status: RSVPStatus) => {
    try {
      await rsvpCalendarEvent(event.id, status)
      await invalidateCalendarData()
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  const removeEvent = async (event: CalendarEvent) => {
    // 单次=原文案;带 RRULE 的主事件=删整个系列。重复子场次不走这里(P2-M2
    // 三选弹窗,见 onDelete 分支)。
    const confirmKey = event.recurrence
      ? 'detail.deleteConfirmSeries'
      : 'detail.deleteConfirm'
    if (!(await askConfirm({ message: t(confirmKey) }))) return
    try {
      await deleteCalendarEvent(event.id)
      setDetailEvent(null)
      await invalidateCalendarData()
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  // P2-M2:重复子场次的范围化删除(one=仅此次[M1 exdate 语义],following=
  // 该场次及之后截断)。三选弹窗本身即确认,不再二次 confirm。
  const removeScoped = async (event: CalendarEvent, scope: EditScope) => {
    try {
      await deleteCalendarEvent(event.id, scope)
      await invalidateCalendarData()
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  return (
    <div
      className={css({ display: 'flex', height: '100%' })}
      // 点到网格以外(侧栏 / 工具栏 / 页面空白)也算「点框外」→ 清除预选框。
      // 网格**内**的点击不在这里处理:落框/清框由 rbc 的 onSelectSlot 与
      // onSelectEvent 决定,两边都插手会打架。弹窗开着时草稿要留着。
      onMouseDownCapture={(e) => {
        if (!draft || creating) return
        const el = e.target as HTMLElement
        if (!gridRef.current?.contains(el)) {
          setDraft(null)
          return
        }
        // 网格内但落在左侧时刻栏 / 左上角空格:那儿不落框也不选日程,
        // 和点网格外同义(rbc 不会为它们回调 onSelectSlot,得自己收)。
        if (el.closest('.rbc-time-gutter, .rbc-time-header-gutter')) {
          setDraft(null)
        }
      }}
    >
      {/* 二级导航栏:迷你日历 + 即将开始,与「视频会议」侧栏对齐。可拖拽改宽。 */}
      {!sidebarCollapsed && (
        <ResizablePanel
          storageKey="we-meet:calendar-sidebar-width"
          defaultWidth={260}
          min={220}
          max={460}
        >
          <CalendarSidebar
            date={date}
            onDateChange={setDate}
            events={events}
            upcomingEvents={upcomingEvents}
            onSelectEvent={setDetailEvent}
            onCreate={() => openCreate(null)}
            onCalendarChanged={() => void invalidateCalendarData()}
          />
        </ResizablePanel>
      )}

      <div
        className={css({
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '1rem 1.25rem',
        })}
      >
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1rem',
          })}
        >
          {/* 原「日历」标题位换成 日/周/月/日程 分段切换器(飞书式);
             P9 起左侧再挂一组页面级 Tab(日历 / 会议室)。 */}
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
            })}
          >
            <button
              type="button"
              onClick={toggleSidebar}
              title={t(sidebarCollapsed ? 'shell:expand' : 'shell:collapse')}
              aria-label={t(
                sidebarCollapsed ? 'shell:expand' : 'shell:collapse'
              )}
              data-testid="calendar-sidebar-toggle"
              className={css({
                width: '2rem',
                height: '2rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: '0.375rem',
                backgroundColor: 'transparent',
                color: 'greyscale.700',
                cursor: 'pointer',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              {sidebarCollapsed ? '\u00bb' : '\u00ab'}
            </button>
            <CalendarPageTabs tab={tab} onTab={changeTab} />
          </div>
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            })}
          >
            <Button
              variant="primary"
              size="action"
              onPress={() => openCreate(null)}
              data-testid="calendar-create"
            >
              ＋ {t('page.create')}
            </Button>
            {/* P8 设置收敛:齿轮只是快捷入口,打开系统设置并定位「日历」节。
               无边框纯图标钮,置于「新建日程」右侧。 */}
            <button
              type="button"
              onClick={() => openSystemSettings('calendar')}
              title={t('settings.title')}
              aria-label={t('settings.title')}
              data-testid="calendar-settings"
              className={css({
                width: '2rem',
                height: '2rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: '0.375rem',
                backgroundColor: 'transparent',
                color: 'greyscale.700',
                cursor: 'pointer',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              <RiSettings3Line size={16} />
            </button>
          </div>
        </div>

        {/* 月/周/日 网格(react-big-calendar);点事件开详情弹窗(RSVP/进会)。
           P9 会议室 Tab 走自研横向时间轴(资源 × 时间,不是 rbc 的事件流)。 */}
        <div
          ref={gridRef}
          className={css({ flex: 1, minHeight: 0, position: 'relative' })}
        >
          {tab === 'meetingRooms' ? (
            <MeetingRoomsPane
              date={date}
              onClearSlot={() => {
                setMeetingRoomDraft(null)
                setDraft(null)
              }}
              selectedSlot={
                meetingRoomDraft
                  ? {
                      roomId: meetingRoomDraft.room.id,
                      start: meetingRoomDraft.start,
                      end: meetingRoomDraft.end,
                    }
                  : null
              }
              onSelectSlot={(room, slotStart, slotEnd) => {
                const confirmed =
                  meetingRoomDraft?.room.id === room.id &&
                  slotStart >= meetingRoomDraft.start &&
                  slotStart < meetingRoomDraft.end
                setMeetingRoomDraft({
                  room,
                  start: slotStart,
                  end: slotEnd,
                })
                setDraft({
                  start: slotStart,
                  end: slotEnd,
                  allDay: false,
                })
                if (confirmed) setCreating(true)
              }}
              onSlotChange={(room, slotStart, slotEnd) => {
                setMeetingRoomDraft({
                  room,
                  start: slotStart,
                  end: slotEnd,
                })
                setDraft({
                  start: slotStart,
                  end: slotEnd,
                  allDay: false,
                })
              }}
              onOpenBooking={(booking) => {
                void openMeetingRoomBooking(booking)
              }}
              onBookingChange={moveMeetingRoomBooking}
            />
          ) : isLoading ? (
            <StateHint loading>{t('page.loading')}</StateHint>
          ) : (
            <>
              <CalendarGrid
                events={events}
                onSelectEvent={setDetailEvent}
                date={date}
                onNavigate={setDate}
                view={view}
                onViewChange={setView}
                // 月视图点某天仍直接开弹窗;时间视图走两步式预选(下面几个)。
                onSelectSlot={openCreate}
                slotDraft={draft}
                // 点其他空白位置直接移动预选框；再次点击预选框本身才确认新建。
                onDraftSelect={setDraft}
                onDraftChange={setDraft}
                onDraftConfirm={() => setCreating(true)}
                onDraftDismiss={() => setDraft(null)}
                onEventMove={moveEvent}
                canMoveEvent={canMoveEvent}
              />
              {events.length === 0 && view !== 'agenda' && (
                <div
                  className={css({
                    position: 'absolute',
                    top: '5rem',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 3,
                    paddingX: '0.75rem',
                    paddingY: '0.375rem',
                    borderRadius: '999px',
                    backgroundColor: 'greyscale.000',
                    border: '1px solid token(colors.greyscale.200)',
                    boxShadow: 'sm',
                    color: 'greyscale.600',
                    fontSize: '0.75rem',
                    pointerEvents: 'none',
                  })}
                >
                  {t('grid.emptyHint')}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {detailEvent && (
        <EventDetailDialog
          event={detailEvent}
          canManage={detailEvent.can_edit}
          onEdit={() => {
            // P2-M2:重复子场次先选范围;主事件/单次直接进编辑(主=全部)。
            if (detailEvent.recurrence_parent) {
              setScopeAsk({ mode: 'edit', event: detailEvent })
            } else {
              setEditScope(undefined)
              setEditEvent(detailEvent)
            }
            setDetailEvent(null)
          }}
          onDelete={() => {
            if (detailEvent.recurrence_parent) {
              setScopeAsk({ mode: 'delete', event: detailEvent })
              setDetailEvent(null)
            } else {
              void removeEvent(detailEvent)
            }
          }}
          onShare={() => setSharingEvent(detailEvent)}
          onRsvp={(status) => setRsvp(detailEvent, status)}
          onJoin={() => {
            if (detailEvent.room_slug) navigate(`/${detailEvent.room_slug}`)
          }}
          onClose={() => setDetailEvent(null)}
        />
      )}

      {sharingEvent && (
        <EventShareDialog
          event={sharingEvent}
          onClose={() => setSharingEvent(null)}
        />
      )}

      {creating && (
        <CreateEventDialog
          calendars={calendars}
          initialStart={draft?.start}
          initialEnd={draft?.end}
          initialAllDay={draft?.allDay}
          initialMeetingRoom={meetingRoomDraft?.room}
          onClose={closeCreate}
          onCreated={() => {
            closeCreate()
            void invalidateCalendarData()
          }}
        />
      )}

      {editEvent && (
        <CreateEventDialog
          calendars={calendars}
          editEvent={editEvent}
          editScope={editScope}
          onClose={() => {
            setEditEvent(null)
            setEditScope(undefined)
          }}
          onCreated={() => {
            setEditEvent(null)
            setEditScope(undefined)
            void invalidateCalendarData()
          }}
        />
      )}

      {scopeAsk && (
        <EditScopeDialog
          title={t(
            scopeAsk.mode === 'edit' ? 'scope.editTitle' : 'scope.deleteTitle'
          )}
          options={
            scopeAsk.mode === 'edit'
              ? ['one', 'following', 'all']
              : ['one', 'following', 'all']
          }
          danger={scopeAsk.mode === 'delete'}
          onClose={() => setScopeAsk(null)}
          onConfirm={(scope) => {
            const target = scopeAsk.event
            const mode = scopeAsk.mode
            setScopeAsk(null)
            if (mode === 'edit') {
              setEditScope(scope)
              setEditEvent(target)
            } else {
              void removeScoped(target, scope)
            }
          }}
        />
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import { addMonths, endOfMonth, startOfDay, startOfMonth } from 'date-fns'

import { css } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useConfirm } from '@/components/ConfirmProvider'
import { useUser } from '@/features/auth'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import {
  fetchCalendarEvents,
  rsvpCalendarEvent,
  deleteCalendarEvent,
} from '../api/fetchCalendar'
import type { CalendarEvent, EditScope, RSVPStatus } from '../api/ApiCalendar'
import { CreateEventDialog } from '../components/CreateEventDialog'
import { ResizablePanel } from '@/components/ResizablePanel'
import { CalendarGrid, type SlotDraft } from '../components/CalendarGrid'
import { CalendarSidebar } from '../components/CalendarSidebar'
import { EditScopeDialog } from '../components/EditScopeDialog'
import { EventDetailDialog } from '../components/EventDetailDialog'

const EVENTS_KEY = ['calendar'] as const

export const CalendarRoute = () => (
  <RequireAuth>
    <Screen>
      <CalendarAuthenticated />
    </Screen>
  </RequireAuth>
)

const CalendarAuthenticated = () => {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const { user } = useUser()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<SlotDraft | null>(null)
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null)
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null)
  // P2-M2 三选:重复子场次的编辑/删除先弹范围选择;editScope 随编辑对话框提交。
  const [scopeAsk, setScopeAsk] = useState<{
    mode: 'edit' | 'delete'
    event: CalendarEvent
  } | null>(null)
  const [editScope, setEditScope] = useState<EditScope | undefined>(undefined)
  const [date, setDate] = useState<Date>(() => new Date())

  const openCreate = (slot: SlotDraft | null) => {
    setDraft(slot)
    setCreating(true)
  }
  const closeCreate = () => {
    setCreating(false)
    setDraft(null)
  }

  // 网格 + 迷你历:聚焦月份 ±1 个月窗口(覆盖月视图 6 周 + 迷你历翻页缓冲);
  // 翻月即换 key 重取,不再一次拉全量。
  const monthWindow = useMemo(
    () => ({
      start: startOfMonth(addMonths(date, -1)).toISOString(),
      end: endOfMonth(addMonths(date, 1)).toISOString(),
    }),
    [date]
  )
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['calendar', 'window', monthWindow],
    queryFn: () => fetchCalendarEvents(monthWindow),
    staleTime: 30_000,
  })

  // 侧栏「即将开始」:与聚焦日期无关,始终 now 起的未来窗口(独立查询,避免聚焦
  // 远月时上游窗口拿不到近期事件)。key 按天,当天内稳定复用。
  const upcomingWindow = useMemo(() => {
    const now = new Date()
    return {
      start: startOfDay(now).toISOString(),
      end: addMonths(now, 6).toISOString(),
    }
  }, [])
  const { data: upcomingEvents = [] } = useQuery({
    queryKey: ['calendar', 'upcoming', upcomingWindow],
    queryFn: () => fetchCalendarEvents(upcomingWindow),
    staleTime: 30_000,
  })

  const setRsvp = async (event: CalendarEvent, status: RSVPStatus) => {
    try {
      await rsvpCalendarEvent(event.id, status)
      await qc.invalidateQueries({ queryKey: EVENTS_KEY })
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
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
      await qc.invalidateQueries({ queryKey: EVENTS_KEY })
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
    }
  }

  // P2-M2:重复子场次的范围化删除(one=仅此次[M1 exdate 语义],following=
  // 该场次及之后截断)。三选弹窗本身即确认,不再二次 confirm。
  const removeScoped = async (event: CalendarEvent, scope: EditScope) => {
    try {
      await deleteCalendarEvent(
        event.id,
        scope === 'following' ? 'following' : undefined
      )
      await qc.invalidateQueries({ queryKey: EVENTS_KEY })
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
    }
  }

  return (
    <div className={css({ display: 'flex', height: '100%' })}>
      {/* 二级导航栏:迷你日历 + 即将开始,与「视频会议」侧栏对齐。可拖拽改宽。 */}
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
        />
      </ResizablePanel>

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
          <h1
            className={css({
              margin: 0,
              fontSize: '1.25rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('page.title')}
          </h1>
          <button
            type="button"
            onClick={() => openCreate(null)}
            data-testid="calendar-create"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: 'primary.500',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: 'pointer',
            })}
          >
            ＋ {t('page.create')}
          </button>
        </div>

        {/* 月/周/日 网格(react-big-calendar);点事件开详情弹窗(RSVP/进会)。 */}
        <div className={css({ flex: 1, minHeight: 0 })}>
          {isLoading ? (
            <p className={css({ color: 'greyscale.500' })}>
              {t('page.loading')}
            </p>
          ) : (
            <CalendarGrid
              events={events}
              onSelectEvent={setDetailEvent}
              date={date}
              onNavigate={setDate}
              onSelectSlot={openCreate}
            />
          )}
        </div>
      </div>

      {detailEvent && (
        <EventDetailDialog
          event={detailEvent}
          canManage={!!user && detailEvent.organizer?.id === user.id}
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
          onRsvp={(status) => setRsvp(detailEvent, status)}
          onJoin={() => {
            if (detailEvent.room_slug) navigate(`/${detailEvent.room_slug}`)
          }}
          onClose={() => setDetailEvent(null)}
        />
      )}

      {creating && (
        <CreateEventDialog
          initialStart={draft?.start}
          initialEnd={draft?.end}
          initialAllDay={draft?.allDay}
          onClose={closeCreate}
          onCreated={() => {
            closeCreate()
            void qc.invalidateQueries({ queryKey: EVENTS_KEY })
          }}
        />
      )}

      {editEvent && (
        <CreateEventDialog
          editEvent={editEvent}
          editScope={editScope}
          onClose={() => {
            setEditEvent(null)
            setEditScope(undefined)
          }}
          onCreated={() => {
            setEditEvent(null)
            setEditScope(undefined)
            void qc.invalidateQueries({ queryKey: EVENTS_KEY })
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
              : ['one', 'following']
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

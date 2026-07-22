import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { zhCN, enUS, fr, de, nl } from 'date-fns/locale'

import 'react-big-calendar/lib/css/react-big-calendar.css'
import './calendarGridOverrides.css'

import type { CalendarEvent } from '../api/ApiCalendar'
import { useCalendarSettings } from '../hooks/useCalendarSettings'
import { CalendarToolbar } from './CalendarToolbar'

/**
 * Feishu-style 月/周/日 calendar grid (P6-e #3), backed by react-big-calendar.
 * Events come from the same fetch the agenda used; clicking one bubbles the
 * underlying CalendarEvent up so the route can open its detail dialog (RSVP /
 * 进入会议). Toolbar labels are localized off the `calendar` namespace.
 * 周起始日跟「日历设置」(P8),localizer 随之重建。
 */

const localizerFor = (weekStartsOn: 0 | 1) =>
  dateFnsLocalizer({
    format,
    parse,
    startOfWeek: (date: Date | number) => startOfWeek(date, { weekStartsOn }),
    getDay,
    locales: { 'zh-CN': zhCN, en: enUS, fr, de, nl },
  })

const cultureFor = (lng: string): string => {
  if (lng.startsWith('zh')) return 'zh-CN'
  const base = lng.slice(0, 2)
  return ['fr', 'de', 'nl'].includes(base) ? base : 'en'
}

interface RbcEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: CalendarEvent
}

// 飞书式工具栏替换 rbc 默认 toolbar;模块级常量保证引用稳定,避免重挂。
const rbcComponents = { toolbar: CalendarToolbar }

export interface SlotDraft {
  start: Date
  end: Date
  allDay: boolean
}

interface Props {
  events: CalendarEvent[]
  onSelectEvent: (event: CalendarEvent) => void
  /** Controlled current date (e.g. driven by the mini calendar). Optional —
   * falls back to internal state when omitted so the grid stays standalone. */
  date?: Date
  onNavigate?: (date: Date) => void
  /** Controlled view(页头分段切换器驱动),同 date 模式,缺省走内部状态。 */
  view?: View
  onViewChange?: (view: View) => void
  /** Click/drag an empty slot → 飞书式快捷创建,带预填时间。 */
  onSelectSlot?: (draft: SlotDraft) => void
}

export const CalendarGrid = ({
  events,
  onSelectEvent,
  date: dateProp,
  onNavigate,
  view: viewProp,
  onViewChange,
  onSelectSlot,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const { weekStartsOn, dimPast } = useCalendarSettings()
  const localizer = useMemo(() => localizerFor(weekStartsOn), [weekStartsOn])
  const [viewState, setViewState] = useState<View>('week')
  const view = viewProp ?? viewState
  const setView = (v: View) => {
    setViewState(v)
    onViewChange?.(v)
  }
  const [dateState, setDateState] = useState<Date>(() => new Date())
  const date = dateProp ?? dateState
  const setDate = (d: Date) => {
    setDateState(d)
    onNavigate?.(d)
  }

  const rbcEvents = useMemo<RbcEvent[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        start: new Date(e.start_at),
        end: new Date(e.end_at),
        allDay: e.all_day,
        resource: e,
      })),
    [events]
  )

  // 24 小时时间轴(00:00–23:00,对标群成员日历):默认 culture(zh-CN)的
  // 时间刻度带上午/下午,这里显式用 HH:mm 覆盖成 24h;周/日视图内的选择/事件
  // 时间提示同样统一为 24h。
  const formats = useMemo(
    () => ({
      // 日视图标题对齐飞书:「2026年7月22日 星期三」(PPP 随 culture 本地化)。
      dayHeaderFormat: 'PPP EEEE',
      timeGutterFormat: 'HH:mm',
      selectRangeFormat: ({ start, end }: { start: Date; end: Date }) =>
        `${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`,
      eventTimeRangeFormat: ({ start, end }: { start: Date; end: Date }) =>
        `${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`,
    }),
    []
  )

  const messages = useMemo(
    () => ({
      today: t('grid.today'),
      previous: t('grid.previous'),
      next: t('grid.next'),
      month: t('grid.month'),
      week: t('grid.week'),
      day: t('grid.day'),
      agenda: t('grid.agenda'),
      date: t('grid.date'),
      time: t('grid.time'),
      event: t('grid.event'),
      noEventsInRange: t('grid.noEvents'),
      showMore: (count: number) => t('grid.showMore', { count }),
    }),
    [t]
  )

  return (
    <Calendar<RbcEvent>
      localizer={localizer}
      culture={cultureFor(i18n.language)}
      events={rbcEvents}
      startAccessor="start"
      endAccessor="end"
      view={view}
      onView={setView}
      date={date}
      onNavigate={setDate}
      views={['month', 'week', 'day', 'agenda']}
      components={rbcComponents}
      popup
      selectable
      formats={formats}
      messages={messages}
      // P8「降低已结束日程的亮度」(对标飞书,日历设置可关):渲染时判断,
      // 不设 tick——交互/取数触发的重渲染足以让新跨过结束时刻的块变淡。
      eventPropGetter={(ev) =>
        dimPast && ev.end < new Date() ? { style: { opacity: 0.45 } } : {}
      }
      onSelectEvent={(ev) => onSelectEvent(ev.resource)}
      onSelectSlot={(slot) => {
        // Month: a day click → all-day draft pinned to that day. Time views:
        // use the dragged/clicked range; a bare click gives a 30-min slot,
        // fall back to +1h when the range is empty.
        const start = slot.start
        if (view === 'month') {
          onSelectSlot?.({ start, end: start, allDay: true })
          return
        }
        const end =
          slot.end > start ? slot.end : new Date(start.getTime() + 3600_000)
        onSelectSlot?.({ start, end, allDay: false })
      }}
      style={{ height: '100%' }}
    />
  )
}

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { zhCN, enUS, fr, de, nl } from 'date-fns/locale'

import 'react-big-calendar/lib/css/react-big-calendar.css'
import './calendarGridOverrides.css'

import type { CalendarEvent } from '../api/ApiCalendar'

/**
 * Feishu-style 月/周/日 calendar grid (P6-e #3), backed by react-big-calendar.
 * Events come from the same fetch the agenda used; clicking one bubbles the
 * underlying CalendarEvent up so the route can open its detail dialog (RSVP /
 * 进入会议). Toolbar labels are localized off the `calendar` namespace.
 */

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
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
  /** Click/drag an empty slot → 飞书式快捷创建,带预填时间。 */
  onSelectSlot?: (draft: SlotDraft) => void
}

export const CalendarGrid = ({
  events,
  onSelectEvent,
  date: dateProp,
  onNavigate,
  onSelectSlot,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const [view, setView] = useState<View>('week')
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
      popup
      selectable
      messages={messages}
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

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { zhCN, enUS, fr, de, nl, type Locale } from 'date-fns/locale'

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

const extraLocales: Record<string, Locale> = { fr, de, nl }
const localeFor = (lng: string): Locale =>
  lng.startsWith('zh') ? zhCN : (extraLocales[lng.slice(0, 2)] ?? enUS)

interface RbcEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: CalendarEvent
}

// 月视图日程展示对齐飞书:全天/跨天日程保留蓝色横条,限时日程改为
// 「蓝点 + 开始时间 + 标题」纯文字行(样式见 calendarGridOverrides.css,
// 由 eventPropGetter 挂 wm-month-timed 类去掉底色)。
const isMonthBar = (e: { allDay: boolean; start: Date; end: Date }) =>
  e.allDay || e.end.getTime() - e.start.getTime() >= 86_400_000

function MonthEvent({ event }: { event: RbcEvent }) {
  if (isMonthBar(event)) return <>{event.title}</>
  return (
    <span className="wm-month-timed-inner">
      <span className="wm-month-timed-dot" />
      <span className="wm-month-timed-time">{format(event.start, 'HH:mm')}</span>
      <span className="wm-month-timed-title">{event.title}</span>
    </span>
  )
}

// 飞书式周视图表头:星期在上、日期数字在下,与全天行视觉合并
// (calendarGridOverrides.css 去掉表头下边线并放大数字)。
const weekHeaderFor = (locale: Locale) =>
  function WeekHeader({ date }: { date: Date }) {
    return (
      <div className="wm-week-header">
        <span className="wm-week-header-weekday">
          {format(date, 'EEE', { locale })}
        </span>
        <span className="wm-week-header-date">{format(date, 'd')}</span>
      </div>
    )
  }

export interface SlotDraft {
  start: Date
  end: Date
  allDay: boolean
}

// 新建日程弹窗期间注入网格的占位草稿事件 id(对齐 Google Calendar:选中
// 时段在弹窗打开时保持高亮)。
const DRAFT_ID = '__slot-draft__'

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
  /** 新建弹窗打开期间的草稿时段:渲染为「(无标题)」占位块保持选中态。 */
  slotDraft?: SlotDraft | null
}

export const CalendarGrid = ({
  events,
  onSelectEvent,
  date: dateProp,
  onNavigate,
  view: viewProp,
  onViewChange,
  onSelectSlot,
  slotDraft,
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

  const rbcEvents = useMemo<RbcEvent[]>(() => {
    const list: RbcEvent[] = events.map((e) => ({
      id: e.id,
      title: e.title,
      start: new Date(e.start_at),
      end: new Date(e.end_at),
      allDay: e.all_day,
      resource: e,
    }))
    if (slotDraft) {
      list.push({
        id: DRAFT_ID,
        title: t('grid.draftTitle'),
        start: slotDraft.start,
        end: slotDraft.end,
        allDay: slotDraft.allDay,
        resource: null as unknown as CalendarEvent,
      })
    }
    return list
  }, [events, slotDraft, t])

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
      // 周/月视图标题对齐飞书:「2026年7月19日 - 25日」「2026年7月」,跨月/
      // 跨年时补齐月份/年份;仅中文覆盖,其他语言保留 rbc 默认格式。
      ...(i18n.language.startsWith('zh')
        ? {
            monthHeaderFormat: 'yyyy年M月',
            dayRangeHeaderFormat: ({
              start,
              end,
            }: {
              start: Date
              end: Date
            }) => {
              const sameYear = start.getFullYear() === end.getFullYear()
              const sameMonth = sameYear && start.getMonth() === end.getMonth()
              const endFmt = sameMonth ? 'd日' : sameYear ? 'M月d日' : 'yyyy年M月d日'
              return `${format(start, 'yyyy年M月d日')} - ${format(end, endFmt)}`
            },
          }
        : {}),
    }),
    [i18n.language]
  )

  // 飞书式工具栏替换 rbc 默认 toolbar;useMemo 保证引用稳定避免重挂,
  // 仅语言切换时重建(周表头星期文案随语言)。
  const rbcComponents = useMemo(
    () => ({
      toolbar: CalendarToolbar,
      week: { header: weekHeaderFor(localeFor(i18n.language)) },
      month: { event: MonthEvent },
    }),
    [i18n.language]
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
      eventPropGetter={(ev) => {
        // 草稿占位块:选中态实心蓝,不参与 dimPast/月视图纯文字行。
        if (ev.id === DRAFT_ID) return { className: 'wm-slot-draft' }
        return {
          // wm-month-timed 只在月视图 CSS 里生效,周/日视图带着也无副作用。
          ...(isMonthBar(ev) ? {} : { className: 'wm-month-timed' }),
          ...(dimPast && ev.end < new Date()
            ? { style: { opacity: 0.45 } }
            : {}),
        }
      }}
      onSelectEvent={(ev) => {
        if (ev.id !== DRAFT_ID) onSelectEvent(ev.resource)
      }}
      onSelectSlot={(slot) => {
        // Month: a day click → all-day draft pinned to that day. Time views:
        // use the dragged/clicked range; a bare click gives a 30-min slot,
        // fall back to +1h when the range is empty.
        const start = slot.start
        if (view === 'month') {
          onSelectSlot?.({ start, end: start, allDay: true })
          return
        }
        // 周/日视图顶部全天行:rbc 给「当天 00:00 → 次日 00:00(开区间)」,
        // 直接透传会弹出 00:00 起止的时间草稿;视为全天日程(对齐月视图),
        // 结束日回退一天转成闭区间。
        const isMidnight = (d: Date) =>
          d.getHours() === 0 && d.getMinutes() === 0
        if (isMidnight(start) && isMidnight(slot.end) && slot.end > start) {
          const endDay = new Date(slot.end.getTime() - 86_400_000)
          onSelectSlot?.({
            start,
            end: endDay > start ? endDay : start,
            allDay: true,
          })
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

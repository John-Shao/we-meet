import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { zhCN, enUS, fr, de, nl, type Locale } from 'date-fns/locale'

import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'
import './calendarGridOverrides.css'

import type { CalendarEvent, RSVPStatus } from '../api/ApiCalendar'
import { useCalendarSettings } from '../hooks/useCalendarSettings'
import { resolveRbcView } from '../utils/rbcView'
import { CalendarToolbar } from './CalendarToolbar'
import { AgendaListView } from './AgendaListView'

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

// 周/日视图事件内容对齐飞书:短日程(≤45 分钟,块高只够一行)渲染成
// 「标题,时间」单行(配套 CSS 隐藏第二行时间标签);长日程保持
// 标题行 + 时间行。中文用全角逗号分隔。
const SHORT_TIMED_MS = 45 * 60_000
const isShortTimed = (e: { allDay: boolean; start: Date; end: Date }) =>
  !e.allDay && e.end.getTime() - e.start.getTime() <= SHORT_TIMED_MS

const timeEventFor = (zh: boolean) =>
  function TimeEvent({ event }: { event: RbcEvent }) {
    if (!isShortTimed(event)) return <>{event.title}</>
    return (
      <>
        {event.title}
        {zh ? '，' : ', '}
        <span className="wm-time-inline">
          {`${format(event.start, 'HH:mm')} – ${format(event.end, 'HH:mm')}`}
        </span>
      </>
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

// 表态状态的块样式:四态四色、一律实线(Web / App 统一)——
// 接受=蓝(默认样式,不加类)、未反馈=紫、待定=琥珀、拒绝=灰 + 删除线。
// 样式落在 calendarGridOverrides.css,月视图的纯文字行把颜色落到圆点上。
// my_rsvp 为空(历史数据里组织者没有 attendee 行)按接受处理。
const rsvpClassFor = (rsvp?: RSVPStatus | null): string => {
  if (rsvp === 'declined') return 'wm-rsvp-declined'
  if (rsvp === 'tentative') return 'wm-rsvp-tentative'
  if (rsvp === 'needs_action') return 'wm-rsvp-needs'
  return ''
}

export interface SlotDraft {
  start: Date
  end: Date
  allDay: boolean
}

// 预选时段注入网格的占位事件 id。对齐飞书/App:周/日视图点(或拖)空白先
// 落这个「添加日程」预选框 —— 可整块拖动移位、可拖上下边界改时长,**再点
// 一次**才打开新建弹窗;弹窗打开期间它继续高亮显示选中的时段。
const DRAFT_ID = '__slot-draft__'

// 拖拽移位/改时长走 rbc 官方 addon(withDragAndDrop)。模块级包一次,组件
// 引用才稳定 —— 放进渲染函数里每次重建都会把整棵网格重挂。
const DnDCalendar = withDragAndDrop<RbcEvent>(Calendar)

// 「日程」视图换成自研平铺列表(AgendaListView,飞书式);模块级常量保证
// 引用稳定避免视图重挂。类型上 rbc 的 Views 不含自定义组件签名,窄化断言。
const RBC_VIEWS = {
  month: true,
  week: true,
  // 显示周末关闭时,周视图渲染层收敛到内置 work_week(周一~周五);切换器/
  // 路由层 view 仍是 'week',仅此处映射,不额外暴露 work_week 分段按钮。
  work_week: true,
  day: true,
  agenda: AgendaListView,
} as unknown as View[]

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
  /** 月视图点某天 → 直接开新建弹窗(全天草稿);时间视图走两步式预选。 */
  onSelectSlot?: (draft: SlotDraft) => void
  /** 当前预选时段:渲染成「添加日程」预选框(可拖动/可改时长)。 */
  slotDraft?: SlotDraft | null
  /** 周/日视图点(或拖选)空白 → 落预选框;已有框时调用方按「点框外」清除。 */
  onDraftSelect?: (draft: SlotDraft) => void
  /** 拖动预选框移位 / 拖边界改时长 → 更新预选时段(与上面分开:这条恒是
   *  「改成这个值」,不参与点框外清除的判定)。 */
  onDraftChange?: (draft: SlotDraft) => void
  /** 再次点击预选框 → 确认,调用方据此打开新建弹窗。 */
  onDraftConfirm?: (draft: SlotDraft) => void
  /** 点到预选框以外(已建日程 / 网格外)→ 清除预选框。 */
  onDraftDismiss?: () => void
  /** 整块拖动已建日程 → 改期(仅 [canMoveEvent] 为 true 的日程可拖)。 */
  onEventMove?: (event: CalendarEvent, start: Date, end: Date) => void
  canMoveEvent?: (event: CalendarEvent) => boolean
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
  onDraftSelect,
  onDraftChange,
  onDraftConfirm,
  onDraftDismiss,
  onEventMove,
  canMoveEvent,
}: Props) => {
  const { t, i18n } = useTranslation('calendar')
  const { weekStartsOn, dimPast, showWeekend, defaultDurationMin } =
    useCalendarSettings()
  const localizer = useMemo(() => localizerFor(weekStartsOn), [weekStartsOn])
  const [viewState, setViewState] = useState<View>('week')
  const view = viewProp ?? viewState
  // 关周末时把周视图映射到内置 work_week(周一~周五);其余视图透传。app 层
  // view 恒为 'week',若 rbc 回吐 work_week(如内部下钻)映射回 'week'。
  const effectiveView = resolveRbcView(view, showWeekend)
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
        title: t('grid.draftAdd'),
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
      // 周/月/日程视图标题对齐飞书:「2026年7月19日 - 25日」「2026年7月」,
      // 跨月/跨年时补齐月份/年份;仅中文覆盖,其他语言保留 rbc 默认格式。
      ...(i18n.language.startsWith('zh')
        ? (() => {
            const zhRange = ({ start, end }: { start: Date; end: Date }) => {
              const sameYear = start.getFullYear() === end.getFullYear()
              const sameMonth = sameYear && start.getMonth() === end.getMonth()
              const endFmt = sameMonth ? 'd日' : sameYear ? 'M月d日' : 'yyyy年M月d日'
              return `${format(start, 'yyyy年M月d日')} - ${format(end, endFmt)}`
            }
            return {
              monthHeaderFormat: 'yyyy年M月',
              dayRangeHeaderFormat: zhRange,
              agendaHeaderFormat: zhRange,
            }
          })()
        : {}),
    }),
    [i18n.language]
  )

  // 飞书式工具栏替换 rbc 默认 toolbar;useMemo 保证引用稳定避免重挂,
  // 仅语言切换时重建(周表头星期文案随语言)。
  const rbcComponents = useMemo(() => {
    const TimeEvent = timeEventFor(i18n.language.startsWith('zh'))
    const weekHeader = weekHeaderFor(localeFor(i18n.language))
    return {
      toolbar: CalendarToolbar,
      week: { header: weekHeader, event: TimeEvent },
      // work_week 复用周视图的表头/事件组件(仅列数收敛为 5)。
      work_week: { header: weekHeader, event: TimeEvent },
      day: { event: TimeEvent },
      month: { event: MonthEvent },
    }
  }, [i18n.language])

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

  // 只有「我组织的、非重复」的日程可整块拖动改期(后端 PATCH 也只放行组织者;
  // 重复日程要走编辑弹窗的三选)。预选框恒可拖、且是唯一可改时长的块 ——
  // 已建日程本轮只做移位,改时长仍走编辑弹窗。
  const isDraft = (ev: RbcEvent) => ev.id === DRAFT_ID
  const draggable = (ev: RbcEvent) =>
    isDraft(ev) || (!!onEventMove && !!canMoveEvent?.(ev.resource))

  /** rbc 回吐的落点 → SlotDraft(月视图/全天行的 isAllDay 透传)。 */
  const asDraft = (
    start: Date | string,
    end: Date | string,
    allDay?: boolean
  ): SlotDraft => ({
    start: new Date(start),
    end: new Date(end),
    allDay: !!allDay,
  })

  return (
    <DnDCalendar
      localizer={localizer}
      culture={cultureFor(i18n.language)}
      events={rbcEvents}
      startAccessor="start"
      endAccessor="end"
      view={effectiveView}
      onView={(v) => setView(v === ('work_week' as View) ? 'week' : v)}
      date={date}
      onNavigate={setDate}
      views={RBC_VIEWS}
      components={rbcComponents}
      popup
      selectable
      formats={formats}
      messages={messages}
      // P8「降低已结束日程的亮度」(对标飞书,日历设置可关):渲染时判断,
      // 不设 tick——交互/取数触发的重渲染足以让新跨过结束时刻的块变淡。
      eventPropGetter={(ev) => {
        // wm-short-timed:周/日视图短日程隐藏第二行时间(由 TimeEvent 内联)。
        const short = isShortTimed(ev) ? ' wm-short-timed' : ''
        // 草稿占位块:选中态实心蓝,不参与 dimPast/月视图纯文字行/表态样式。
        if (ev.id === DRAFT_ID) return { className: `wm-slot-draft${short}` }
        const className = [
          // wm-month-timed 只在月视图 CSS 里生效,周/日视图带着也无副作用。
          isMonthBar(ev) ? '' : `wm-month-timed${short}`,
          rsvpClassFor(ev.resource?.my_rsvp),
        ]
          .filter(Boolean)
          .join(' ')
        return {
          ...(className ? { className } : {}),
          ...(dimPast && ev.end < new Date()
            ? { style: { opacity: 0.45 } }
            : {}),
        }
      }}
      // 预选框可拖动移位(整块)+ 拖上下边界改时长;已建日程只开放移位。
      draggableAccessor={draggable}
      resizableAccessor={isDraft}
      resizable
      onEventDrop={({ event, start, end, isAllDay }) => {
        if (isDraft(event)) {
          onDraftChange?.(asDraft(start, end, isAllDay ?? event.allDay))
          return
        }
        onEventMove?.(event.resource, new Date(start), new Date(end))
      }}
      onEventResize={({ event, start, end }) => {
        if (isDraft(event)) onDraftChange?.(asDraft(start, end, event.allDay))
      }}
      onSelectEvent={(ev) => {
        // 再次点击预选框 = 确认建日程(对齐 App:第一次点空白只是预选)。
        if (isDraft(ev)) {
          if (slotDraft) onDraftConfirm?.(slotDraft)
          return
        }
        // 点已建日程 = 点在预选框以外 → 顺手清掉预选框。
        onDraftDismiss?.()
        onSelectEvent(ev.resource)
      }}
      onSelectSlot={(slot) => {
        // 月视图点某天 = 直接开新建弹窗(全天草稿);月格子没有时间轴,
        // 预选框在那儿既拖不出时段也读不出时刻,两步式没有意义。
        const start = slot.start
        if (view === 'month') {
          onSelectSlot?.({ start, end: start, allDay: true })
          return
        }
        // 时间视图:落预选框(不开弹窗)。onDraftSelect 缺省时(组件独立
        // 使用)退回原来的立即创建。
        const select = onDraftSelect ?? onSelectSlot
        // 周/日视图顶部全天行:rbc 给「当天 00:00 → 次日 00:00(开区间)」,
        // 直接透传会得到 00:00 起止的时间草稿;视为全天日程(对齐月视图),
        // 结束日回退一天转成闭区间。
        const isMidnight = (d: Date) =>
          d.getHours() === 0 && d.getMinutes() === 0
        if (isMidnight(start) && isMidnight(slot.end) && slot.end > start) {
          const endDay = new Date(slot.end.getTime() - 86_400_000)
          select?.({
            start,
            end: endDay > start ? endDay : start,
            allDay: true,
          })
          return
        }
        // 单击 = 按「日程默认时长」落框(对齐 App;rbc 单击只给一格 step);
        // 拖选 = 用拖出来的区间。
        const end =
          slot.action === 'click' || slot.end <= start
            ? new Date(start.getTime() + defaultDurationMin * 60_000)
            : slot.end
        select?.({ start, end, allDay: false })
      }}
      style={{ height: '100%' }}
    />
  )
}

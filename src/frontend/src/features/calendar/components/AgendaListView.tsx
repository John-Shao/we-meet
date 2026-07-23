import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { addDays, addYears, format } from 'date-fns'
import { zhCN, enUS, fr, de, nl, type Locale } from 'date-fns/locale'

import { css, cx } from '@/styled-system/css'
import { ResizablePanel } from '@/components/ResizablePanel'

import type { CalendarEvent } from '../api/ApiCalendar'

/**
 * rbc 自定义「日程」视图(对标飞书重做,替换 rbc 内置 Agenda):
 * - 简单平铺列表,不合并行/列:日期 | 周 | 时间 | 组织者 | 事件
 * - 整行可选,↑/↓ 方向键移动选中并滚动跟随,Enter/双击打开完整详情弹窗
 * - 右侧详情面板(ResizablePanel 可拖宽)展示选中日程概要
 * 以 rbc 自定义视图接入(navigate/title/range 静态方法),工具栏与翻页
 * 沿用 CalendarToolbar。
 *
 * 区间:锚点日期(默认今天,‹/›按天调整或第二栏小月历跳转)起一年
 * [date, date+1y);标题展示闭区间尾日(date+1y-1d)。
 */

const localeFor = (lng: string): Locale => {
  if (lng.startsWith('zh')) return zhCN
  const base = lng.slice(0, 2)
  return { fr, de, nl }[base] ?? enUS
}

interface AgendaEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  /** 草稿占位块 resource 为空,列表里过滤掉。 */
  resource: CalendarEvent | null
}

interface Props {
  date: Date
  events?: AgendaEvent[]
  onSelectEvent?: (ev: AgendaEvent) => void
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

export function AgendaListView({ date, events = [], onSelectEvent }: Props) {
  const { t, i18n } = useTranslation('calendar')
  const locale = localeFor(i18n.language)
  const [, navigate] = useLocation()

  const rows = useMemo(() => {
    const start = new Date(date)
    start.setHours(0, 0, 0, 0)
    const end = addYears(start, 1)
    return events
      .filter((e) => e.resource && e.end > start && e.start < end)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
  }, [events, date])

  // 相同日期的行合并日期格:首行索引 → rowSpan(rows 已按开始时间排序)。
  const dateSpans = useMemo(() => {
    const spans = new Map<number, number>()
    let i = 0
    while (i < rows.length) {
      const key = format(rows[i].start, 'yyyy-MM-dd')
      let j = i + 1
      while (j < rows.length && format(rows[j].start, 'yyyy-MM-dd') === key) j++
      spans.set(i, j - i)
      i = j
    }
    return spans
  }, [rows])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = rows.find((r) => r.id === selectedId) ?? null
  // 提前收窄成非空 const,闭包(onClick)里 TS 才保得住类型。
  const detail = selected?.resource ?? null

  // 选中行滚动跟随(方向键连按时保持可见)。
  useEffect(() => {
    if (!selectedId) return
    listRef.current
      ?.querySelector(`[data-row-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const move = (delta: number) => {
    if (!rows.length) return
    const idx = rows.findIndex((r) => r.id === selectedId)
    const next =
      idx < 0 ? (delta > 0 ? 0 : rows.length - 1) : clamp(idx + delta, 0, rows.length - 1)
    setSelectedId(rows[next].id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter' && selected) {
      onSelectEvent?.(selected)
    }
  }

  const timeCell = (e: AgendaEvent) =>
    e.allDay
      ? t('form.allDay')
      : `${format(e.start, 'HH:mm')} – ${format(e.end, 'HH:mm')}`

  const detailTime = (e: AgendaEvent) => {
    if (e.allDay) return `${format(e.start, 'yyyy-MM-dd')} ${t('form.allDay')}`
    const sameDay = e.start.toDateString() === e.end.toDateString()
    return sameDay
      ? `${format(e.start, 'yyyy-MM-dd HH:mm')} – ${format(e.end, 'HH:mm')}`
      : `${format(e.start, 'yyyy-MM-dd HH:mm')} – ${format(e.end, 'yyyy-MM-dd HH:mm')}`
  }

  return (
    <div
      className={css({
        display: 'flex',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        border: '1px solid token(colors.greyscale.200)',
        borderRadius: '0.375rem',
      })}
    >
      {/* 列表区:tabIndex 承接方向键 */}
      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label={t('grid.agenda')}
        onKeyDown={onKeyDown}
        className={css({
          flex: 1,
          minWidth: 0,
          overflowY: 'auto',
          outline: 'none',
          backgroundColor: 'greyscale.000',
        })}
      >
        {rows.length === 0 ? (
          <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('grid.noEvents')}
          </div>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>
                {/* 前三列(日期/时间/组织者)表头表体统一左右居中 */}
                <th className={cx(thCls, centerCls, css({ width: '10.5rem' }))}>
                  {t('grid.date')}
                </th>
                <th className={cx(thCls, centerCls, css({ width: '9rem' }))}>
                  {t('grid.time')}
                </th>
                <th className={cx(thCls, centerCls, css({ width: '9rem' }))}>
                  {t('grid.organizer')}
                </th>
                <th className={cx(thCls, leftCls)}>{t('grid.event')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isSel = r.id === selectedId
                const span = dateSpans.get(idx)
                return (
                  <tr
                    key={r.id}
                    data-row-id={r.id}
                    role="option"
                    aria-selected={isSel}
                    onClick={() => setSelectedId(r.id)}
                    onDoubleClick={() => onSelectEvent?.(r)}
                    className={cx(rowCls, isSel ? rowSelCls : rowIdleCls)}
                  >
                    {/* 同日期合并展示(rowSpan),居中;选中/悬停高亮不覆盖此列。
                       星期是日期的冗余表达,并入同格(对齐飞书);今天蓝色加粗
                       作视觉锚点。 */}
                    {span !== undefined && (
                      <td
                        data-merged-date
                        rowSpan={span}
                        className={
                          format(r.start, 'yyyy-MM-dd') ===
                          format(new Date(), 'yyyy-MM-dd')
                            ? dateTdTodayCls
                            : dateTdCls
                        }
                      >
                        {`${format(r.start, 'yyyy-MM-dd')} ${format(r.start, 'EEE', { locale })}`}
                      </td>
                    )}
                    <td className={cx(tdCls, centerCls)}>{timeCell(r)}</td>
                    <td className={cx(tdCls, ellipsisCls, centerCls)}>
                      {r.resource?.organizer?.full_name || '—'}
                    </td>
                    <td className={cx(tdCls, ellipsisCls)}>{r.title}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 右侧详情面板(可拖宽) */}
      <ResizablePanel
        storageKey="we-meet:agenda-detail-width"
        defaultWidth={320}
        min={260}
        max={520}
        side="right"
      >
        <div
          className={css({
            height: '100%',
            overflowY: 'auto',
            padding: '1rem',
            backgroundColor: 'greyscale.000',
            borderLeft: '1px solid token(colors.greyscale.200)',
          })}
        >
          {selected && detail ? (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })}>
              <h3
                className={css({
                  margin: 0,
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: 'greyscale.900',
                  overflowWrap: 'anywhere',
                })}
              >
                {selected.title}
              </h3>
              <div className={css({ fontSize: '0.875rem', color: 'greyscale.800' })}>
                {detailTime(selected)}
              </div>
              <div className={detailRowCls}>
                <span className={detailLabelCls}>{t('card.organizer')}</span>
                <span>{detail.organizer?.full_name || '—'}</span>
              </div>
              <div className={detailRowCls}>
                <span className={detailLabelCls}>
                  {t('detail.attendeesTitle', {
                    count: detail.attendees.length,
                  })}
                </span>
                <span className={css({ overflowWrap: 'anywhere' })}>
                  {detail.attendees.map((a) => a.full_name || a.email).join('、')}
                </span>
              </div>
              {detail.description && (
                <div
                  className={css({
                    fontSize: '0.8125rem',
                    color: 'greyscale.700',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    borderTop: '1px solid token(colors.greyscale.100)',
                    paddingTop: '0.75rem',
                  })}
                >
                  {detail.description}
                </div>
              )}
              {detail.room_slug && (
                <button
                  type="button"
                  onClick={() => navigate(`/${detail.room_slug}`)}
                  data-testid="agenda-join"
                  className={joinBtnCls}
                >
                  {t('card.join')}
                </button>
              )}
            </div>
          ) : (
            <div className={css({ fontSize: '0.875rem', color: 'greyscale.500' })}>
              {t('grid.detailHint')}
            </div>
          )}
        </div>
      </ResizablePanel>
    </div>
  )
}

// ---- rbc 自定义视图静态接口 ----
// 区间一年;‹/› 按天调整锚点日期;标题尾日按闭区间展示(+1y-1d)。

AgendaListView.range = (start: Date) => ({ start, end: addYears(start, 1) })

AgendaListView.navigate = (date: Date, action: string) => {
  switch (action) {
    case 'PREV':
      return addDays(date, -1)
    case 'NEXT':
      return addDays(date, 1)
    default:
      return date
  }
}

AgendaListView.title = (
  start: Date,
  opts: { localizer: { format: (range: unknown, fmt: string) => string } }
) =>
  opts.localizer.format(
    { start, end: addDays(addYears(start, 1), -1) },
    'agendaHeaderFormat'
  )

// ---- 样式 ----

const tableCls = css({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
})

// textAlign 不放在 thCls 里:各列用 centerCls/leftCls 单独指定,避免 cx
// 叠加同属性原子类按样式表顺序取胜的陷阱(panda-cx-atomic-order-trap)。
const thCls = css({
  position: 'sticky',
  top: 0,
  zIndex: 1,
  fontWeight: 500,
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  backgroundColor: 'greyscale.50',
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const rowCls = css({
  cursor: 'pointer',
  userSelect: 'none',
})

// 选中/未选中两个完整类切换,不 cx 叠加同属性(panda-cx-atomic-order-trap)。
// 高亮打在日期列以外的单元格上:合并的日期格(data-merged-date)保持素色。
const rowSelCls = css({
  '& td:not([data-merged-date])': {
    backgroundColor: 'primary.100',
  },
  _dark: {
    '& td:not([data-merged-date])': {
      backgroundColor: 'rgba(51, 112, 255, 0.28)',
    },
  },
})

const rowIdleCls = css({
  '&:hover td:not([data-merged-date])': {
    backgroundColor: 'greyscale.50',
  },
})

const tdCls = css({
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  color: 'greyscale.800',
  whiteSpace: 'nowrap',
})

/** 合并的日期格:水平/垂直居中,不参与行选中高亮。 */
const dateTdCls = css({
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  color: 'greyscale.800',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  verticalAlign: 'middle',
})

const centerCls = css({ textAlign: 'center' })
// th 浏览器默认居中,事件列需显式左对齐。
const leftCls = css({ textAlign: 'left' })

const ellipsisCls = css({
  maxWidth: 0,
  minWidth: '6rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})

/** 今天的日期格:蓝色加粗视觉锚点。与 dateTdCls 整类切换,不 cx 叠加同
 * 属性(panda-cx-atomic-order-trap);深色下 primary 不翻转,换 primaryDark。 */
const dateTdTodayCls = css({
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  verticalAlign: 'middle',
  color: 'primary.600',
  fontWeight: 600,
  _dark: { color: 'primaryDark.700' },
})

/** 进入会议:样式对齐 EventDetailDialog 的 detail-join。 */
const joinBtnCls = css({
  marginTop: '0.25rem',
  paddingX: '1rem',
  paddingY: '0.5rem',
  border: 'none',
  borderRadius: '0.5rem',
  backgroundColor: 'primary.500',
  color: 'white',
  fontSize: '0.875rem',
  fontWeight: 'medium',
  cursor: 'pointer',
})

const detailRowCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.875rem',
  color: 'greyscale.800',
})

const detailLabelCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
})

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { addDays, format } from 'date-fns'
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
 * 沿用 CalendarToolbar,翻页步长与内置 Agenda 一致(30 天)。
 */

const AGENDA_LENGTH_DAYS = 30

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
  length?: number
  onSelectEvent?: (ev: AgendaEvent) => void
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

export function AgendaListView({
  date,
  events = [],
  length = AGENDA_LENGTH_DAYS,
  onSelectEvent,
}: Props) {
  const { t, i18n } = useTranslation('calendar')
  const locale = localeFor(i18n.language)

  const rows = useMemo(() => {
    const start = new Date(date)
    start.setHours(0, 0, 0, 0)
    const end = addDays(start, length)
    return events
      .filter((e) => e.resource && e.end > start && e.start < end)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
  }, [events, date, length])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = rows.find((r) => r.id === selectedId) ?? null

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
                <th className={cx(thCls, css({ width: '7.5rem' }))}>
                  {t('grid.date')}
                </th>
                <th className={cx(thCls, css({ width: '4.5rem' }))}>
                  {t('grid.weekday')}
                </th>
                <th className={cx(thCls, css({ width: '9rem' }))}>
                  {t('grid.time')}
                </th>
                <th className={cx(thCls, css({ width: '9rem' }))}>
                  {t('grid.organizer')}
                </th>
                <th className={thCls}>{t('grid.event')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSel = r.id === selectedId
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
                    <td className={tdCls}>{format(r.start, 'yyyy-MM-dd')}</td>
                    <td className={tdCls}>{format(r.start, 'EEE', { locale })}</td>
                    <td className={tdCls}>{timeCell(r)}</td>
                    <td className={cx(tdCls, ellipsisCls)}>
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
          {selected?.resource ? (
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
                <span>{selected.resource.organizer?.full_name || '—'}</span>
              </div>
              <div className={detailRowCls}>
                <span className={detailLabelCls}>
                  {t('detail.attendeesTitle', {
                    count: selected.resource.attendees.length,
                  })}
                </span>
                <span className={css({ overflowWrap: 'anywhere' })}>
                  {selected.resource.attendees
                    .map((a) => a.full_name || a.email)
                    .join('、')}
                </span>
              </div>
              {selected.resource.description && (
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
                  {selected.resource.description}
                </div>
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

// ---- rbc 自定义视图静态接口(工具栏标题/翻页步长 30 天) ----

AgendaListView.range = (start: Date, opts?: { length?: number }) => {
  const length = opts?.length ?? AGENDA_LENGTH_DAYS
  return { start, end: addDays(start, length) }
}

AgendaListView.navigate = (
  date: Date,
  action: string,
  opts?: { length?: number }
) => {
  const length = opts?.length ?? AGENDA_LENGTH_DAYS
  switch (action) {
    case 'PREV':
      return addDays(date, -length)
    case 'NEXT':
      return addDays(date, length)
    default:
      return date
  }
}

AgendaListView.title = (
  start: Date,
  opts: {
    length?: number
    localizer: { format: (range: unknown, fmt: string) => string }
  }
) => {
  const length = opts.length ?? AGENDA_LENGTH_DAYS
  return opts.localizer.format(
    { start, end: addDays(start, length) },
    'agendaHeaderFormat'
  )
}

// ---- 样式 ----

const tableCls = css({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
})

const thCls = css({
  position: 'sticky',
  top: 0,
  zIndex: 1,
  textAlign: 'left',
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
const rowSelCls = css({
  backgroundColor: 'primary.100',
  _dark: { backgroundColor: 'rgba(51, 112, 255, 0.28)' },
})

const rowIdleCls = css({
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.50' },
})

const tdCls = css({
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  color: 'greyscale.800',
  whiteSpace: 'nowrap',
})

const ellipsisCls = css({
  maxWidth: 0,
  minWidth: '6rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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

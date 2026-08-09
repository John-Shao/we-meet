import { useTranslation } from 'react-i18next'
import type { ToolbarProps, View } from 'react-big-calendar'
import { isToday } from 'date-fns'

import { css, cx } from '@/styled-system/css'
import { navGlyphCls } from '@/styles/controls'
import { Button } from '@/primitives'
import type { TimeRangeMode } from '../utils/workingHours'

/**
 * 飞书式日历工具栏,替换 react-big-calendar 默认 toolbar(P8 微调):
 * 网格上方左侧为「‹ / 今天 / › + 日期标题」,右侧为「日/周/月/列表」
 * 视图切换。页面级「日历/会议室」留在上层,避免两种层级的切换器混在一起。
 * view 状态由路由层受控。文案沿用 calendar:grid.*;日视图看今天时标题后缀
 * 蓝色「今天」,对齐飞书。翻页箭头与 MiniCalendar 同用 ‹ › 字形。
 */

// 飞书分段控件顺序是 日|周|月,与 rbc 传入的 views 顺序无关,这里显式排序。
const VIEW_ORDER: View[] = ['day', 'week', 'month', 'agenda']

const segmentBase = css({
  paddingX: '1.25rem',
  paddingY: '0.4375rem',
  // 单字的日/周/月与两字的「日程」等宽:min-width 取「日程」自然宽度
  // (两字 28px + 左右 padding 40px)。
  minWidth: '4.25rem',
  textAlign: 'center',
  border: 'none',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  transition:
    'background token(durations.normal), color token(durations.normal)',
})

// 选中/未选中用两个完整类切换,不 cx 叠加同属性原子类(样式表顺序陷阱)。
const segmentActive = css({
  backgroundColor: 'greyscale.000',
  color: 'primary.600',
  fontWeight: 600,
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
  // primary.* 固定色阶不随主题翻转,深底上翻到 primaryDark 亮蓝保证可读。
  _dark: { color: 'primaryDark.700' },
})

const segmentIdle = css({
  backgroundColor: 'transparent',
  color: 'greyscale.700',
  _hover: { color: 'greyscale.900' },
})

/** 「日/周/月/列表」分段切换器,由日历内部工具栏右侧渲染。 */
export const CalendarViewSwitcher = ({
  view,
  onView,
  views = VIEW_ORDER,
}: {
  view: View
  onView: (view: View) => void
  views?: View[]
}) => {
  const { t } = useTranslation('calendar')
  const ordered = VIEW_ORDER.filter((v) => views.includes(v))
  return (
    <div
      className={css({
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        borderRadius: '0.5rem',
        backgroundColor: 'greyscale.100',
      })}
    >
      {ordered.map((v) => (
        <button
          key={v}
          type="button"
          className={cx(segmentBase, v === view ? segmentActive : segmentIdle)}
          onClick={() => onView(v)}
        >
          {t(`grid.${v}`)}
        </button>
      ))}
    </div>
  )
}

export const TimeRangeSwitcher = ({
  value,
  onChange,
}: {
  value: TimeRangeMode
  onChange: (value: TimeRangeMode) => void
}) => {
  const { t } = useTranslation('calendar')
  return (
    <div
      className={css({
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        borderRadius: '0.5rem',
        backgroundColor: 'greyscale.100',
      })}
      aria-label={t('settings.workingHours')}
    >
      {(['work', 'full'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          className={cx(
            css({
              minWidth: '4.75rem',
              paddingX: '0.75rem',
              paddingY: '0.4375rem',
              border: 'none',
              borderRadius: '0.375rem',
              fontSize: '0.8125rem',
              cursor: 'pointer',
            }),
            value === mode ? segmentActive : segmentIdle
          )}
          onClick={() => onChange(mode)}
        >
          {t(mode === 'work' ? 'grid.workTime' : 'grid.fullDay')}
        </button>
      ))}
    </div>
  )
}

// 翻页箭头 tooltip 按视图区分:日=前一天/后一天、周=上周/下周、
// 月=上个月/下个月;日程视图锚点按天调整,同「前一天/后一天」。
const NAV_TIP_KEYS: Partial<Record<View, [string, string]>> = {
  day: ['grid.prevDay', 'grid.nextDay'],
  week: ['grid.prevWeek', 'grid.nextWeek'],
  // 关周末时周视图渲染为 work_week,翻页语义仍是上周/下周。
  work_week: ['grid.prevWeek', 'grid.nextWeek'],
  month: ['grid.prevMonth', 'grid.nextMonth'],
  agenda: ['grid.prevDay', 'grid.nextDay'],
}

export function CalendarToolbar<
  TEvent extends object,
  TResource extends object,
>({
  label,
  date,
  view,
  onNavigate,
  onView,
  timeRangeMode,
  onTimeRangeModeChange,
  outsideEventCount = 0,
}: ToolbarProps<TEvent, TResource> & {
  timeRangeMode?: TimeRangeMode
  onTimeRangeModeChange?: (value: TimeRangeMode) => void
  outsideEventCount?: number
}) {
  const { t } = useTranslation('calendar')
  const [prevKey, nextKey] = NAV_TIP_KEYS[view] ?? [
    'grid.previous',
    'grid.next',
  ]

  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '0.75rem',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
        })}
      >
        <Button
          variant="quaternaryText"
          size="icon32"
          className={navGlyphCls}
          aria-label={t(prevKey)}
          tooltip={t(prevKey)}
          onPress={() => onNavigate('PREV')}
        >
          ‹
        </Button>
        <Button
          variant="quaternaryText"
          size="action"
          onPress={() => onNavigate('TODAY')}
        >
          {t('grid.today')}
        </Button>
        <Button
          variant="quaternaryText"
          size="icon32"
          className={navGlyphCls}
          aria-label={t(nextKey)}
          tooltip={t(nextKey)}
          onPress={() => onNavigate('NEXT')}
        >
          ›
        </Button>
        <span
          className={css({
            marginLeft: '0.25rem',
            fontSize: '1rem',
            color: 'greyscale.900',
          })}
        >
          {label}
        </span>
        {view === 'day' && isToday(date) && (
          <span
            className={css({
              fontSize: '0.875rem',
              fontWeight: 600,
              color: 'primary.600',
              _dark: { color: 'primaryDark.700' },
            })}
          >
            {t('grid.today')}
          </span>
        )}
      </div>
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.5rem',
          minWidth: 0,
        })}
      >
        {(view === 'day' || view === 'week' || view === 'work_week') &&
          timeRangeMode &&
          onTimeRangeModeChange && (
            <>
              {timeRangeMode === 'work' && outsideEventCount > 0 && (
                <button
                  type="button"
                  className={css({
                    border: 'none',
                    background: 'transparent',
                    color: 'primary.600',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    _dark: { color: 'primaryDark.700' },
                  })}
                  onClick={() => onTimeRangeModeChange('full')}
                >
                  {t('grid.outsideEvents', { count: outsideEventCount })}
                </button>
              )}
              <TimeRangeSwitcher
                value={timeRangeMode}
                onChange={onTimeRangeModeChange}
              />
            </>
          )}
        <CalendarViewSwitcher
          view={view === ('work_week' as View) ? 'week' : view}
          onView={onView}
        />
      </div>
    </div>
  )
}

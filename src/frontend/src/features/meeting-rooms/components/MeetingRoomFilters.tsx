import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'

import type { RoomFilters } from '../api/ApiMeetingRoom'
import {
  fetchMeetingRoomFacilities,
  fetchMeetingRoomNodes,
} from '../api/fetchMeetingRooms'
import { flattenTree } from '../utils/roomHierarchy'
import { MeetingRoomLevelFilters } from './MeetingRoomLevelFilters'

/** Capacity buckets offered in the dropdown ("至少 N 人"). */
const CAPACITY_STEPS = [2, 4, 6, 10, 20, 50]

/**
 * Level / capacity / facility filters, shared by the booking picker and the
 * timeline tab so both narrow the room list the same way.
 */
export const MeetingRoomFilters = ({
  value,
  onChange,
  compact = false,
}: {
  value: RoomFilters
  onChange: (next: RoomFilters) => void
  /** Inline in the event form: drop the search box, the picker has its own. */
  compact?: boolean
}) => {
  const { t } = useTranslation('meeting-rooms')

  const { data: nodes = [] } = useQuery({
    queryKey: ['meeting-rooms', 'nodes'],
    queryFn: fetchMeetingRoomNodes,
    staleTime: 5 * 60_000,
  })
  const { data: facilities = [] } = useQuery({
    queryKey: ['meeting-rooms', 'facilities'],
    queryFn: fetchMeetingRoomFacilities,
    staleTime: 5 * 60_000,
  })

  const selectedFacilities = value.facilityIds ?? []
  const toggleFacility = (id: string) =>
    onChange({
      ...value,
      facilityIds: selectedFacilities.includes(id)
        ? selectedFacilities.filter((f) => f !== id)
        : [...selectedFacilities, id],
    })

  return (
    <div className={rowCls}>
      {!compact && (
        <input
          type="search"
          className={searchCls}
          value={value.q ?? ''}
          onChange={(event) => onChange({ ...value, q: event.target.value })}
          placeholder={t('picker.searchPlaceholder')}
          aria-label={t('picker.searchPlaceholder')}
          data-testid="mr-filter-search"
        />
      )}

      {compact ? (
        <select
          className={cx(selectChrome, selectCls)}
          value={value.node ?? ''}
          onChange={(e) => onChange({ ...value, node: e.target.value || null })}
          aria-label={t('filters.level')}
          data-testid="mr-filter-level"
        >
          <option value="">{t('filters.levelAll')}</option>
          {flattenTree(nodes).map(({ node, indent }) => (
            <option key={node.id} value={node.id}>
              {`${indent}${node.name}`}
            </option>
          ))}
        </select>
      ) : (
        <MeetingRoomLevelFilters
          nodes={nodes}
          selectedNodeId={value.node}
          onChange={(node) => onChange({ ...value, node })}
        />
      )}

      <select
        className={cx(selectChrome, selectCls)}
        value={value.capacityMin ?? ''}
        onChange={(e) =>
          onChange({
            ...value,
            capacityMin: e.target.value ? Number(e.target.value) : null,
          })
        }
        aria-label={t('filters.capacity')}
        data-testid="mr-filter-capacity"
      >
        <option value="">{t('filters.capacityAny')}</option>
        {CAPACITY_STEPS.map((n) => (
          <option key={n} value={n}>
            {t('filters.capacityAtLeast', { count: n })}
          </option>
        ))}
      </select>

      {facilities.length > 0 && (
        <div className={facilityRowCls}>
          {facilities.map((facility) => {
            const on = selectedFacilities.includes(facility.id)
            return (
              <button
                key={facility.id}
                type="button"
                onClick={() => toggleFacility(facility.id)}
                aria-pressed={on}
                data-testid={`mr-filter-facility-${facility.code || facility.id}`}
                /* Two complete classes rather than cx-layering the same
                   properties — atomic classes win by stylesheet order, not
                   by the order they are written here. */
                className={on ? facilityChipOn : facilityChipOff}
              >
                {facility.name}
              </button>
            )
          })}
        </div>
      )}

      {!compact &&
        (selectedFacilities.length > 0 ||
          value.node ||
          value.capacityMin ||
          value.q) && (
          <button
            type="button"
            className={resetCls}
            onClick={() => onChange({})}
          >
            {t('filters.reset')}
          </button>
        )}
    </div>
  )
}

const rowCls = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
})
/**
 * 筛选行里的下拉。
 *
 * `border` 不能省:panda preflight 把 `*` 的 border-width 清成 0,而 selectChrome
 * 只管外观(高度 / 箭头 / 底色)不管边框 —— 原先这两个下拉是**一点框都没有**的白
 * 方块,同一页别处的下拉却都有 1px 灰框。更要紧的是「聚焦时描边变蓝」(见
 * styles/index.css 的统一焦点描边)得有一条边框可染,没有边框就只剩一圈悬空光环。
 */
const selectCls = css({
  fontSize: '0.8125rem',
  minWidth: '8rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: 4,
})
/**
 * 搜索框。
 *
 * 刻意**不**套 selectChrome:它是给原生 `<select>` 的(自绘下拉箭头 + 右侧留位),
 * 套在 `<input type="search">` 上等于给搜索框画了个假的下拉箭头 —— 原先就是这样。
 * 高度仍钉 control.md 并清掉 paddingBlock,与同一行的下拉齐平(理由见
 * primitives/selectChrome.ts 的注释:留着 paddingY 会把文字上下切掉)。
 */
const searchCls = css({
  minWidth: '13rem',
  fontSize: '0.8125rem',
  height: 'control.md',
  minHeight: 'control.md',
  paddingBlock: 0,
  paddingX: '0.625rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: 4,
  backgroundColor: 'greyscale.000',
})
const facilityRowCls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.25rem',
})
const facilityChipBase = {
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  cursor: 'pointer',
} as const
const facilityChipOff = css({
  ...facilityChipBase,
  border: '1px solid token(colors.greyscale.300)',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
})
const facilityChipOn = css({
  ...facilityChipBase,
  border: '1px solid token(colors.selected.accent)',
  backgroundColor: 'selected.bg',
  color: 'selected.text',
})
const resetCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})

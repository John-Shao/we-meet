import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { SearchBox } from '@/primitives/SearchBox'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { RoomFilters } from '../api/ApiMeetingRoom'
import {
  fetchMeetingRoomFacilities,
  fetchMeetingRoomNodes,
} from '../api/fetchMeetingRooms'
import { flattenTree } from '../utils/roomHierarchy'

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
  /** The selection modal provides its own search box and hides reset. */
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
        <SearchBox
          value={value.q ?? ''}
          onChange={(q) => onChange({ ...value, q })}
          placeholder={t('picker.searchPlaceholder')}
          testId="mr-filter-search"
          className={searchBoxCls}
        />
      )}

      <Select
        className={selectCls}
        selectedKey={value.node ?? ''}
        onSelectionChange={(key) =>
          onChange({ ...value, node: String(key) || null })
        }
        aria-label={t('filters.level')}
        data-testid="mr-filter-level"
        items={[
          { value: '', label: t('filters.levelAll') },
          ...flattenTree(nodes).map(({ node, indent }) => ({
            value: node.id,
            label: `${indent}${node.name}`,
          })),
        ]}
      />

      <Select
        className={selectCls}
        selectedKey={String(value.capacityMin ?? '')}
        onSelectionChange={(key) =>
          onChange({
            ...value,
            capacityMin: key ? Number(key) : null,
          })
        }
        aria-label={t('filters.capacity')}
        data-testid="mr-filter-capacity"
        items={[
          { value: '', label: t('filters.capacityAny') },
          ...CAPACITY_STEPS.map((n) => ({
            value: String(n),
            label: t('filters.capacityAtLeast', { count: n }),
          })),
        ]}
      />

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
  minWidth: '8rem',
})
/**
 * 搜索框的排布:只钉最小宽度,长相由统一搜索框 SearchBox 负责。
 *
 * 13rem 是改前那颗原生 input 的 `minWidth` —— 这一行会换行(`flexWrap`),窄容器
 * 下几个下拉 + 搜索框摆不下时它得有自己的宽度,不能被压成一条。同一行的两个
 * 下拉走 selectCls 的 `minWidth: 8rem`,两者互不影响。
 */
const searchBoxCls = css({
  minWidth: '13rem',
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

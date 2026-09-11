import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiSearchLine } from '@remixicon/react'

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
        <label className={searchWrapCls}>
          <input
            type="search"
            className={searchCls}
            value={value.q ?? ''}
            onChange={(event) => onChange({ ...value, q: event.target.value })}
            placeholder={t('picker.searchPlaceholder')}
            aria-label={t('picker.searchPlaceholder')}
            data-testid="mr-filter-search"
          />
          {/* 放大镜画在框内右端(而不是通讯录那样在左侧),位置见 searchIconCls。 */}
          <RiSearchLine size={14} aria-hidden className={searchIconCls} />
        </label>
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
 * 搜索框。
 *
 * 刻意**不**套 selectChrome:它是给原生 `<select>` 的(自绘下拉箭头 + 右侧留位),
 * 套在 `<input type="search">` 上等于给搜索框画了个假的下拉箭头 —— 原先就是这样。
 * 高度仍钉 control.md 并清掉 paddingBlock,与同一行的下拉齐平(理由见
 * primitives/selectChrome.ts 的注释:留着 paddingY 会把文字上下切掉)。
 *
 * 右侧留出 1.75rem 是给框内那枚放大镜(见 searchIconCls)的:不留位时输入到末尾
 * 的文字会顶到图标下面。
 *
 * 不必再收 `::-webkit-search-cancel-button`(Chromium / Safari 给 `type="search"`
 * 画在框内右缘的那个原生 ✕):panda 的 preflight 已经给 `::-webkit-search-decoration,
 * ::-webkit-search-cancel-button` 写了 `-webkit-appearance: none`,右端本来就是空的,
 * 放大镜不会和它叠在一起。顺带记一笔:那个选择器写进 css() 也**不会**生效 ——
 * panda 的静态提取不认 `&::-webkit-*` 这类伪元素,整条会被静默丢掉(构建产物里
 * 查无此规则),真要收它得走 styles/index.css 那种原生 CSS。
 */
const searchCls = css({
  minWidth: '13rem',
  fontSize: '0.8125rem',
  height: 'control.md',
  minHeight: 'control.md',
  paddingBlock: 0,
  paddingLeft: '0.625rem',
  paddingRight: '1.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: 4,
  backgroundColor: 'greyscale.000',
})
/**
 * 放大镜的落位容器:框是 input 自己画的,这里只负责让图标能绝对定位到框内右端。
 */
const searchWrapCls = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
})
/**
 * 框内右端那枚放大镜。
 *
 * `pointerEvents: 'none'` 不能省:图标浮在 input 之上,否则点它、从它上面起手拖选
 * 文字都会被这层 svg 吃掉,光标也不落到输入框上。纯粹是「这是个搜索框」的视觉提示,
 * 不做按钮 —— 本页是边打边筛,没有需要点一下才发出的搜索动作。
 */
const searchIconCls = css({
  position: 'absolute',
  right: '0.5rem',
  color: 'greyscale.500',
  pointerEvents: 'none',
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

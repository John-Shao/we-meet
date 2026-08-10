import { describe, expect, it } from 'vitest'

import type { MeetingRoomAvailability } from '../api/ApiMeetingRoom'
import {
  availableIdSet,
  capacityFits,
  clipToWindow,
  hasConflict,
  rangesOverlap,
  selectionConflicts,
} from './roomAvailability'

const at = (h: number, m = 0) => new Date(2026, 6, 25, h, m, 0, 0).toISOString()
const date = (h: number, m = 0) => new Date(2026, 6, 25, h, m, 0, 0)

const room = (id: string, isAvailable: boolean): MeetingRoomAvailability => ({
  id,
  name: id,
  code: '',
  floor: '3F',
  capacity: 10,
  description: '',
  node: { id: 'n', name: 'n' },
  path_label: 'n',
  timezone: 'Asia/Shanghai',
  facilities: [],
  is_active: true,
  requires_approval: false,
  is_available: isAvailable,
  busy: [],
})

describe('rangesOverlap', () => {
  it('相邻不重叠:10:00–11:00 与 11:00–12:00 不算冲突', () => {
    expect(rangesOverlap(at(10), at(11), at(11), at(12))).toBe(false)
  })

  it('部分重叠算冲突:10:00–11:00 与 10:30–11:30', () => {
    expect(rangesOverlap(at(10), at(11), at(10, 30), at(11, 30))).toBe(true)
  })

  it('完全包含算冲突', () => {
    expect(rangesOverlap(at(9), at(18), at(10), at(11))).toBe(true)
  })
})

describe('hasConflict', () => {
  it('已订 10–11,查 11–12 判为不冲突(半开区间)', () => {
    const busy = [{ start: at(10), end: at(11) }]
    expect(hasConflict(busy, date(11), date(12))).toBe(false)
  })

  it('已订 10–11,查 10:30–11:30 判为冲突', () => {
    const busy = [{ start: at(10), end: at(11) }]
    expect(hasConflict(busy, date(10, 30), date(11, 30))).toBe(true)
  })

  it('无占用时永不冲突', () => {
    expect(hasConflict([], date(10), date(11))).toBe(false)
  })
})

describe('clipToWindow', () => {
  it('跨零点的预订被裁剪到当日窗口内', () => {
    const clipped = clipToWindow(
      { start: at(22), end: new Date(2026, 6, 26, 2).toISOString() },
      date(0),
      new Date(2026, 6, 26, 0, 0, 0, 0)
    )
    expect(clipped).not.toBeNull()
    expect(new Date(clipped!.end).getDate()).toBe(26)
    expect(new Date(clipped!.end).getHours()).toBe(0)
  })

  it('完全落在窗口外的预订返回 null', () => {
    const clipped = clipToWindow(
      { start: at(10), end: at(11) },
      new Date(2026, 6, 26, 0, 0, 0, 0),
      new Date(2026, 6, 27, 0, 0, 0, 0)
    )
    expect(clipped).toBeNull()
  })
})

describe('capacityFits', () => {
  it('容量不足的会议室被判为不满足', () => {
    expect(capacityFits(4, 8)).toBe(false)
    expect(capacityFits(8, 8)).toBe(true)
  })

  it('容量 0 = 未填,不参与筛选', () => {
    expect(capacityFits(0, 50)).toBe(true)
  })
})

describe('selectionConflicts', () => {
  const rows = [room('free', true), room('taken', false)]

  it('已选会议室在新时段被占用 → 报冲突', () => {
    expect(selectionConflicts('taken', rows)).toBe(true)
  })

  it('已选会议室仍可用 → 不报冲突', () => {
    expect(selectionConflicts('free', rows)).toBe(false)
  })

  it('可用性还没回来时不报冲突,避免提交按钮闪烁误禁用', () => {
    expect(selectionConflicts('taken', [])).toBe(false)
  })

  it('没选会议室时不报冲突', () => {
    expect(selectionConflicts(null, rows)).toBe(false)
  })
})

describe('availableIdSet', () => {
  it('只收可用的会议室 id,供列表置灰其余项', () => {
    const ids = availableIdSet([room('a', true), room('b', false)])
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(false)
  })
})

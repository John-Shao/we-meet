import { describe, expect, it } from 'vitest'

import type { MeetingRoomNode } from '../api/ApiMeetingRoom'
import {
  childrenOf,
  compactRoomPathLabel,
  descendantIds,
  flattenTree,
  pathLabelOf,
  validMoveTargets,
} from './roomHierarchy'

/** Ids are dashless in `path`, so keep the two forms consistent here. */
const node = (
  id: string,
  name: string,
  parent: string | null,
  path: string,
  depth: number
): MeetingRoomNode => ({
  id,
  name,
  parent,
  path,
  depth,
  level_number: (depth + 1) as 1 | 2 | 3 | 4,
  level_type: ['country_region', 'city', 'campus', 'building'][depth] as
    | 'country_region'
    | 'city'
    | 'campus'
    | 'building',
  sort_order: 0,
  timezone: null,
  effective_timezone: 'Asia/Shanghai',
  room_count: 0,
})

const beijing = node('aaaa', '北京', null, 'aaaa/', 0)
const towerA = node('bbbb', 'A 座', 'aaaa', 'aaaa/bbbb/', 1)
const floor3 = node('cccc', '3F', 'bbbb', 'aaaa/bbbb/cccc/', 2)
const tree = [beijing, towerA, floor3]

describe('childrenOf', () => {
  it('按 parent 分桶,根节点归在空串键下', () => {
    const map = childrenOf(tree)
    expect(map.get('')).toEqual([beijing])
    expect(map.get('aaaa')).toEqual([towerA])
  })

  it('parent 指向已被过滤掉的节点时回退为根节点,不丢行', () => {
    const map = childrenOf([towerA, floor3])
    expect(map.get('')).toEqual([towerA])
  })
})

describe('compactRoomPathLabel', () => {
  it('五级路径只展示园区、楼栋和楼层', () => {
    expect(compactRoomPathLabel('中国 · 深圳 · 新一代产业园 · A 栋 · 3F')).toBe(
      '新一代产业园 · A 栋 · 3F'
    )
  })

  it('不足三级的旧路径保持原样', () => {
    expect(compactRoomPathLabel('A 栋 · 3F')).toBe('A 栋 · 3F')
  })
})

describe('descendantIds', () => {
  it('返回自身 + 全部后代,用于「含子层级」筛选', () => {
    expect(descendantIds(tree, 'bbbb')).toEqual(['bbbb', 'cccc'])
  })

  it('叶子节点只返回自身', () => {
    expect(descendantIds(tree, 'cccc')).toEqual(['cccc'])
  })

  it('未知 id 返回空', () => {
    expect(descendantIds(tree, 'zzzz')).toEqual([])
  })
})

describe('pathLabelOf', () => {
  it('按 path 顺序拼出「北京 · A 座 · 3F」', () => {
    expect(pathLabelOf(tree, 'cccc')).toBe('北京 · A 座 · 3F')
  })

  it('根节点只有自己一段', () => {
    expect(pathLabelOf(tree, 'aaaa')).toBe('北京')
  })
})

describe('validMoveTargets', () => {
  it('排除自身与自身子树,防止移动成环', () => {
    const ids = validMoveTargets(tree, 'bbbb').map((n) => n.id)
    expect(ids).toEqual(['aaaa'])
  })
})

describe('flattenTree', () => {
  it('按深度顺序展开,缩进随层级递增', () => {
    const rows = flattenTree(tree)
    expect(rows.map((r) => r.node.id)).toEqual(['aaaa', 'bbbb', 'cccc'])
    expect(rows[2].indent.length).toBe(4)
  })
})

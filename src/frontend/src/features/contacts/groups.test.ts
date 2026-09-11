import { describe, expect, it } from 'vitest'

import type { ImUserInfo } from '@/features/im/api/resolveImUsers'

import { resolveGroupName } from './groups'

const info = (names: Record<string, string>): Record<string, ImUserInfo> =>
  Object.fromEntries(
    Object.entries(names).map(([uid, full_name]) => [
      uid,
      { id: uid, full_name, short_name: full_name },
    ])
  )

const opts = { selfUid: 'me', separator: '、' }

describe('resolveGroupName', () => {
  it('群主设了名字就用名字(去空白)', () => {
    expect(
      resolveGroupName(
        { name: '  前端开发组 ', members: ['me', 'a'] },
        info({ a: '张三' }),
        opts
      )
    ).toEqual({ kind: 'named', name: '前端开发组' })
  })

  it('没名字时用成员名拼一个,并按总数收口', () => {
    expect(
      resolveGroupName(
        { name: '', members: ['me', 'a', 'b', 'c'] },
        info({ a: '张三', b: '李四', c: '王五' }),
        opts
      )
    ).toEqual({ kind: 'derived', names: '张三、李四', count: 3 })
  })

  it('拼名字时排除自己', () => {
    expect(
      resolveGroupName(
        { name: '   ', members: ['me', 'a'] },
        info({ me: '我自己', a: '张三' }),
        { ...opts, maxNames: 1 }
      )
    ).toEqual({ kind: 'derived', names: '张三', count: 1 })
  })

  it('群里只有自己时仍然用自己,不退化成「未命名」', () => {
    expect(
      resolveGroupName(
        { name: null, members: ['me'] },
        info({ me: '我自己' }),
        opts
      )
    ).toEqual({ kind: 'derived', names: '我自己', count: 1 })
  })

  it('成员名一个都解析不出来 → unnamed', () => {
    expect(
      resolveGroupName({ name: null, members: ['me', 'x'] }, {}, opts)
    ).toEqual({ kind: 'unnamed' })
    // 解析出来但是空串同样算「没有名字」。
    expect(
      resolveGroupName({ name: '', members: ['x'] }, info({ x: '  ' }), opts)
    ).toEqual({ kind: 'unnamed' })
  })

  it('maxNames 控制列出的人数,超出部分交给「等 N 人」', () => {
    expect(
      resolveGroupName(
        { name: '', members: ['a', 'b', 'c', 'd'] },
        info({ a: 'A', b: 'B', c: 'C', d: 'D' }),
        { ...opts, separator: ', ', maxNames: 2 }
      )
    ).toEqual({ kind: 'derived', names: 'A, B', count: 4 })
  })
})

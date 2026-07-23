import type { View } from 'react-big-calendar'
import { describe, expect, it } from 'vitest'

import { resolveRbcView } from './rbcView'

describe('resolveRbcView', () => {
  it('周视图 + 关周末 → work_week(5 列工作周)', () => {
    expect(resolveRbcView('week' as View, false)).toBe('work_week')
  })

  it('周视图 + 开周末 → week(7 列)', () => {
    expect(resolveRbcView('week' as View, true)).toBe('week')
  })

  it('其余视图透传,不受周末开关影响', () => {
    for (const v of ['day', 'month', 'agenda'] as View[]) {
      expect(resolveRbcView(v, false)).toBe(v)
      expect(resolveRbcView(v, true)).toBe(v)
    }
  })
})

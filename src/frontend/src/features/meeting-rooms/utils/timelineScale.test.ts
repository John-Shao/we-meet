import { describe, expect, it } from 'vitest'

import { addMinutes, dayWindow, makeScale } from './timelineScale'

const day = (h: number, m = 0) => new Date(2026, 6, 25, h, m, 0, 0)

describe('makeScale', () => {
  const scale = makeScale(day(0), new Date(2026, 6, 26, 0, 0, 0, 0))

  it('00:00 → 0%,12:00 → 50%,24:00 → 100%', () => {
    expect(scale.pct(day(0))).toBe(0)
    expect(scale.pct(day(12))).toBeCloseTo(50, 5)
    expect(scale.pct(new Date(2026, 6, 26))).toBe(100)
  })

  it('窗口外的时刻被 clamp 到 [0,100],不会渲染到轨道外', () => {
    expect(scale.pct(new Date(2026, 6, 24, 22))).toBe(0)
    expect(scale.pct(new Date(2026, 6, 27))).toBe(100)
  })

  it('零长度区间仍给最小宽度,不会渲染成不可见的块', () => {
    expect(scale.widthPct(day(9), day(9))).toBeGreaterThan(0)
  })

  it('minuteAt 与 pct 互为逆运算(误差 < 1 分钟)', () => {
    const target = day(14, 30)
    const minutes = scale.minuteAt(scale.pct(target) / 100)
    expect(Math.abs(minutes - 14 * 60 - 30)).toBeLessThan(1)
  })

  it('snap 把 07:12 吸附到 07:00、07:38 吸附到 07:30', () => {
    expect(scale.snap(7 * 60 + 12)).toBe(7 * 60)
    expect(scale.snap(7 * 60 + 38)).toBe(7 * 60 + 30)
  })

  it('窗口总长按实测毫秒差算,不假设一天恒为 24 小时(DST)', () => {
    // A 23-hour "day": noon must land past 50%, not exactly on it.
    const short = makeScale(day(0), new Date(2026, 6, 25, 23, 0, 0, 0))
    expect(short.pct(day(12))).toBeGreaterThan(50)
  })

  it('半点工作时间窗口仍从 0% 均匀映射到 100%', () => {
    const work = makeScale(day(9, 30), day(17, 30))
    expect(work.pct(day(9, 30))).toBe(0)
    expect(work.pct(day(13, 30))).toBe(50)
    expect(work.pct(day(17, 30))).toBe(100)
    expect(work.minuteAt(1)).toBe(8 * 60)
  })
})

describe('dayWindow', () => {
  it('返回该时刻所在本地日的 00:00 → 次日 00:00', () => {
    const { start, end } = dayWindow(day(15, 42))
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(end.getDate()).toBe(start.getDate() + 1)
  })
})

describe('addMinutes', () => {
  it('按分钟平移,不改动入参', () => {
    const base = day(9)
    expect(addMinutes(base, 90).getHours()).toBe(10)
    expect(base.getHours()).toBe(9)
  })
})

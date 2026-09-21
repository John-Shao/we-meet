import { describe, expect, it } from 'vitest'

import {
  formatClock,
  formatDateTime,
  formatDecimal,
  formatRecordTime,
} from './recordDateTime'

/**
 * 共享格式化件的两条契约：
 *   ① 语言由调用点（或 i18next 单例）决定 —— 同一个时间戳在 zh / en 下是两种写法；
 *   ② 脏值不落到界面上 —— 解析不出来一律 `null`，由调用点决定「整段不渲染」还是「退成 —」。
 *
 * 不断言 ICU 的精确字面量（不同 Node / ICU 版本之间会漂），只断言**可辨识的组成部分**
 * 与「两种语言确实不同」这两件事。
 */

const ISO = '2026-09-16T15:36:00+08:00'

describe('formatDateTime', () => {
  it('follows the requested locale instead of one fixed language', () => {
    const zh = formatDateTime(ISO, 'zh-CN')
    const en = formatDateTime(ISO, 'en-US')
    expect(zh).toBeTruthy()
    expect(en).toBeTruthy()
    expect(zh).not.toBe(en)
    // 中文写作「2026年9月16日」，英文写作「Sep 16, 2026」。
    expect(zh).toContain('2026')
    expect(zh).toContain('9')
    expect(zh).toContain('16')
    expect(en).toContain('2026')
    expect(en).toContain('16')
    expect(en).toMatch(/Sep/i)
  })

  it('returns null for anything that is not a usable timestamp', () => {
    // 空值与脏值走同一条通道：调用点据此整段不渲染，而不是把原值画出来。
    for (const value of [null, undefined, '', 'not-a-date', 'NaN']) {
      expect(formatDateTime(value, 'zh-CN')).toBeNull()
    }
  })

  it('accepts Date, epoch millis and ISO strings alike', () => {
    const fromDate = formatDateTime(new Date(ISO), 'zh-CN')
    const fromIso = formatDateTime(ISO, 'zh-CN')
    expect(fromIso).toBe(fromDate)
    expect(formatDateTime(Date.parse(ISO), 'zh-CN')).toBe(fromIso)
  })

  it('falls back to null instead of silently using another language', () => {
    // 非法 locale：`Date.prototype.toLocaleString` 会静默回落，`Intl` 会抛 —— 我们要后者的行为。
    expect(formatDateTime(ISO, 'not a locale at all')).toBeNull()
  })
})

describe('formatRecordTime', () => {
  it('omits the year inside the current year and adds it across years', () => {
    const thisYear = `${new Date().getFullYear()}-09-16T15:36:00+08:00`
    const sameYear = formatRecordTime(thisYear, 'en-US')
    expect(sameYear).toBeTruthy()
    expect(sameYear).not.toContain(String(new Date().getFullYear()))

    const oldYear = formatRecordTime('2020-09-16T15:36:00+08:00', 'en-US')
    expect(oldYear).toContain('2020')
  })

  it('returns null for a dirty value', () => {
    expect(formatRecordTime('nope', 'en-US')).toBeNull()
  })
})

describe('formatClock', () => {
  it('keeps only the time of day', () => {
    const clock = formatClock(ISO, 'en-US')
    expect(clock).toBeTruthy()
    // 15:36 UTC+8 —— 不依赖宿主时区，只断言「不含年月」。
    expect(clock).not.toContain('2026')
    expect(clock).toMatch(/\d/)
  })

  it('returns null for a dirty value', () => {
    expect(formatClock(undefined, 'en-US')).toBeNull()
  })
})

describe('formatDecimal', () => {
  it('follows the locale separator', () => {
    expect(formatDecimal(1.5, 'en-US')).toBe('1.5')
    expect(formatDecimal(1.5, 'de-DE')).toBe('1,5')
  })

  it('honours the requested precision', () => {
    expect(formatDecimal(2.345, 'en-US', { maximumFractionDigits: 2 })).toBe(
      '2.35'
    )
  })
})

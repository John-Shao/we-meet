import { describe, expect, it } from 'vitest'

import { imConversationTimeLabel, imDividerTimeLabel } from './imTimeLabels'

// 固定「现在」(2026-09-11 15:30 本地时间),分档断言才不受运行时刻影响。
const NOW = new Date(2026, 8, 11, 15, 30)

/** 本地时间戳,避免用 UTC 字面量把分档测到别的时区去。 */
const at = (
  year: number,
  month: number,
  day: number,
  hours = 10,
  minutes = 5
): number => new Date(year, month, day, hours, minutes).getTime()

const conv = (ts: number, locale = 'zh', yesterday = '昨天') =>
  imConversationTimeLabel(ts, locale, yesterday, NOW)

describe('imConversationTimeLabel', () => {
  it('今天只显示时分', () => {
    expect(conv(at(2026, 8, 11, 9, 7))).toBe('09:07')
  })

  it('昨天显示本地化文案', () => {
    expect(conv(at(2026, 8, 10, 23, 59))).toBe('昨天')
  })

  it('2~6 天前显示星期', () => {
    expect(conv(at(2026, 8, 5))).toBe('周六')
  })

  it('更早的日期用「9月11日」口径,与消息列表分隔条一致', () => {
    expect(conv(at(2026, 7, 3))).toBe('8月3日')
    expect(conv(at(2026, 8, 2))).toBe('9月2日')
  })

  it('跨年补上年份', () => {
    expect(conv(at(2025, 11, 20))).toBe('2025年12月20日')
  })

  it('按当前语言渲染日期', () => {
    expect(conv(at(2026, 7, 3), 'en', 'Yesterday')).toBe('Aug 3')
  })

  it('时钟回拨(未来时间戳)按今天处理', () => {
    expect(conv(at(2026, 8, 12, 8, 0))).toBe('08:00')
  })
})

describe('imDividerTimeLabel', () => {
  const div = (ts: number) => imDividerTimeLabel(ts, 'zh', '昨天', NOW)

  it('今天只有时分', () => {
    expect(div(at(2026, 8, 11, 9, 7))).toBe('09:07')
  })

  it('昨天带「昨天」前缀和时分', () => {
    expect(div(at(2026, 8, 10, 10, 5))).toBe('昨天 10:05')
  })

  it('2~6 天前带星期和时分(与 App 端分隔条一致)', () => {
    expect(div(at(2026, 8, 5, 10, 5))).toBe('周六 10:05')
  })

  it('一周前带具体日期和时分', () => {
    expect(div(at(2026, 7, 3, 18, 6))).toBe('8月3日 18:06')
  })

  it('与会话列表同档:非今天都是「列表文案 + 时分」', () => {
    for (const ts of [at(2026, 8, 10), at(2026, 8, 5), at(2026, 7, 3)]) {
      expect(div(ts)).toBe(`${conv(ts)} 10:05`)
    }
  })
})

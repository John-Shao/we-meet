import { describe, expect, it } from 'vitest'
import { formatDuration } from './formatDuration'

describe('formatDuration', () => {
  it.each(['zh', 'zh-CN', 'zh-cn', 'zh_CN', 'zh-Hans', 'zh-Hans-CN'])(
    'formats recording limits in simplified Chinese for %s without throwing',
    (language) => {
      expect(formatDuration(7200000, language)).toBe('2 小时')
    }
  )

  it.each(['zh-TW', 'zh_TW', 'zh-Hant', 'zh-HK'])(
    'preserves traditional Chinese for %s',
    (language) => {
      expect(formatDuration(7200000, language)).toBe('2 小時')
    }
  )

  it.each([
    ['en', '2 hours'],
    ['en-US', '2 hours'],
    ['fr-FR', '2 heures'],
    ['nl', '2 uur'],
    ['de-DE', '2 Stunden'],
  ])('formats %s', (language, expected) => {
    expect(formatDuration(7200000, language)).toBe(expected)
  })

  it.each([undefined, '', 'unsupported'])(
    'falls back to Chinese for a missing or unsupported locale (%s)',
    (language) => {
      expect(formatDuration(120000, language)).toBe('2 分钟')
    }
  )

  it('preserves recording delimiters and countdown precision', () => {
    expect(formatDuration(7260000, 'zh', { delimiter: ' ' })).toBe(
      '2 小时 1 分钟'
    )
    expect(formatDuration(90500, 'zh', { round: false, largest: 2 })).toBe(
      '1 分钟, 30.5 秒'
    )
  })
})

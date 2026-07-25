import { describe, expect, it } from 'vitest'

import {
  buildTimezoneOptions,
  formatOffset,
  timezoneLabel,
  zoneDisplayName,
  zoneOffsetMinutes,
} from './timezoneOptions'

/** Northern-hemisphere winter, so DST-observing zones sit on standard time. */
const winter = new Date('2026-01-15T00:00:00Z')
/** Northern-hemisphere summer, when Europe/Paris moves to +02:00. */
const summer = new Date('2026-07-15T00:00:00Z')

describe('zoneOffsetMinutes', () => {
  it('中国无 DST,冬夏都是 +480 分钟', () => {
    expect(zoneOffsetMinutes('Asia/Shanghai', winter)).toBe(480)
    expect(zoneOffsetMinutes('Asia/Shanghai', summer)).toBe(480)
  })

  it('按 DST 实际生效值算,不是固定标准时偏移', () => {
    expect(zoneOffsetMinutes('Europe/Paris', winter)).toBe(60)
    expect(zoneOffsetMinutes('Europe/Paris', summer)).toBe(120)
  })

  it('负偏移与半小时偏移都能解析', () => {
    expect(zoneOffsetMinutes('America/New_York', winter)).toBe(-300)
    expect(zoneOffsetMinutes('Asia/Kolkata', winter)).toBe(330)
  })

  it('UTC 是 0(Intl 只回 "GMT",没有 ±HH:MM 部分)', () => {
    expect(zoneOffsetMinutes('UTC', winter)).toBe(0)
  })
})

describe('formatOffset', () => {
  it('补零到 ±HH:MM', () => {
    expect(formatOffset(480)).toBe('GMT+08:00')
    expect(formatOffset(-300)).toBe('GMT-05:00')
    expect(formatOffset(330)).toBe('GMT+05:30')
    expect(formatOffset(0)).toBe('GMT+00:00')
  })
})

describe('zoneDisplayName', () => {
  it('中文环境给出本地化时区名,不是 IANA id', () => {
    const name = zoneDisplayName('Asia/Shanghai', 'zh', winter)
    expect(name).not.toBe('Asia/Shanghai')
    expect(name).not.toMatch(/^GMT/)
    expect(name.length).toBeGreaterThan(0)
  })

  it('英文环境与中文环境给出不同的名字', () => {
    expect(zoneDisplayName('Asia/Shanghai', 'en', winter)).not.toBe(
      zoneDisplayName('Asia/Shanghai', 'zh', winter)
    )
  })
})

describe('timezoneLabel', () => {
  it('形如「(GMT+08:00) 中国标准时间 · Asia/Shanghai」', () => {
    const label = timezoneLabel('Asia/Shanghai', 'zh', winter)
    expect(label).toMatch(/^\(GMT\+08:00\) /)
    // id 保留在末尾:同名时区一大把,id 才是唯一能区分的东西。
    expect(label.endsWith('· Asia/Shanghai')).toBe(true)
  })

  it('引擎给不出本地化名字时不重复渲染 id', () => {
    // 用一个几乎不可能有本地化名字的 locale,退化成「(偏移) id」两段。
    const label = timezoneLabel('Asia/Shanghai', 'zz-ZZ', winter)
    expect(label.split('Asia/Shanghai')).toHaveLength(2)
  })
})

describe('buildTimezoneOptions', () => {
  it('按偏移由西向东排序', () => {
    const options = buildTimezoneOptions('zh', winter)
    const offsets = options.map((o) => o.offsetMinutes)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })

  it('包含常用时区且每项都带标签', () => {
    const options = buildTimezoneOptions('zh', winter)
    const shanghai = options.find((o) => o.zone === 'Asia/Shanghai')
    expect(shanghai).toBeDefined()
    expect(shanghai!.label).toContain('Asia/Shanghai')
    expect(options.every((o) => o.label.length > 0)).toBe(true)
  })

  it('同一 locale 复用缓存,不重复构造 ~400 个 Intl 格式化器', () => {
    expect(buildTimezoneOptions('en', winter)).toBe(
      buildTimezoneOptions('en', winter)
    )
  })
})

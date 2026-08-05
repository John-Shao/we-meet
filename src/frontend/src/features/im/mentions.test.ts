import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MENTION_EVERYONE_ALIASES,
  mentionScan,
  mentionsEveryone,
} from './mentions'

/**
 * `@所有人` 别名表的三方契约:**常量 == 后端 fixture == 各 locale 资源**。
 *
 * 三者任意一处漂了这里就红。最要紧的是第三条:有人加一个语种、或者把
 * 「所有人」改个说法,如果没同步别名表,那个语种的用户被 @所有人 时**不会亮**
 * —— 静默失败,没有报错、没有日志,不会有人报障。
 *
 * 与色板下标、rich-text golden fixture 是同一手法。
 */
const FIXTURE = path.resolve(
  __dirname,
  '../../../../backend/core/tests/fixtures/im_cards/mention_everyone_aliases.json',
)

const LOCALES = ['zh', 'en', 'fr', 'de', 'nl'] as const

const localeEveryone = (locale: string): string => {
  const file = path.resolve(__dirname, `../../locales/${locale}/im.json`)
  const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    mention?: { everyone?: string }
  }
  return json.mention?.everyone ?? ''
}

describe('@所有人 别名表(三方契约)', () => {
  it('后端 fixture 可达', () => {
    // 路径悄悄断掉会让下面每一条断言都变成空转。
    expect(fs.existsSync(FIXTURE)).toBe(true)
  })

  it('常量与后端 fixture 逐项相等', () => {
    const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as {
      aliases: string[]
      by_locale: Record<string, string>
    }
    expect([...MENTION_EVERYONE_ALIASES].sort()).toEqual(
      [...data.aliases].sort(),
    )
    // fixture 内部自洽:aliases 就是 by_locale 的扁平投影。
    expect([...data.aliases].sort()).toEqual(
      Object.values(data.by_locale).sort(),
    )
  })

  it('每个 locale 的 mention.everyone 都在别名表里,且没有多余项', () => {
    const fromLocales = LOCALES.map(localeEveryone)
    expect(fromLocales.every(Boolean)).toBe(true)
    for (const label of fromLocales) {
      expect(MENTION_EVERYONE_ALIASES).toContain(label)
    }
    // 反向:别名表里不该有任何 locale 都不用的僵尸项。
    expect([...MENTION_EVERYONE_ALIASES].sort()).toEqual(
      [...new Set(fromLocales)].sort(),
    )
  })
})

describe('mentionsEveryone', () => {
  it('认出每一个语种的写法', () => {
    for (const alias of MENTION_EVERYONE_ALIASES) {
      expect(mentionsEveryone(`早上好 @${alias} 记得填周报`)).toBe(true)
    }
  })

  it('大小写无关', () => {
    expect(mentionsEveryone('@everyone ping')).toBe(true)
    expect(mentionsEveryone('@ALLE Achtung')).toBe(true)
  })

  it('没有 @ 前缀就不算', () => {
    expect(mentionsEveryone('Everyone is here')).toBe(false)
    expect(mentionsEveryone('所有人都到了')).toBe(false)
  })
})

describe('mentionScan', () => {
  const ME = ['小王', '王小明']

  it('text:点名到我 / 点所有人', () => {
    expect(mentionScan('text', '@小王 看一下', ME)).toEqual({
      self: true,
      everyone: false,
    })
    expect(mentionScan('text', '@Alle bitte lesen', ME)).toEqual({
      self: false,
      everyone: true,
    })
  })

  it('rich-text:@所有人 走结构,不靠正文里恰好有哪个语种的字面量', () => {
    const body = JSON.stringify({
      v: 1,
      title: '构建失败',
      content: [[{ tag: 'at', uid: 'all', name: '所有人' }]],
      // plain 里刻意不放任何别名 —— 全靠 at 标签认出来。
      plain: '构建失败 请处理',
    })
    expect(mentionScan('rich-text', body, ME).everyone).toBe(true)
  })

  it('rich-text:机器人直接在正文里打字面量也认', () => {
    const body = JSON.stringify({
      v: 1,
      title: '',
      content: [[{ tag: 'text', text: '@Iedereen let op' }]],
      plain: '@Iedereen let op',
    })
    expect(mentionScan('rich-text', body, ME).everyone).toBe(true)
  })

  it('rich-text:点名到人只看 plain,不看 at.uid', () => {
    // at.uid 是 webhook 发送方随手填的外部字符串,不是我们的 im uid ——
    // 拿它跟自己比等于让外部「猜中 uid 就能定向戳人」。
    const body = JSON.stringify({
      v: 1,
      title: '',
      content: [[{ tag: 'at', uid: '小王', name: '某人' }]],
      plain: '某人',
    })
    expect(mentionScan('rich-text', body, ME).self).toBe(false)
  })

  it('quote:只扫回复正文,不扫被引用的快照', () => {
    const body = JSON.stringify({
      reply_to: { sender: '张三', snippet: '@所有人 明天开会' },
      text: '收到',
    })
    // 引用一条 @所有人 会让所有人**再被通知一次** —— 那是 bug 不是设计。
    expect(mentionScan('quote', body, ME).everyone).toBe(false)
    expect(mentionScan('quote', JSON.stringify({ text: '@小王 你看' }), ME).self)
      .toBe(true)
  })

  it('其余 content_type 一律不扫', () => {
    // 以前是拿原始 body 无差别扫的,于是一个叫「@所有人 周会」的会议卡片
    // 也会点亮红 @。
    const card = JSON.stringify({ title: '@所有人 周会', status: 'ongoing' })
    for (const ct of ['meeting-card', 'doc-card', 'event-card', 'image', 'file', 'merged', 'system']) {
      expect(mentionScan(ct, card, ME)).toEqual({ self: false, everyone: false })
    }
  })

  it('坏 JSON 不抛,按「没点名」处理', () => {
    expect(mentionScan('rich-text', '{ not json', ME)).toEqual({
      self: false,
      everyone: false,
    })
    expect(mentionScan('quote', 'nope', ME)).toEqual({
      self: false,
      everyone: false,
    })
  })
})

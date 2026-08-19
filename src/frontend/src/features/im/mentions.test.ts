import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MENTION_EVERYONE_ALIASES,
  defuseMentions,
  mentionScan,
  mentionsEveryone,
} from './mentions'
import { parseRichCard, richCardPlain } from './components/richCard'

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
  '../../../../backend/core/tests/fixtures/im_cards/mention_everyone_aliases.json'
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
      [...data.aliases].sort()
    )
    // fixture 内部自洽:aliases 就是 by_locale 的扁平投影。
    expect([...data.aliases].sort()).toEqual(
      Object.values(data.by_locale).sort()
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
      [...new Set(fromLocales)].sort()
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
    expect(
      mentionScan('quote', JSON.stringify({ text: '@小王 你看' }), ME).self
    ).toBe(true)
  })

  it('其余 content_type 一律不扫', () => {
    // 以前是拿原始 body 无差别扫的,于是一个叫「@所有人 周会」的会议卡片
    // 也会点亮红 @。
    const card = JSON.stringify({ title: '@所有人 周会', status: 'ongoing' })
    for (const ct of [
      'meeting-card',
      'doc-card',
      'event-card',
      'image',
      'file',
      'merged',
      'system',
    ]) {
      expect(mentionScan(ct, card, ME)).toEqual({
        self: false,
        everyone: false,
      })
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

describe('defuseMentions(转发时拆 @)', () => {
  const ME = ['小王', '王小明']
  const NONE = { self: false, everyone: false }

  /** 这块唯一真正要成立的事:转发副本扫不出任何 @。 */
  const scanForward = (ct: string, body: string) =>
    mentionScan(ct, defuseMentions(ct, body), ME)

  const cardWith = (spans: unknown[], plain?: string) =>
    JSON.stringify({
      v: 1,
      header: { title: '生产构建失败', theme: 'danger' },
      blocks: [{ type: 'text', spans }],
      ...(plain === undefined ? {} : { plain }),
    })

  it('金标准卡片:结构那条腿断了', () => {
    const raw = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../backend/core/tests/fixtures/im_cards/rich_card_full.json'
      ),
      'utf-8'
    )
    // 原件是会点亮的 —— 否则下面那条断言是空转。
    expect(mentionScan('rich-card', raw, ME).everyone).toBe(true)
    expect(scanForward('rich-card', raw)).toEqual(NONE)
  })

  it('正文里那句「@所有人」一个字都没少,只是不再是 at 标签', () => {
    // 读者该看到机器人当时说了什么。降级成普通文字后渲染从蓝色粗体变灰字,
    // 那正是「这个 @ 不生效」的视觉信号 —— 与飞书同一口径。
    const body = parseRichCard(
      defuseMentions(
        'rich-card',
        cardWith([
          { tag: 'text', text: '请 ' },
          { tag: 'at', uid: 'all', name: '所有人' },
          { tag: 'text', text: ' 确认' },
        ])
      )
    )!
    const [block] = body.blocks
    if (block.type !== 'text') throw new Error('expected a text block')
    expect(block.spans).toEqual([
      { tag: 'text', text: '请 ' },
      { tag: 'text', text: '@所有人' },
      { tag: 'text', text: ' 确认' },
    ])
    expect(block.spans.some((s) => s.tag === 'at')).toBe(false)
  })

  it('plain 那条腿也断:字面量的 `@` 被摘掉,字还在', () => {
    // 机器人完全可以不发 at 标签、直接在正文里打「@所有人」。只断结构那条腿
    // 等于没断。
    const raw = cardWith(
      [{ tag: 'text', text: '@Iedereen let op' }],
      // 字面量那条腿只看服务端给的 plain(从不自己推),真实卡片一定带它。
      '生产构建失败 @Iedereen let op'
    )
    expect(mentionScan('rich-card', raw, ME).everyone).toBe(true)
    expect(scanForward('rich-card', raw)).toEqual(NONE)
    expect(defuseMentions('rich-card', raw)).toContain('Iedereen let op')
  })

  it('点名到人:at 标签的名字从 plain 里摘掉,不误伤正文里别的 @', () => {
    const raw = cardWith(
      [{ tag: 'at', uid: 'ou_x', name: '小王' }],
      '@小王 顺便看下 x@example.com'
    )
    expect(mentionScan('rich-card', raw, ME).self).toBe(true)
    expect(scanForward('rich-card', raw)).toEqual(NONE)
    // 邮箱里那个 @ 与点名无关,不该被动。
    expect(defuseMentions('rich-card', raw)).toContain('x@example.com')
  })

  it('原件没有 plain 时,转发副本必须自己带上一份拆过的', () => {
    // 不写回去的话,对端会照降级后的正文重推一遍 plain,`@所有人` 原样长回来。
    const raw = cardWith([{ tag: 'at', uid: 'all', name: '所有人' }])
    const defused = parseRichCard(defuseMentions('rich-card', raw))!
    expect(defused.plain).toBeTruthy()
    expect(defused.plain).not.toContain('@')
    // 而且它确实与「照正文重推」不同 —— 那样会推出 `@所有人`。
    expect(richCardPlain(defused)).toContain('@所有人')
    expect(scanForward('rich-card', raw)).toEqual(NONE)
  })

  it('rich-text 同一套', () => {
    const raw = JSON.stringify({
      v: 1,
      title: '构建失败',
      content: [[{ tag: 'at', uid: 'all', name: '所有人' }]],
      plain: '构建失败 @所有人',
    })
    expect(mentionScan('rich-text', raw, ME).everyone).toBe(true)
    expect(scanForward('rich-text', raw)).toEqual(NONE)
  })

  it('没有 @ 的原样返回,不做无谓的重新序列化', () => {
    const raw = cardWith([{ tag: 'text', text: '构建通过' }], '构建通过')
    expect(defuseMentions('rich-card', raw)).toBe(raw)
  })

  it('坏数据原样返回,不吞消息', () => {
    expect(defuseMentions('rich-card', '{ not json')).toBe('{ not json')
    expect(defuseMentions('rich-text', '{ not json')).toBe('{ not json')
  })

  it('纯 text 刻意不碰 —— 那是人写的一句话,不是我们能改的投影', () => {
    // 已知边界:转发一条纯文本的 @所有人 仍然会亮。body 就是正文,改它等于
    // 替人改口;而纯文本里的人名与普通文字也无从区分。
    const raw = '@所有人 明天九点'
    expect(defuseMentions('text', raw)).toBe(raw)
    expect(mentionScan('text', defuseMentions('text', raw), ME).everyone).toBe(
      true
    )
  })
})

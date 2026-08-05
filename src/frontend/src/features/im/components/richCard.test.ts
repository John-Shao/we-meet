import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseRichCard,
  richCardPlain,
  richCardPreview,
  stripActions,
} from './richCard'

/**
 * `rich-card` —— 解析、投影、转发剥离,以及对后端三张金标准的契约断言。
 *
 * 金标准与 `imCardContract.test.ts` 读的是同一个目录(后端仓),所以协议一动
 * 三端一起红。这里额外验的是**解析层的降级**:坏数据不能把气泡变空,
 * `javascript:` href 不能变成可点的链接。
 */
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../../backend/core/tests/fixtures/im_cards',
)

const load = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf-8')

describe('rich-card 金标准', () => {
  it('fixture 目录可达', () => {
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true)
  })

  it('full:header + 三种 span + fields + divider + 三种按钮', () => {
    const card = parseRichCard(load('rich_card_full'))!
    expect(card).not.toBeNull()
    expect(card.header).toEqual({ title: '生产构建失败', theme: 'danger' })
    expect(card.blocks.map((b) => b.type)).toEqual([
      'text',
      'fields',
      'divider',
      'actions',
    ])

    const [text] = card.blocks
    if (text.type !== 'text') throw new Error('expected a text block')
    expect(text.spans).toContainEqual({ tag: 'text', text: 'main', b: true })
    expect(text.spans).toContainEqual({ tag: 'text', text: '02:14', i: true })
    expect(text.spans).toContainEqual({ tag: 'at', uid: 'all', name: '所有人' })
    expect(text.spans.some((s) => s.tag === 'a')).toBe(true)
  })

  it('full:三项 fields —— 奇数,客户端最后一项跨列', () => {
    const card = parseRichCard(load('rich_card_full'))!
    const fields = card.blocks.find((b) => b.type === 'fields')
    if (fields?.type !== 'fields') throw new Error('expected a fields block')
    expect(fields.items).toHaveLength(3)
    expect(fields.items[0]).toEqual({ label: '环境', value: '生产' })
  })

  it('按钮身上没有 value —— 那是服务端的私有载荷', () => {
    // 与后端 test_no_button_ever_carries_its_value 是同一条不变量的两端。
    const card = parseRichCard(load('rich_card_full'))!
    const actions = card.blocks.find((b) => b.type === 'actions')
    if (actions?.type !== 'actions') throw new Error('expected an actions block')
    for (const button of actions.buttons) {
      expect(button).not.toHaveProperty('value')
    }
    expect(load('rich_card_full')).not.toContain('"value": {')
  })

  it('minimal:没有 header 也能解析', () => {
    const card = parseRichCard(load('rich_card_minimal'))!
    expect(card.header).toBeUndefined()
    expect(card.blocks).toHaveLength(1)
  })

  it('degraded:剩余块顺序不乱,body 里没有 warnings', () => {
    const raw = load('rich_card_degraded')
    const card = parseRichCard(raw)!
    expect(card.blocks.map((b) => b.type)).toEqual(['text', 'divider', 'text'])
    expect(raw).not.toContain('warning')
  })
})

describe('parseRichCard 的降级', () => {
  it('坏 JSON / 缺 blocks 一律 null,由调用方退回纯文本', () => {
    expect(parseRichCard('{ not json')).toBeNull()
    expect(parseRichCard('"a string"')).toBeNull()
    expect(parseRichCard(JSON.stringify({ v: 1 }))).toBeNull()
  })

  it('javascript: href 留住字、去掉链接', () => {
    const raw = JSON.stringify({
      v: 1,
      blocks: [
        {
          type: 'text',
          spans: [{ tag: 'a', text: '点我', href: 'javascript:alert(1)' }],
        },
      ],
    })
    const card = parseRichCard(raw)!
    const [block] = card.blocks
    if (block.type !== 'text') throw new Error('expected a text block')
    expect(block.spans).toEqual([{ tag: 'text', text: '点我' }])
  })

  it('未知块类型丢弃,不是崩 —— 协议加块时老客户端只是少显示一块', () => {
    const raw = JSON.stringify({
      v: 1,
      blocks: [
        { type: 'chart', data: [1, 2, 3] },
        { type: 'divider' },
      ],
    })
    expect(parseRichCard(raw)!.blocks).toEqual([{ type: 'divider' }])
  })

  it('认不出的 action 类型不渲染成按钮', () => {
    const raw = JSON.stringify({
      v: 1,
      blocks: [
        {
          type: 'actions',
          resolve: 'once',
          buttons: [{ id: 'b0', text: 'x', style: 'default', action: 'teleport' }],
        },
      ],
    })
    // 整块因此空掉 → 块被丢弃 → 没有块也没有 header → null。
    expect(parseRichCard(raw)).toBeNull()
  })

  it('url 按钮的 href 不是 http(s) 就不渲染', () => {
    const raw = JSON.stringify({
      v: 1,
      blocks: [
        {
          type: 'actions',
          resolve: 'once',
          buttons: [
            { id: 'b0', text: 'x', style: 'default', action: 'url', url: 'javascript:x' },
          ],
        },
      ],
    })
    expect(parseRichCard(raw)).toBeNull()
  })

  it('未知 theme 兜底 neutral', () => {
    const raw = JSON.stringify({
      v: 1,
      header: { title: 't', theme: 'chartreuse' },
      blocks: [{ type: 'divider' }],
    })
    expect(parseRichCard(raw)!.header!.theme).toBe('neutral')
  })
})

describe('投影', () => {
  it('plain 不含按钮标签 —— 按钮是控件不是话', () => {
    const card = parseRichCard(load('rich_card_full'))!
    const plain = richCardPlain(card)
    expect(plain).toContain('生产构建失败')
    expect(plain).toContain('环境 生产')
    expect(plain).not.toContain('同意上线')
  })

  it('预览优先用服务端的 plain', () => {
    // 会话列表的 last_message 会被 jusi 截到 200 字:截断的 JSON 解析不出来,
    // 但截断的 plain 仍然是人话。这也是「短路必须在 parse 之前」那条坑。
    const raw = JSON.stringify({
      v: 1,
      blocks: [{ type: 'text', spans: [{ tag: 'text', text: '正文' }] }],
      plain: '服务端给的摘要',
    })
    expect(richCardPreview(raw)).toBe('服务端给的摘要')
  })

  it('解析不出来时预览是空串,由调用方兜底文案', () => {
    expect(richCardPreview('{ truncated')).toBe('')
  })
})

describe('stripActions', () => {
  it('转发副本剥掉按钮,其余原样', () => {
    // 服务端对转发副本返回 404 是真正的兜底,这里是不让用户看到一排点不动
    // 的按钮。
    const stripped = parseRichCard(stripActions(load('rich_card_full')))!
    expect(stripped.blocks.map((b) => b.type)).toEqual([
      'text',
      'fields',
      'divider',
    ])
    expect(stripped.header).toEqual({ title: '生产构建失败', theme: 'danger' })
    expect(stripped.plain).toBeTruthy()
  })

  it('没有 actions 时原样返回,不做无谓的重新序列化', () => {
    const raw = load('rich_card_minimal')
    expect(stripActions(raw)).toBe(raw)
  })

  it('坏数据原样返回,不吞消息', () => {
    expect(stripActions('{ not json')).toBe('{ not json')
  })
})

import { describe, expect, it } from 'vitest'

import {
  isWebUrl,
  parseRichText,
  richTextPlain,
  richTextPreview,
} from './richText'

describe('parseRichText', () => {
  const body = (content: unknown, extra: object = {}) =>
    JSON.stringify({ v: 1, title: '', content, ...extra })

  it('keeps text, links and mentions', () => {
    const parsed = parseRichText(
      body([
        [
          { tag: 'text', text: 'hello ' },
          { tag: 'a', text: 'log', href: 'https://ci.example.com' },
          { tag: 'at', uid: 'all', name: '所有人' },
        ],
      ])
    )
    expect(parsed?.content[0]).toHaveLength(3)
  })

  it('degrades a javascript: link to plain text but keeps the words', () => {
    // The webhook body is externally controlled — this is the one assertion in
    // this module that is actually load-bearing for security.
    const parsed = parseRichText(
      body([[{ tag: 'a', text: '点我', href: 'javascript:alert(1)' }]])
    )
    expect(parsed?.content[0][0]).toEqual({ tag: 'text', text: '点我' })
  })

  it.each(['data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd'])(
    'refuses %s as a link target',
    (href) => {
      expect(isWebUrl(href)).toBe(false)
    }
  )

  it('accepts http and https', () => {
    expect(isWebUrl('http://x.test')).toBe(true)
    expect(isWebUrl('https://x.test/a?b=1')).toBe(true)
  })

  it('drops unknown tags and the paragraphs that become empty', () => {
    const parsed = parseRichText(
      body([
        [{ tag: 'emotion', emoji_type: 'SMILE' }],
        [{ tag: 'text', text: 'kept' }],
      ])
    )
    expect(parsed?.content).toEqual([[{ tag: 'text', text: 'kept' }]])
  })

  it('returns null for non-JSON', () => {
    expect(parseRichText('not json')).toBeNull()
  })

  it('returns null when nothing renderable survives', () => {
    expect(parseRichText(body([[{ tag: 'emotion' }]]))).toBeNull()
  })

  it('keeps a title-only body', () => {
    expect(
      parseRichText(JSON.stringify({ v: 1, title: '只有标题', content: [] }))
        ?.title
    ).toBe('只有标题')
  })
})

describe('richTextPlain / richTextPreview', () => {
  const full = JSON.stringify({
    v: 1,
    title: '构建失败',
    content: [
      [
        { tag: 'text', text: '分支 main ' },
        { tag: 'a', text: '查看日志', href: 'https://ci.example.com' },
      ],
      [{ tag: 'at', uid: 'all', name: '所有人' }],
    ],
  })

  it('flattens title, links and mentions', () => {
    expect(richTextPlain(parseRichText(full)!)).toBe(
      '构建失败 分支 main 查看日志 @所有人'
    )
  })

  it('prefers the server plain projection when present', () => {
    // jusi truncates last_message at 200 chars: truncated JSON will not parse,
    // but a truncated plain string is still readable.
    const withPlain = JSON.stringify({
      v: 1,
      title: 't',
      content: [[{ tag: 'text', text: 'ignored' }]],
      plain: 'server said this',
    })
    expect(richTextPreview(withPlain)).toBe('server said this')
  })

  it('collapses whitespace and caps the preview length', () => {
    const long = JSON.stringify({
      v: 1,
      title: '',
      content: [[{ tag: 'text', text: 'x'.repeat(200) }]],
    })
    expect(richTextPreview(long)).toHaveLength(60)
  })

  it('returns an empty string for a body it cannot read', () => {
    expect(richTextPreview('{{{')).toBe('')
  })
})

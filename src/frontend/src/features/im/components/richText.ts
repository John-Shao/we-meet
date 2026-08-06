/**
 * 富文本消息协议 v1 (`content_type: 'rich-text'`) — 与后端 / Android 一致。
 *
 * 只有群机器人产生这种消息(后端把飞书的 `msg_type=post` 规范化成这个形状),
 * 所以这里**不导出 builder**:Web 端没有发送路径,一个没人调用的构造函数只会
 * 和真正的协议慢慢漂移。金标准 fixture 见后端仓
 * `core/tests/fixtures/im_cards/rich_text_*.json`,三端共读同一批文件。
 *
 * 刻意是单语言的:飞书的 post 带 `{zh_cn, en_us}` 外壳,但同一条 IM 消息不该
 * 按接收方的 locale 变形,后端在 webhook 入口就拍平了。
 */

export type RichTextTag =
  | { tag: 'text'; text: string }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; uid: string; name: string }

export interface RichTextBody {
  v: number
  title: string
  content: RichTextTag[][]
  /** 派生投影,只给预览/搜索/@我检测用 —— **不要渲染它**。 */
  plain?: string
}

/**
 * 只放行 http(s)。webhook 正文是外部可控的,一条 `javascript:` href 就是一个
 * XSS —— 这是本模块最需要被 review 的一行。非法 scheme 不丢内容,由调用方
 * 降级成纯文本(留住字、去掉链接)。
 */
export const isWebUrl = (href: unknown): href is string => {
  if (typeof href !== 'string') return false
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 从**原始字符串**里抠出 `plain`,不经过 `JSON.parse`。
 *
 * 会话列表的 `last_message` 被 jusi 截断过,截断的 JSON 解析不出来 —— 但截断的
 * plain 仍然是人话。所以预览的短路必须在 parse **之前**;后端把 `plain` 序列化
 * 成第一个键也是为了这个(排在最后的话它整段落在截断点之外,抠也抠不到)。
 *
 * 不这么做的后果是真机上验到的:会话列表里每一张卡都显示「[卡片]」。
 *
 * 手写扫描而不是正则:既要正确处理转义,又要能在字符串**中途被截断**时把已经
 * 读到的部分交出来。正则做不到后者 —— 它要么匹配一个完整的字符串字面量,
 * 截断了就整个不匹配。
 */
export const rawPlain = (raw: string): string => {
  const at = raw.indexOf('"plain"')
  if (at < 0) return ''
  const colon = raw.indexOf(':', at + '"plain"'.length)
  if (colon < 0) return ''
  const open = raw.indexOf('"', colon + 1)
  if (open < 0) return ''

  let out = ''
  for (let i = open + 1; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      if (ch === '"') break
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break // 截断刚好落在转义符上
    if (next === 'u') {
      // 后端用 ensure_ascii=False,所以中文不会走这里;控制字符才会。
      const code = parseInt(raw.slice(i + 2, i + 6), 16)
      out += Number.isNaN(code) ? ' ' : String.fromCharCode(code)
      i += 5
      continue
    }
    // 换行/制表在一行预览里读作空格,其余(`\"` `\\` `\/`)取字符本身。
    out += 'ntr'.includes(next) ? ' ' : next
    i += 1
  }
  return out
}

/** 预览统一收口:压掉空白、截到一行放得下的长度。 */
export const squeezePreview = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, 60)

const normalizeTag = (raw: unknown): RichTextTag | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.tag === 'text') {
    return typeof o.text === 'string' && o.text ? { tag: 'text', text: o.text } : null
  }
  if (o.tag === 'a') {
    if (typeof o.text !== 'string' || !o.text) return null
    if (isWebUrl(o.href)) return { tag: 'a', text: o.text, href: o.href }
    // Keep the words, drop the link.
    return { tag: 'text', text: o.text }
  }
  if (o.tag === 'at') {
    const uid = typeof o.uid === 'string' ? o.uid : ''
    const name = typeof o.name === 'string' ? o.name : ''
    if (!uid && !name) return null
    return { tag: 'at', uid, name: name || uid }
  }
  // Unknown tags are dropped rather than rendered as JSON.
  return null
}

/** 宽容解析:任何说不通的地方都返回 null,调用方退回纯文本气泡。 */
export const parseRichText = (raw: string): RichTextBody | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.content)) return null

  const content: RichTextTag[][] = []
  for (const paragraph of o.content) {
    if (!Array.isArray(paragraph)) continue
    const tags = paragraph
      .map(normalizeTag)
      .filter((tag): tag is RichTextTag => tag !== null)
    if (tags.length) content.push(tags)
  }

  const title = typeof o.title === 'string' ? o.title : ''
  if (!content.length && !title) return null
  return {
    v: typeof o.v === 'number' ? o.v : 1,
    title,
    content,
    plain: typeof o.plain === 'string' ? o.plain : undefined,
  }
}

/** 摊平成纯文本 —— 预览、引用、转发快照、复制都用它。 */
export const richTextPlain = (body: RichTextBody): string => {
  const lines: string[] = []
  if (body.title) lines.push(body.title)
  for (const paragraph of body.content) {
    const line = paragraph
      .map((tag) =>
        tag.tag === 'at' ? `@${tag.name}` : tag.text
      )
      .join('')
      .trim()
    if (line) lines.push(line)
  }
  return lines.join(' ').trim()
}

/**
 * 直接吃原始 body 的预览版本(什么都拿不到时返回空串,调用方
 * `|| t('preview.richText')`)。
 *
 * **短路在 parse 之前** —— 见 [rawPlain]。会话列表的 last_message 是截断的,
 * 解析不出来但抠得到 plain。
 */
export const richTextPreview = (raw: string): string => {
  const short = rawPlain(raw)
  if (short) return squeezePreview(short)
  const body = parseRichText(raw)
  return body ? squeezePreview(body.plain || richTextPlain(body)) : ''
}

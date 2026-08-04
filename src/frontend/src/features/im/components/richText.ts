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
 * 直接吃原始 body 的预览版本(解析失败返回空串,调用方 `|| t('preview.richText')`)。
 * 优先用服务端给的 `plain`:会话列表的 last_message 会被 jusi 截到 200 字,
 * 截断的 JSON 解析不出来,但截断的 plain 仍然是人话。
 */
export const richTextPreview = (raw: string): string => {
  const body = parseRichText(raw)
  const text = body ? body.plain || richTextPlain(body) : ''
  return text.replace(/\s+/g, ' ').slice(0, 60)
}

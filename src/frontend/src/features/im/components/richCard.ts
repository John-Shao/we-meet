import { isWebUrl, rawPlain, squeezePreview } from './richText'

/**
 * `rich-card` 协议 v1(`content_type: 'rich-card'`)—— 与后端 / Android 一致。
 *
 * 群机器人经 webhook 发来的**块级卡片**(后端把飞书 `msg_type=interactive`
 * 规范化成这个形状)。Web 端只渲染、不构造。金标准 fixture 见后端仓
 * `core/tests/fixtures/im_cards/rich_card_*.json`,三端共读同一批文件。
 *
 * ## 与 rich-text 的关系
 *
 * **内联 span 是同一套词汇**(`text` / `a` / `at`),只多两个可选布尔 `b`/`i`。
 * 所以现有 9 个 rich-text fixture 一个字节都不用改,rich-card 只新增块级布局。
 *
 * ## 两条不能忘的事
 *
 * 1. **按钮永远没有 `value`。** 那是外部服务的私有载荷(可能是 pipeline
 *    token),只存服务端。客户端只拿 `id`,点击时把 id 发回去。任何时候在
 *    body 里看到 value 都是后端漏了。
 * 2. **转发时要本地剥掉 actions 块。** 服务端对转发副本返回 404 是真正的
 *    兜底,但不能让用户看到一排点不动的按钮。见 [stripActions]。
 */

export type CardSpan =
  | { tag: 'text'; text: string; b?: boolean; i?: boolean }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; uid: string; name: string }

/** header 主题 —— 语义档,不是颜色。三端各自映射到自己主题的 token。 */
export type CardTheme = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

const THEMES: readonly CardTheme[] = [
  'info',
  'success',
  'warning',
  'danger',
  'neutral',
]

export type CardButtonAction = 'url' | 'callback' | 'doc'

export interface CardButton {
  id: string
  text: string
  style: 'default' | 'primary' | 'danger'
  action: CardButtonAction
  /** 只有 `action: 'url'` 才有。 */
  url?: string
  /** 只有 `action: 'doc'` 才有；点击复用 doc-card 的内部查看器。 */
  doc_id?: string
}

export type CardBlock =
  | { type: 'text'; spans: CardSpan[] }
  | { type: 'fields'; items: Array<{ label: string; value: string }> }
  | { type: 'divider' }
  | { type: 'actions'; resolve: 'once' | 'each'; buttons: CardButton[] }

export interface RichCardBody {
  v: number
  header?: { title: string; theme: CardTheme }
  blocks: CardBlock[]
  /** 派生投影,只给预览/搜索/@我 检测用 —— **不要渲染它**。 */
  plain?: string
}

// ---- 解析 -------------------------------------------------------------------

const normalizeSpan = (raw: unknown): CardSpan | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.tag === 'text') {
    if (typeof o.text !== 'string' || !o.text) return null
    const span: CardSpan = { tag: 'text', text: o.text }
    if (o.b === true) span.b = true
    if (o.i === true) span.i = true
    return span
  }
  if (o.tag === 'a') {
    if (typeof o.text !== 'string' || !o.text) return null
    // 与 rich-text 同一条红线:非 http(s) 的 href 是攻击面不是链接,留住字。
    if (isWebUrl(o.href)) return { tag: 'a', text: o.text, href: o.href }
    return { tag: 'text', text: o.text }
  }
  if (o.tag === 'at') {
    const uid = typeof o.uid === 'string' ? o.uid : ''
    const name = typeof o.name === 'string' ? o.name : ''
    if (!uid && !name) return null
    return { tag: 'at', uid, name: name || uid }
  }
  return null
}

const normalizeButton = (raw: unknown): CardButton | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  if (typeof o.text !== 'string' || !o.text) return null
  const style =
    o.style === 'primary' || o.style === 'danger' ? o.style : 'default'
  if (o.action === 'url') {
    return isWebUrl(o.url)
      ? { id: o.id, text: o.text, style, action: 'url', url: o.url }
      : null
  }
  if (o.action === 'callback') {
    return { id: o.id, text: o.text, style, action: 'callback' }
  }
  if (o.action === 'doc') {
    return typeof o.doc_id === 'string' && o.doc_id && isWebUrl(o.url)
      ? {
          id: o.id,
          text: o.text,
          style,
          action: 'doc',
          doc_id: o.doc_id,
          url: o.url,
        }
      : null
  }
  // 认不出的动作类型不渲染 —— 一个点了没反应的按钮比没有按钮更糟。
  return null
}

const normalizeBlock = (raw: unknown): CardBlock | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  if (o.type === 'divider') return { type: 'divider' }

  if (o.type === 'text') {
    const spans = Array.isArray(o.spans)
      ? o.spans.map(normalizeSpan).filter((s): s is CardSpan => s !== null)
      : []
    return spans.length ? { type: 'text', spans } : null
  }

  if (o.type === 'fields') {
    const items = Array.isArray(o.items)
      ? o.items
          .map((item) => {
            if (!item || typeof item !== 'object') return null
            const f = item as Record<string, unknown>
            const value = typeof f.value === 'string' ? f.value : ''
            if (!value) return null
            return {
              label: typeof f.label === 'string' ? f.label : '',
              value,
            }
          })
          .filter((x): x is { label: string; value: string } => x !== null)
      : []
    return items.length ? { type: 'fields', items } : null
  }

  if (o.type === 'actions') {
    const buttons = Array.isArray(o.buttons)
      ? o.buttons
          .map(normalizeButton)
          .filter((b): b is CardButton => b !== null)
      : []
    return buttons.length
      ? {
          type: 'actions',
          resolve: o.resolve === 'each' ? 'each' : 'once',
          buttons,
        }
      : null
  }

  // 未知块类型丢弃,而不是把 JSON 渲染给人看。协议加块时老客户端因此只是
  // 少显示一块,不会崩。
  return null
}

/** 宽容解析:任何说不通的地方都返回 null,调用方退回纯文本气泡。 */
export const parseRichCard = (raw: string): RichCardBody | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.blocks)) return null

  const blocks = o.blocks
    .map(normalizeBlock)
    .filter((b): b is CardBlock => b !== null)

  let header: RichCardBody['header']
  if (o.header && typeof o.header === 'object') {
    const h = o.header as Record<string, unknown>
    const title = typeof h.title === 'string' ? h.title : ''
    if (title) {
      const theme = THEMES.includes(h.theme as CardTheme)
        ? (h.theme as CardTheme)
        : 'neutral'
      header = { title, theme }
    }
  }

  if (!blocks.length && !header) return null
  return {
    v: typeof o.v === 'number' ? o.v : 1,
    header,
    blocks,
    plain: typeof o.plain === 'string' ? o.plain : undefined,
  }
}

// ---- 投影 -------------------------------------------------------------------

const spansPlain = (spans: CardSpan[]): string =>
  spans.map((s) => (s.tag === 'at' ? `@${s.name}` : s.text)).join('')

/** 摊平成纯文本 —— 预览、引用、转发快照、复制都用它。 */
export const richCardPlain = (body: RichCardBody): string => {
  const lines: string[] = []
  if (body.header) lines.push(body.header.title)
  for (const block of body.blocks) {
    if (block.type === 'text') {
      const line = spansPlain(block.spans).trim()
      if (line) lines.push(line)
    } else if (block.type === 'fields') {
      for (const item of block.items) {
        const line = [item.label, item.value].filter(Boolean).join(' ')
        if (line) lines.push(line)
      }
    }
    // divider / actions 不进纯文本:按钮是控件不是话,进了预览会读成
    // 「构建失败 同意上线 查看日志」,像机器人在念按钮。
  }
  return lines.join(' ').trim()
}

/**
 * 直接吃原始 body 的预览版本(什么都拿不到时返回空串,调用方自己兜底文案)。
 *
 * **必须在 parse 之前短路到 `plain`** —— 会话列表的 last_message 是被 jusi
 * 截断的,截断的 JSON 解析不出来,但截断的 plain 仍然是人话。
 *
 * 这条注释以前就在,但代码是先 parse 再取 plain —— 于是每一张卡在会话列表里
 * 都显示成「[卡片]」。真机上验到了才发现。实现见 [rawPlain]。
 */
export const richCardPreview = (raw: string): string => {
  const short = rawPlain(raw)
  if (short) return squeezePreview(short)
  const body = parseRichCard(raw)
  return body ? squeezePreview(body.plain || richCardPlain(body)) : ''
}

/**
 * 转发副本要剥掉 actions 块。
 *
 * 服务端对转发副本(新 mid、没有 ImCardMessage 行)返回 404 是真正的兜底,
 * 但不能让用户看到一排点不动的按钮。**别「顺手」把 actions 也转发过去。**
 */
export const stripActions = (raw: string): string => {
  const body = parseRichCard(raw)
  if (!body) return raw
  const blocks = body.blocks.filter((b) => b.type !== 'actions')
  if (blocks.length === body.blocks.length) return raw
  // 按钮上面那条 divider 现在什么都不分隔了 —— 只掐**尾部**的,中间的还在
  // 分隔内容。飞书的卡片几乎都是「…内容 / hr / 按钮」这个形状,所以不处理
  // 的话每张转发过去的卡都会挂一条悬空的线。
  while (blocks.length > 0 && blocks[blocks.length - 1].type === 'divider') {
    blocks.pop()
  }
  const next: Record<string, unknown> = { v: body.v, blocks }
  if (body.header) next.header = body.header
  if (body.plain) next.plain = body.plain
  return JSON.stringify(next)
}

/**
 * 第几个 actions 块 → 服务端用的 block key(``a0``/``a1``…)。
 *
 * **这是一条三端契约**:服务端 ``bot_cards.card_button_defs`` 按同样的规则
 * 编号,叠加层的 ``resolved`` 就是按这个 key 索引的。数错一位的后果是「点了
 * 第二块,结果显示在第一块上」—— 不会报错,只会诡异。
 *
 * 注意计的是 **actions 块的序号**,不是块在数组里的下标 —— 中间夹着的
 * text/fields/divider 不占号。
 */
export const actionsBlockKey = (blocks: CardBlock[], index: number): string =>
  `a${blocks.slice(0, index).filter((b) => b.type === 'actions').length}`

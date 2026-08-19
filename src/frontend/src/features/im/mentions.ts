import {
  parseRichText,
  richTextPlain,
  type RichTextTag,
} from './components/richText'
import {
  parseRichCard,
  richCardPlain,
  type CardBlock,
  type CardSpan,
} from './components/richCard'

/**
 * @ 的口径 —— **哪些 content_type 会被扫、怎么扫,只有这里说了算**;转发时怎么
 * 把 @ 拆掉([defuseMentions])也在这里,两者必须同进同退:判定多认一条腿而拆
 * 的时候漏了它,就是「转发一张卡把全群又 @ 一遍」。
 *
 * ## 为什么要有别名表
 *
 * 这个判定必须与**消息是用哪个 locale 发出来的**无关。德语同事在输入框里选
 * 「@Alle」发出去,消息正文里就是 `@Alle`;而中文同事的客户端只拿自己 locale
 * 的 `@所有人` 去比,永远对不上 —— 没有报错、没有日志,就是收不到提醒。
 *
 * 治不了的那一半在服务端:`client.sendText()` 直连 jusi 不过 we-meet 后端,
 * **没有任何服务端归一化点**。所以只能让每个客户端多认几个字面量。
 *
 * [MENTION_EVERYONE_ALIASES] 与后端
 * `core/tests/fixtures/im_cards/mention_everyone_aliases.json` 同源,三端各存
 * 一份硬编码,契约测试(`mentions.test.ts`)断言 常量 == 文件 == 各 locale 资源。
 * 与色板下标、rich-text fixture 完全同一手法。**改动要三仓同批。**
 *
 * ## 已知局限(不是本次引入的)
 *
 * 子串匹配没有词边界,所以 `@Allen` 会命中 `@Alle`。CJK 没有词边界,三端统一
 * 加边界判定代价过高,维持既有口径。
 */
export const MENTION_EVERYONE_ALIASES = [
  '所有人',
  'Everyone',
  'Alle',
  'Tout le monde',
  'Iedereen',
] as const

/** 这段文本里有没有「@所有人」—— 任意语种、大小写无关。 */
export const mentionsEveryone = (text: string): boolean => {
  const haystack = text.toLowerCase()
  return MENTION_EVERYONE_ALIASES.some((a) =>
    haystack.includes(`@${a.toLowerCase()}`)
  )
}

/** 这段文本里有没有点名 [names] 中的任何一个(空名字跳过)。 */
const mentionsAnyName = (
  text: string,
  names: readonly (string | undefined)[]
) => names.some((n) => !!n && text.includes(`@${n}`))

export interface MentionHit {
  /** 点到我了(按我的群昵称或目录名)。 */
  self: boolean
  /** 点了所有人。 */
  everyone: boolean
}

const NONE: MentionHit = { self: false, everyone: false }

/** `at` 标签里代表「所有人」的 uid。后端在 webhook 入口就归一了大小写。 */
const AT_EVERYONE_UID = 'all'

/**
 * 扫一条入站消息。[selfNames] 是「我」的所有叫法(群昵称 + 目录名)。
 *
 * - `text` —— 人手输入,只有字面量可扫。
 * - `rich-text` —— 群机器人发的,带结构,所以 @所有人 走**结构判定**
 *   (`at` 标签 uid === `all`);字面量那一路保留,机器人完全可以在正文里直接
 *   打「@所有人」而不发 `at` 标签。
 *   但**点名到人只走 `plain` 投影,刻意不看 `at.uid`**:那是 webhook 发送方
 *   随手填的外部字符串,不是我们的 im uid,拿它跟自己比既不对,还等于开了个
 *   「猜中 uid 就能定向戳人」的口子。
 * - `quote` —— **只扫回复正文,不扫被引用的快照**。引用一条 @所有人 的消息
 *   会让所有人**再被通知一次**,那是 bug 不是设计。
 * - 其余(图片/文件/卡片/合并转发/控制消息……)一律不扫。此前 Web 是拿原始
 *   body 无差别扫的,于是一个叫「@所有人 周会」的会议卡片也会点亮红 @。
 */
export const mentionScan = (
  contentType: string,
  body: string,
  selfNames: readonly (string | undefined)[]
): MentionHit => {
  const scanLiteral = (text: string): MentionHit => ({
    self: mentionsAnyName(text, selfNames),
    everyone: mentionsEveryone(text),
  })

  switch (contentType) {
    case 'text':
      return scanLiteral(body)

    case 'rich-text': {
      const rich = parseRichText(body)
      if (!rich) return NONE
      const byTag = rich.content.some((para) =>
        para.some((tag) => tag.tag === 'at' && tag.uid === AT_EVERYONE_UID)
      )
      const byPlain = scanLiteral(rich.plain ?? '')
      return { self: byPlain.self, everyone: byTag || byPlain.everyone }
    }

    case 'rich-card': {
      // 与 rich-text 同一套判定:@所有人 走结构(span 词汇是共用的),
      // 点名到人只走 plain。卡片的 spans 分散在各个块里,先摊平再判。
      const card = parseRichCard(body)
      if (!card) return NONE
      const byTag = card.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.spans.some(
            (span) => span.tag === 'at' && span.uid === AT_EVERYONE_UID
          )
      )
      const byPlain = scanLiteral(card.plain ?? '')
      return { self: byPlain.self, everyone: byTag || byPlain.everyone }
    }

    case 'quote': {
      try {
        const parsed: unknown = JSON.parse(body)
        const text =
          parsed && typeof parsed === 'object' && 'text' in parsed
            ? (parsed as { text?: unknown }).text
            : undefined
        return typeof text === 'string' ? scanLiteral(text) : NONE
      } catch {
        return NONE
      }
    }

    default:
      return NONE
  }
}

// ---- 转发时拆掉 @ ------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `@所有人` → `所有人`。与 [mentionsEveryone] 同一张表、同样大小写无关。 */
const EVERYONE_AT = new RegExp(
  `@(${MENTION_EVERYONE_ALIASES.map(escapeRe).join('|')})`,
  'gi'
)

/** 只摘 `@` 前缀,字一个不删 —— 预览里读作「…运行日志 所有人 环境 生产」。 */
const unmark = (plain: string, atNames: readonly string[]): string => {
  let out = plain.replace(EVERYONE_AT, '$1')
  // 点名到人:只摘这条消息自己 `at` 标签里出现过的名字,不碰正文里别的 `@`。
  for (const name of atNames) {
    if (name) out = out.split(`@${name}`).join(name)
  }
  return out
}

const defuseCard = (raw: string): string => {
  const body = parseRichCard(raw)
  if (!body) return raw

  const names: string[] = []
  const blocks: CardBlock[] = body.blocks.map((block) => {
    if (block.type !== 'text' || !block.spans.some((s) => s.tag === 'at')) {
      return block
    }
    const spans: CardSpan[] = block.spans.map((s) => {
      if (s.tag !== 'at') return s
      names.push(s.name)
      return { tag: 'text', text: `@${s.name}` }
    })
    return { type: 'text', spans }
  })

  // plain 从**原始** spans 推,推完一定要写回去 —— 不写的话对端拿不到 plain
  // 会照降级后的正文重推一遍,`@所有人` 原样长回来。
  const derived = body.plain || richCardPlain(body)
  const plain = unmark(derived, names)
  if (!names.length && plain === derived) return raw

  const next: Record<string, unknown> = { v: body.v, blocks, plain }
  if (body.header) next.header = body.header
  return JSON.stringify(next)
}

const defuseRichText = (raw: string): string => {
  const body = parseRichText(raw)
  if (!body) return raw

  const names: string[] = []
  const content: RichTextTag[][] = body.content.map((para) =>
    para.map((tag) => {
      if (tag.tag !== 'at') return tag
      names.push(tag.name)
      return { tag: 'text', text: `@${tag.name}` }
    })
  )

  const derived = body.plain || richTextPlain(body)
  const plain = unmark(derived, names)
  if (!names.length && plain === derived) return raw
  return JSON.stringify({ v: body.v, title: body.title, content, plain })
}

/**
 * 把要**转发**出去的 body 里的 @ 拆掉,让它在目标会话里不再点亮任何人。
 *
 * 转发的人想 @ 全群,应该自己打 —— 而不是靠转发时夹带。飞书也是这个口径:
 * 转发过去的 @ 退化成普通文字,不触发通知。
 *
 * ## 为什么正文保留 `@`、只把 `plain` 里的摘掉
 *
 * [mentionScan] 有两条腿:结构(`at` 标签)和 `plain` 里的字面量。**两条都得断**,
 * 只断一条等于没断。但正文是「机器人当时说了什么」,读者该照原样看到 —— 所以
 * 正文只把 `at` 标签降级成普通文字(渲染上从蓝色粗体变灰字,这正是「这个 @ 不
 * 生效」的视觉信号),文字一个字不改;真正被改掉的是 `plain` 投影里那个 `@`。
 * 这层刻意的不一致只在预览/搜索里看得见,换来的是正文不被篡改。
 *
 * ## 拆不掉的那一半(刻意不做)
 *
 * 纯 `text` 消息不碰:那是**人写的一句话**,body 就是正文、没有投影层可改,
 * 动它等于替人改口。同理机器人在正文里手打的「@张三」—— 纯文本里的人名与普通
 * 文字无从区分。所以转发一条纯文本的 `@所有人` 仍然会亮,这条是已知边界。
 */
export const defuseMentions = (contentType: string, raw: string): string => {
  if (contentType === 'rich-card') return defuseCard(raw)
  if (contentType === 'rich-text') return defuseRichText(raw)
  return raw
}

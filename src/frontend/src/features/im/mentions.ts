import { parseRichText } from './components/richText'
import { parseRichCard } from './components/richCard'

/**
 * 「我被 @ 了吗」的判定 —— **哪些 content_type 会被扫、怎么扫,只有这里说了算**。
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
    haystack.includes(`@${a.toLowerCase()}`),
  )
}

/** 这段文本里有没有点名 [names] 中的任何一个(空名字跳过)。 */
const mentionsAnyName = (text: string, names: readonly (string | undefined)[]) =>
  names.some((n) => !!n && text.includes(`@${n}`))

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
  selfNames: readonly (string | undefined)[],
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
        para.some((tag) => tag.tag === 'at' && tag.uid === AT_EVERYONE_UID),
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
            (span) => span.tag === 'at' && span.uid === AT_EVERYONE_UID,
          ),
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

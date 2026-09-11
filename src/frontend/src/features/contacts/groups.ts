import type { ImUserInfo } from '@/features/im/api/resolveImUsers'

/**
 * 群名解析结果:
 *   - 'named'   群主设了名字 —— 直接用;
 *   - 'derived' 没设名字 → 用前几名成员的名字拼一个「张三、李四等 3 人」;
 *   - 'unnamed' 连成员名都解析不出来 → 只能叫「未命名群聊」。
 *
 * 为什么要中间这一档:同一个人常常有好几个没名字的群(截图里就有),一律显示
 * 「未命名群聊」会让它们看起来一模一样,只能靠头像九宫格分辨 —— 而头像也可能
 * 都是同一个默认样式。用成员名代替是为了让这几行**能被人区分**。
 */
export type GroupName =
  | { kind: 'named'; name: string }
  | { kind: 'derived'; names: string; count: number }
  | { kind: 'unnamed' }

interface Options {
  /** 当前用户的 IM uid —— 拼名字时先排除自己(没人管自己的群叫「我、张三」)。 */
  selfUid: string
  /** 名字之间的分隔符,各语言不同(中文「、」,西文「, 」)。 */
  separator: string
  /** 最多列几个人的名字,其余用「等 N 人」收口。 */
  maxNames?: number
}

export const resolveGroupName = (
  // name 在 SDK 类型里是 string,但服务端给空群时可能是 null/undefined —— 按可选
  // 处理,免得「未命名群」这条路径要靠调用方先兜一次底才不炸。
  group: { name?: string | null; members: string[] },
  memberInfo: Record<string, ImUserInfo | undefined>,
  { selfUid, separator, maxNames = 2 }: Options
): GroupName => {
  const named = group.name?.trim()
  if (named) return { kind: 'named', name: named }

  const others = group.members.filter((uid) => uid !== selfUid)
  // 群里只有自己时不排除自己 —— 否则名字池是空的,会白白退化成「未命名群聊」。
  const pool = others.length > 0 ? others : group.members
  const names = pool
    .map((uid) => memberInfo[uid]?.full_name?.trim())
    .filter((name): name is string => !!name)

  if (names.length === 0) return { kind: 'unnamed' }
  return {
    kind: 'derived',
    names: names.slice(0, maxNames).join(separator),
    count: pool.length,
  }
}

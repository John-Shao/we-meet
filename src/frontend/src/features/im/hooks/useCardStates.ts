import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Message } from '@jusi/light-im-sdk'

import { fetchCardStates, type CardState } from '../api/cardStates'

/**
 * 卡片按钮的叠加层(二期 A2)。
 *
 * ## 两个来源,一条合并规则
 *
 * 1. **消息流回放** —— `card-state` 是真实的 jusi 消息(只是不自成一行),
 *    所以它随 ws 到达、随历史加载出现。与表情回应的 `reactionsByMid` 是
 *    同一手法。
 * 2. **批量兜底** —— 往上翻到一张老卡时,它的 `card-state` 可能落在已加载
 *    窗口之外。对这一屏的卡片 mid 拉一次服务端状态补上。
 *
 * 合并规则是**流内后到的赢、流压过批量**。`once` 块靠数据库上的部分唯一约束
 * 保证**每块只有一条**,但那一条的**文案可以被改写一次** —— 出站回调成功后
 * 上游能用 `{"text": …}` 覆盖结果条,服务端会为此再播一条 `card-state`。所以
 * 这里不能写成「谁有算谁、先到的说了算」:那样上游的覆盖永远显示不出来。
 *
 * 仍然不比时间戳 —— 消息流本身有序,后面那条就是新的。
 *
 * ## 时序陷阱
 *
 * ws 的 `card-state` **可能早于点击接口的 HTTP 响应到达**。所以这里返回的
 * 状态是唯一真相,调用方的本地乐观态只能当提示用;**绝不能**把两者按时间戳
 * 合并 —— 那样先到的 ws 会被后到的响应「覆盖」回旧值。
 */
export const useCardStates = (messages: Message[]) => {
  // ① 消息流里的 card-state 控制消息。
  const fromStream = useMemo(() => {
    const map = new Map<number, CardState>()
    for (const m of messages) {
      if (m.content_type !== 'card-state') continue
      try {
        const body = JSON.parse(m.body) as {
          target_mid?: unknown
          block?: unknown
          button_id?: unknown
          text?: unknown
        }
        const mid = body.target_mid
        const block = body.block
        if (typeof mid !== 'number' || typeof block !== 'string') continue
        const entry = map.get(mid) ?? { mid, expired: false, resolved: {} }
        entry.resolved[block] = {
          button_id: typeof body.button_id === 'string' ? body.button_id : '',
          text: typeof body.text === 'string' ? body.text : '',
          at: new Date(m.ts ?? Date.now()).toISOString(),
        }
        map.set(mid, entry)
      } catch {
        // 坏的控制消息就当没有 —— 卡片照常显示按钮,总比整条聊天崩了强。
      }
    }
    return map
  }, [messages])

  // ② 这一屏有哪些卡片。排序后进 queryKey,免得顺序抖动引发重复请求。
  const cardMids = useMemo(
    () =>
      [...new Set(messages.filter((m) => m.content_type === 'rich-card').map((m) => m.mid))].sort(
        (a, b) => a - b,
      ),
    [messages],
  )

  const { data } = useQuery({
    queryKey: ['im', 'card-states', cardMids],
    queryFn: () => fetchCardStates(cardMids),
    enabled: cardMids.length > 0,
    // 实时更新走 ws 回放,这条只是冷加载的兜底 —— 不需要频繁重取。
    staleTime: 60_000,
  })

  return useMemo(() => {
    const merged = new Map<number, CardState>()
    for (const state of data?.states ?? []) {
      merged.set(state.mid, { ...state, resolved: { ...state.resolved } })
    }
    for (const [mid, state] of fromStream) {
      const existing = merged.get(mid)
      if (!existing) {
        merged.set(mid, state)
        continue
      }
      // 流压过批量。两边都有同一个 block 时,批量那份可能是上游覆盖前的旧
      // 文案(它 staleTime 60s),而流里那条已经是覆盖后的了。
      existing.resolved = { ...existing.resolved, ...state.resolved }
    }
    return (mid: number): CardState | undefined => merged.get(mid)
  }, [data, fromStream])
}

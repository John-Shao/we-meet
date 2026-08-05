import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Client,
  ConversationSummary,
  MsgOutPayload,
  ReadOutPayload,
} from '@jusi/light-im-sdk'

const KEY = ['im', 'conversations'] as const

// 不冒泡的控制消息(表情回复/撤回/卡片按钮状态):不改活跃时间、不计未读、
// 不顶会话(对齐 P12 服务端的 IM_NONBUMPING_CONTENT_TYPES)。
//
// 本地这份是**兜底**不是主力:服务端漏配时降级成「会话冒泡」,而不是列表里
// 直接出现一坨 JSON。两边都要有。
const NON_BUMPING = new Set(['reaction', 'recall', 'card-state'])

/**
 * 会话动态排序(飞书/微信式):置顶会话在上,每组内部按「最近活跃时间」
 * (last_message_ts)倒序 —— 新消息把会话顶到本组顶部。空会话 / 时间相等时,
 * 稳定排序保留服务端返回的相对序(≈ 创建时间倒序)。
 */
export const sortConversations = (
  list: ConversationSummary[]
): ConversationSummary[] =>
  [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return (b.last_message_ts ?? 0) - (a.last_message_ts ?? 0)
  })

/**
 * Conversation-list hook.
 *
 * - React Query single fetch on mount via SDK.listConversations().
 * - Subscribes to onMessage / onRead from the same Client; an event for a
 *   conversation already in the list bumps its unread_count / last_seq
 *   in-place (no re-fetch). An event for an UNKNOWN cid means we were just
 *   pulled into a new group / direct conversation (its first message arrived
 *   before we ever fetched it) — re-fetch the whole list so it shows up live
 *   with its name + members, instead of only appearing after a manual reload.
 * - Subscribes to onConversation (P8): the server pushes a lifecycle event the
 *   moment we're added to a conversation, so a brand-new group/direct appears
 *   live even before any message is sent. We just re-fetch the list.
 */
export const useConversations = (client: Client, selfUid: string) => {
  const qc = useQueryClient()

  useEffect(() => {
    const offMsg = client.onMessage((m: MsgOutPayload) => {
      // 不冒泡类型(表情/撤回)不动列表:不改活跃时间、不计未读、不重排(P12)。
      if (NON_BUMPING.has(m.content_type)) return
      const prev = qc.getQueryData<ConversationSummary[]>(KEY)
      // 未知会话(刚被拉进的新群/新私聊)的首条消息 → 整列表重拉,带出名称+成员。
      if (!prev || !prev.some((c) => c.cid === m.cid)) {
        void qc.invalidateQueries({ queryKey: KEY })
        return
      }
      qc.setQueryData<ConversationSummary[]>(KEY, (cur) =>
        cur?.map((c) =>
          c.cid === m.cid
            ? {
                ...c,
                last_seq: Math.max(c.last_seq, m.seq),
                unread_count: c.unread_count + 1,
                // P11: keep the list preview + time live (else stale until a
                // full refetch). Covers normal / system / own messages alike.
                last_message: m.body,
                last_message_ts: m.created_at,
                last_sender_uid: m.sender_uid,
                last_content_type: m.content_type,
              }
            : c
        )
      )
    })
    const offRead = client.onRead((r: ReadOutPayload) => {
      // 已读回执会广播给会话全体成员;只有「我自己」的已读才动我的未读数。
      // 否则发送者读自己刚发的消息(markRead),会把其他成员的 badge 误清成 0。
      if (r.uid !== selfUid) return
      qc.setQueryData<ConversationSummary[]>(KEY, (prev) => {
        if (!prev) return prev
        return prev.map((c) =>
          c.cid === r.cid
            ? {
                ...c,
                unread_count: Math.max(0, c.last_seq - r.seq),
              }
            : c
        )
      })
    })
    // P8: 被拉进新会话(建群/拉人/新私聊)时服务端主动推 conv 事件;
    // 哪怕一条消息都没发,也立即重拉列表让新会话冒泡。
    const offConv = client.onConversation(() => {
      void qc.invalidateQueries({ queryKey: KEY })
    })
    return () => {
      offMsg()
      offRead()
      offConv()
    }
  }, [client, qc, selfUid])

  return useQuery({
    queryKey: KEY,
    queryFn: () => client.listConversations(),
    staleTime: 30_000,
    // 排序放 select:首拉与 onMessage 就地更新都经同一比较器,服务端返回顺序无所谓。
    // 模块级函数引用稳定,React Query 按 data 引用记忆化,不会每帧重排。
    select: sortConversations,
  })
}

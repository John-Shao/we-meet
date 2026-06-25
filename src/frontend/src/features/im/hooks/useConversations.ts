import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Client,
  ConversationSummary,
  MsgOutPayload,
  ReadOutPayload,
} from '@jusi/light-im-sdk'

const KEY = ['im', 'conversations'] as const

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
 */
export const useConversations = (client: Client, selfUid: string) => {
  const qc = useQueryClient()

  useEffect(() => {
    const offMsg = client.onMessage((m: MsgOutPayload) => {
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
              }
            : c,
        ),
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
            : c,
        )
      })
    })
    return () => {
      offMsg()
      offRead()
    }
  }, [client, qc, selfUid])

  return useQuery({
    queryKey: KEY,
    queryFn: () => client.listConversations(),
    staleTime: 30_000,
  })
}

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, Message, MsgOutPayload } from '@jusi/light-im-sdk'

const keyOf = (cid: string) => ['im', 'messages', cid] as const

/**
 * Message-history hook for a single conversation.
 *
 * - React Query loads the most-recent page (no `beforeSeq`) on mount.
 * - Subscribes to onMessage and appends the new message to the cached page if
 *   it belongs to `cid`. We DON'T re-fetch on every msg — that would thrash
 *   the network for high-throughput conversations.
 *
 * Returned messages are sorted seq-ascending (oldest → newest) for natural rendering.
 */
export const useMessages = (client: Client, cid: string | null) => {
  const qc = useQueryClient()

  useEffect(() => {
    if (!cid) return
    const off = client.onMessage((m: MsgOutPayload) => {
      if (m.cid !== cid) return
      qc.setQueryData<Message[]>(keyOf(cid), (prev) => {
        const next: Message = {
          mid: m.mid,
          cid: m.cid,
          sender_uid: m.sender_uid,
          seq: m.seq,
          content_type: m.content_type,
          body: m.body,
          ts: m.created_at,
        }
        if (!prev) return [next]
        // Skip dupes (e.g. ack-driven local echo also landed via broadcast).
        if (prev.some((x) => x.mid === next.mid)) return prev
        return [...prev, next].sort((a, b) => a.seq - b.seq)
      })
    })
    return off
  }, [client, cid, qc])

  // P16 原生撤回/表情回应:把服务端事件直接打进缓存里的消息最终态
  // (recalled / reactions 字段)。历史加载时快照已带,这里只维护增量;
  // 旧数据的控制消息回放仍由 ChatPane 兜底(双读)。
  useEffect(() => {
    if (!cid) return
    const offRecalled = client.onMessageRecalled((e) => {
      if (e.cid !== cid) return
      qc.setQueryData<Message[]>(keyOf(cid), (prev) =>
        prev?.map((m) =>
          m.mid === e.mid ? { ...m, recalled: true, body: '' } : m
        )
      )
    })
    const offReaction = client.onReaction((e) => {
      if (e.cid !== cid) return
      qc.setQueryData<Message[]>(keyOf(cid), (prev) =>
        prev?.map((m) => {
          if (m.mid !== e.mid) return m
          const groups = (m.reactions ?? []).map((g) => ({
            emoji: g.emoji,
            uids: [...g.uids],
          }))
          let g = groups.find((x) => x.emoji === e.emoji)
          if (e.op === 'add') {
            if (!g) {
              g = { emoji: e.emoji, uids: [] }
              groups.push(g)
            }
            if (!g.uids.includes(e.uid)) g.uids.push(e.uid)
          } else if (g) {
            g.uids = g.uids.filter((u) => u !== e.uid)
          }
          return { ...m, reactions: groups.filter((x) => x.uids.length > 0) }
        })
      )
    })
    return () => {
      offRecalled()
      offReaction()
    }
  }, [client, cid, qc])

  return useQuery({
    // Inline `cid` (not keyOf) so the query plugin sees it; matches keyOf(cid).
    queryKey: ['im', 'messages', cid ?? 'none'],
    queryFn: async () => {
      if (!cid) return [] as Message[]
      const { messages } = await client.loadHistory(cid)
      // Server returns latest-first; reverse for natural top-to-bottom display.
      return messages.slice().reverse()
    },
    enabled: !!cid,
    // staleTime 0 so switching back into a conversation always refetches the
    // latest page. Messages that arrived while this conversation was NOT open
    // are only appended live for the OPEN cid (see the onMessage effect above),
    // so a stale cache would otherwise hide them until a manual refresh.
    staleTime: 0,
  })
}

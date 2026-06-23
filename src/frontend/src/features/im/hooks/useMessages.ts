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
    staleTime: 30_000,
  })
}

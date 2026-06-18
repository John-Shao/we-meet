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
 * - Subscribes to onMessage / onRead from the same Client; every event
 *   bumps the unread_count / last_seq of the matching cid in-place so
 *   we don't need to re-fetch the whole list.
 */
export const useConversations = (client: Client) => {
  const qc = useQueryClient()

  useEffect(() => {
    const offMsg = client.onMessage((m: MsgOutPayload) => {
      qc.setQueryData<ConversationSummary[]>(KEY, (prev) => {
        if (!prev) return prev
        return prev.map((c) =>
          c.cid === m.cid
            ? {
                ...c,
                last_seq: Math.max(c.last_seq, m.seq),
                unread_count: c.unread_count + 1,
              }
            : c,
        )
      })
    })
    const offRead = client.onRead((r: ReadOutPayload) => {
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
  }, [client, qc])

  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      try {
        const list = await client.listConversations()
        console.debug('[useConversations] listConversations resolved:', list.length)
        return list
      } catch (e) {
        console.error('[useConversations] listConversations failed:', e)
        throw e
      }
    },
    staleTime: 30_000,
  })
}

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useImConnection } from '../hooks/useImConnection'

/**
 * Global IM presence + unread aggregator (P6-e). Mounted once above the rail so
 * the SDK client connects app-wide (not just on /im) and the rail's 消息 badge
 * stays live everywhere.
 *
 * It deliberately does NOT reuse useConversations (which optimistically does
 * unread_count + 1 on each message) — running that twice would double-count.
 * Instead it keeps a read-only ['im','conversations'] query and just invalidates
 * it on message/read/conversation events, letting the server be authoritative.
 * On /im, ImRoute's useConversations owns the optimistic path; the invalidate
 * here reconciles to the server value (idempotent, no double-count).
 *
 * Muted conversations don't inflate the red number (Feishu behaviour).
 */

const ImUnreadContext = createContext<{ messages: number }>({ messages: 0 })

// eslint-disable-next-line react-refresh/only-export-components
export const useImUnread = () => useContext(ImUnreadContext)

/**
 * Safe wrapper: only mounts the SDK-connecting variant when IM is configured
 * (getImClient throws otherwise). Unconfigured → a no-op provider yielding 0,
 * so the rail badge code stays unconditional.
 */
export const ImUnreadProvider = ({ children }: { children: ReactNode }) => {
  if (!import.meta.env.VITE_JUSI_IM_BASE_URL) {
    return (
      <ImUnreadContext.Provider value={{ messages: 0 }}>
        {children}
      </ImUnreadContext.Provider>
    )
  }
  return <ImUnreadConnected>{children}</ImUnreadConnected>
}

const ImUnreadConnected = ({ children }: { children: ReactNode }) => {
  const { client } = useImConnection()
  const qc = useQueryClient()

  const { data: conversations = [] } = useQuery({
    queryKey: ['im', 'conversations'],
    queryFn: () => client.listConversations(),
    staleTime: 30_000,
  })

  useEffect(() => {
    const invalidate = () =>
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    const offMsg = client.onMessage(invalidate)
    const offRead = client.onRead(invalidate)
    const offConv = client.onConversation(invalidate)
    return () => {
      offMsg()
      offRead()
      offConv()
    }
  }, [client, qc])

  const messages = conversations.reduce(
    (n, c) => n + (c.muted ? 0 : c.unread_count),
    0
  )

  return (
    <ImUnreadContext.Provider value={{ messages }}>
      {children}
    </ImUnreadContext.Provider>
  )
}

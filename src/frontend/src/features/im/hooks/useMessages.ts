import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, Message, MsgOutPayload } from '@jusi/light-im-sdk'

const keyOf = (cid: string) => ['im', 'messages', cid] as const

const PAGE = 50
/** How many messages AFTER the anchor to include in the opening window. */
const ANCHOR_AHEAD = 10

/** P1-M2: open the history at a specific seq (search hit / 稍后处理跳转).
 * `key` is a nonce — a new key re-anchors even for the same seq. */
export interface MessagesAnchor {
  seq: number
  key: string
}

const toMessage = (m: MsgOutPayload): Message => ({
  mid: m.mid,
  cid: m.cid,
  sender_uid: m.sender_uid,
  seq: m.seq,
  content_type: m.content_type,
  body: m.body,
  ts: m.created_at,
})

const mergeSorted = (prev: Message[], add: Message[]): Message[] => {
  const seen = new Set(prev.map((m) => m.mid))
  const fresh = add.filter((m) => !seen.has(m.mid))
  if (fresh.length === 0) return prev
  return [...prev, ...fresh].sort((a, b) => a.seq - b.seq)
}

/**
 * Message-history hook for a single conversation.
 *
 * Live mode (no anchor): loads the most-recent page and appends realtime
 * messages, exactly as before.
 *
 * Anchored mode (P1-M2 定位): the server only supports `beforeSeq` paging,
 * but seqs are per-conversation contiguous — so the opening window is
 * `beforeSeq = anchor.seq + ANCHOR_AHEAD + 1` (anchor lands near the bottom
 * of the page), and FORWARD paging uses the identity
 * `beforeSeq = maxLoaded + PAGE + 1, limit PAGE` ⇒ exactly the next PAGE
 * newer messages. While not caught up with the live tail, realtime messages
 * are buffered (appending them would create a visible gap) and merged the
 * moment forward paging reaches the tail.
 *
 * Returned messages are sorted seq-ascending (oldest → newest).
 */
export const useMessages = (
  client: Client,
  cid: string | null,
  anchor?: MessagesAnchor | null
) => {
  const qc = useQueryClient()
  const anchorKey = anchor?.key ?? null

  // Live mode is always "caught up"; anchored mode starts behind the tail.
  const [caughtUp, setCaughtUp] = useState(!anchorKey)
  const caughtUpRef = useRef(caughtUp)
  const [hasMoreOlder, setHasMoreOlder] = useState(true)
  const loadingOlderRef = useRef(false)
  const loadingNewerRef = useRef(false)
  /** Realtime messages parked while the window lags behind the tail. */
  const pendingLiveRef = useRef<Message[]>([])
  /** Read by the queryFn so re-anchoring reuses the same query key (patches
   * from onMessageRecalled/onReaction keep targeting keyOf(cid)). */
  const anchorRef = useRef<MessagesAnchor | null>(anchor ?? null)
  anchorRef.current = anchor ?? null

  const setCaught = useCallback((v: boolean) => {
    caughtUpRef.current = v
    setCaughtUp(v)
  }, [])

  // Re-anchor (or return to live) whenever the anchor key or cid changes:
  // reset flags and force the query to run again through the anchor-aware
  // queryFn below. staleTime 0 + invalidate ⇒ a fresh fetch either way.
  useEffect(() => {
    if (!cid) return
    setCaught(!anchorKey)
    setHasMoreOlder(true)
    pendingLiveRef.current = []
    void qc.invalidateQueries({ queryKey: keyOf(cid) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, cid])

  useEffect(() => {
    if (!cid) return
    const off = client.onMessage((m: MsgOutPayload) => {
      if (m.cid !== cid) return
      const next = toMessage(m)
      if (!caughtUpRef.current) {
        // Window mode: appending a tail message next to an old window would
        // render a silent gap — park it until forward paging catches up.
        if (!pendingLiveRef.current.some((x) => x.mid === next.mid)) {
          pendingLiveRef.current.push(next)
        }
        return
      }
      qc.setQueryData<Message[]>(keyOf(cid), (prev) => {
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

  const query = useQuery({
    // Inline `cid` (not keyOf) so the query plugin sees it; matches keyOf(cid).
    // The anchor deliberately does NOT participate in the key — recall/reaction
    // patches and the live append all target keyOf(cid).
    queryKey: ['im', 'messages', cid ?? 'none'],
    queryFn: async () => {
      if (!cid) return [] as Message[]
      const a = anchorRef.current
      const { messages } = a
        ? await client.loadHistory(cid, {
            beforeSeq: a.seq + ANCHOR_AHEAD + 1,
            limit: PAGE,
          })
        : await client.loadHistory(cid)
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

  /** Scroll-to-top pagination (works in both modes). Returns true when
   * something was prepended (the caller restores the scroll offset). */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!cid || loadingOlderRef.current) return false
    const cur = qc.getQueryData<Message[]>(keyOf(cid))
    const min = cur?.[0]?.seq
    if (!cur || !min || min <= 1) return false
    loadingOlderRef.current = true
    try {
      const res = await client.loadHistory(cid, {
        beforeSeq: min,
        limit: PAGE,
      })
      setHasMoreOlder(res.has_more)
      const older = res.messages.slice().reverse()
      if (older.length === 0) return false
      qc.setQueryData<Message[]>(keyOf(cid), (prev) =>
        mergeSorted(prev ?? [], older)
      )
      return true
    } catch {
      return false
    } finally {
      loadingOlderRef.current = false
    }
  }, [cid, client, qc])

  /** Scroll-to-bottom pagination while anchored behind the tail. Flips
   * caughtUp (and merges parked realtime messages) on reaching it. */
  const loadNewer = useCallback(async (): Promise<void> => {
    if (!cid || loadingNewerRef.current || caughtUpRef.current) return
    const cur = qc.getQueryData<Message[]>(keyOf(cid))
    const max = cur?.[cur.length - 1]?.seq
    if (!cur || max === undefined) return
    loadingNewerRef.current = true
    try {
      // `seq < max + PAGE + 1, newest PAGE` ⇒ exactly seqs (max, max+PAGE].
      const res = await client.loadHistory(cid, {
        beforeSeq: max + PAGE + 1,
        limit: PAGE,
      })
      const newer = res.messages
        .slice()
        .reverse()
        .filter((m) => m.seq > max)
      qc.setQueryData<Message[]>(keyOf(cid), (prev) =>
        mergeSorted(prev ?? [], newer)
      )
      if (newer.length < PAGE) {
        // Tail reached — merge anything that arrived live while we paged.
        const parked = pendingLiveRef.current
        pendingLiveRef.current = []
        if (parked.length > 0) {
          qc.setQueryData<Message[]>(keyOf(cid), (prev) =>
            mergeSorted(prev ?? [], parked)
          )
        }
        setCaught(true)
      }
    } catch {
      // Best-effort; the next bottom-scroll retries.
    } finally {
      loadingNewerRef.current = false
    }
  }, [cid, client, qc, setCaught])

  return {
    ...query,
    caughtUp,
    hasMoreOlder,
    loadOlder,
    loadNewer,
  }
}

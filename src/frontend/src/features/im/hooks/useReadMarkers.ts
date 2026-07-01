import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ReadMarker, ReadOutPayload } from '@jusi/light-im-sdk'

/** cid → { uid → last_read_seq } read-marker map for the open conversation. */
export type ReadMap = Record<string, number>

const keyOf = (cid: string) => ['im', 'reads', cid] as const

/**
 * 已读回执(P13):某会话每个成员的 last_read_seq。
 *
 * - 首次进会话用 client.listReads(cid) 拉一次全量快照(无 marker 的成员=未读=0)。
 * - 订阅 onRead,别人已读推进时就地更新缓存,保持实时。镜像 useMessages 的模式:
 *   不重新拉取,只 patch 单个 uid。
 *
 * 返回 { uid: seq };调用方按「reads[uid] >= 消息 seq」判定该成员是否已读。
 */
export const useReadMarkers = (client: Client, cid: string | null): ReadMap => {
  const qc = useQueryClient()

  useEffect(() => {
    if (!cid) return
    const off = client.onRead((p: ReadOutPayload) => {
      if (p.cid !== cid) return
      qc.setQueryData<ReadMap>(keyOf(cid), (prev) => {
        const next = { ...(prev ?? {}) }
        // 单调:只前进,不回退。
        if ((next[p.uid] ?? 0) < p.seq) next[p.uid] = p.seq
        return next
      })
    })
    return off
  }, [client, cid, qc])

  const { data } = useQuery({
    queryKey: ['im', 'reads', cid ?? 'none'],
    queryFn: async () => {
      if (!cid) return {} as ReadMap
      const markers: ReadMarker[] = await client.listReads(cid)
      const map: ReadMap = {}
      for (const m of markers) map[m.uid] = m.seq
      return map
    },
    enabled: !!cid,
    // 只需一次快照即可;之后由 onRead 保活。切回会话时重取以补齐离线期间的推进。
    staleTime: 30_000,
    retry: false,
  })

  return data ?? {}
}

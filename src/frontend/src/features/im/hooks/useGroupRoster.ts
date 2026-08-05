import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client } from '@jusi/light-im-sdk'

import { resolveImUsers } from '../api/resolveImUsers'

/**
 * 一个群的花名册 + 每个成员的显示身份。
 *
 * 抽出来是因为它有**两个消费者**:成员二级页要 roster / names / nameOf,
 * 而 root 页只为了「我的群昵称」那一行 —— `ConversationSummary` 里没有
 * caller 自己的 nickname,除了 roster 没有第二个来源。
 *
 * ⚠️ **两处同时调用是安全的,不是 bug**:
 * - 两次 `useQuery` 用的是同一组 queryKey,react-query 去重成一次请求;
 * - 两次 `onConversation` 注册各自失效同一个 key,合并成一次 refetch。
 *
 * 下一个人看到「同一个 hook 挂了两遍」大概率会想去掉一个,所以写在这里。
 */
export const useGroupRoster = (
  client: Client,
  cid: string,
  currentUserUID: string,
) => {
  const qc = useQueryClient()

  // The roster is its own REST query; a conv lifecycle event for this group
  // (someone joined / left / was removed) only refreshes the conversation list,
  // not this query — so without invalidating here the open panel stays stale
  // until reopened. Refetch the roster whenever this conversation changes.
  useEffect(() => {
    const off = client.onConversation((ev) => {
      if (ev.cid === cid) {
        void qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      }
    })
    return off
  }, [client, cid, qc])

  const { data: roster = [], isLoading } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
    // Never retry: a 403 (you left / were removed) won't succeed on retry, and
    // the default 3× backoff would freeze the UI ~5s after leaving the group.
    retry: false,
  })

  const rosterUids = roster.map((m) => m.uid)
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', rosterUids],
    queryFn: () => resolveImUsers(rosterUids),
    enabled: rosterUids.length > 0,
    staleTime: 60_000,
  })

  // P10: a member's group nickname overrides their org-directory name.
  const nameOf = (uid: string) =>
    roster.find((m) => m.uid === uid)?.nickname || names[uid]?.full_name || uid

  const myNickname =
    roster.find((m) => m.uid === currentUserUID)?.nickname ?? ''

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
    await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
  }

  return { roster, isLoading, names, nameOf, myNickname, refresh }
}

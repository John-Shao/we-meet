import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { resolveImUsers } from '../api/resolveImUsers'
import { fetchImToken } from '../api/fetchImToken'
import type { ForwardConv } from '../components/ForwardDialog'
import { useConversations } from './useConversations'
import { useImConnection } from './useImConnection'

/**
 * 会话列表 → ForwardDialog 条目(name/avatar/members)。
 *
 * 逻辑与 ImRoute 里的 nameOf/avatarOf/membersOf 同源,但那边继续用自己的本地
 * 版本(已有 t/currentUserUID 等上下文,重写有回归风险);这里是给 IM 连接树
 * *之外* 的调用者用的独立入口——分享云文档到聊天入口 B 从 /docs 路由触发,
 * 不在 ImRoute 树里,拿不到那些局部变量。useImConnection() 是幂等的
 * (拿的是同一个 Client 单例),从这里调用不会开出第二条连接。
 */
export const useForwardConversations = () => {
  const { t } = useTranslation('im')
  const { client } = useImConnection()
  const { data: tokenData } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    staleTime: 60_000,
  })
  const currentUserUID = tokenData?.uid ?? ''
  const { data: conversations = [], isLoading } = useConversations(
    client,
    currentUserUID
  )

  const peerUids = Array.from(
    new Set(
      conversations
        .filter((c) => c.type === 'direct')
        .map((c) => c.members.find((u) => u !== currentUserUID))
        .filter((u): u is string => !!u)
    )
  )
  const { data: peerNames = {} } = useQuery({
    queryKey: ['im', 'peer-names', peerUids],
    queryFn: () => resolveImUsers(peerUids),
    enabled: peerUids.length > 0 && !!currentUserUID,
    staleTime: 60_000,
  })

  const groupMemberUids = Array.from(
    new Set(
      conversations
        .filter((c) => c.type === 'group')
        .flatMap((c) => c.members.slice(0, 9))
    )
  )
  const { data: groupMemberInfo = {} } = useQuery({
    queryKey: ['im', 'group-member-info', groupMemberUids],
    queryFn: () => resolveImUsers(groupMemberUids),
    enabled: groupMemberUids.length > 0,
    staleTime: 60_000,
  })

  const nameOf = (c: ConversationSummary): string => {
    if (c.type === 'group') {
      return c.name && c.name.trim() ? c.name : t('convName.groupFallback')
    }
    const peer = c.members.find((u) => u !== currentUserUID)
    return (peer && peerNames[peer]?.full_name) || t('convName.directFallback')
  }
  const avatarOf = (c: ConversationSummary): string | undefined => {
    if (c.type === 'group') return undefined
    const peer = c.members.find((u) => u !== currentUserUID)
    return (peer && peerNames[peer]?.avatar_url) || undefined
  }
  const peerUserIdOf = (c: ConversationSummary): string | undefined => {
    if (c.type === 'group') return undefined
    const peer = c.members.find((u) => u !== currentUserUID)
    return (peer && peerNames[peer]?.id) || undefined
  }
  const membersOf = (c: ConversationSummary) => {
    if (c.type !== 'group') return undefined
    return c.members.slice(0, 9).map((uid) => ({
      name: groupMemberInfo[uid]?.full_name || '',
      src: groupMemberInfo[uid]?.avatar_url || undefined,
    }))
  }

  const forwardConvs: ForwardConv[] = conversations.map((c) => ({
    cid: c.cid,
    name: nameOf(c),
    avatarUrl: avatarOf(c),
    members: membersOf(c),
    isGroup: c.type === 'group',
    peerUserId: peerUserIdOf(c),
  }))

  return { client, conversations: forwardConvs, isLoading }
}

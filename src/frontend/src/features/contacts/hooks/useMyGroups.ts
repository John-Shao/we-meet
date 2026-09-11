import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { fetchImToken } from '@/features/im/api/fetchImToken'
import { resolveGroupAvatars } from '@/features/im/api/groupAvatar'
import {
  resolveImUsers,
  type ImUserInfo,
} from '@/features/im/api/resolveImUsers'
import { useConversations } from '@/features/im/hooks/useConversations'
import { useImConnection } from '@/features/im/hooks/useImConnection'

export interface MyGroupsData {
  groups: ConversationSummary[]
  /** 当前用户的 IM uid —— 「未命名群」拼成员名时要把自己排除掉。 */
  selfUid: string
  isLoading: boolean
  /** uid → 名字/头像:群头像九宫格与「未命名群」的名字都取自这一份。 */
  memberInfo: Record<string, ImUserInfo>
  /** cid → 群主设置的自定义头像(presigned URL)。 */
  groupAvatars: Record<string, string>
  /** 所有群的未读数之和 —— 左栏「我的群组」的角标。 */
  unreadTotal: number
}

/**
 * 「我的群组」的唯一数据源,通讯录里三处共用:左栏计数与角标、中栏群清单、
 * 右栏群资料卡。合成一个 hook 的理由是它们必须说同一件事 —— 之前左栏没有数字、
 * 中栏自己拉一份、右栏不存在,同一批群在同一个页面上有三种说法。
 *
 * 零后端:群清单就是 IM 会话列表里 type==='group' 的那部分,queryKey 与消息页
 * 完全一致(useConversations),成员名/群头像也各自复用消息页同款 queryKey ——
 * 所以从 /im 切过来是命中缓存、不重新请求。IM Client 是单例,页面里第一次用会
 * 自动 connect(正常路径下消息页早已连上)。
 */
export const useMyGroups = (): MyGroupsData => {
  const { client } = useImConnection()
  const { data: tokenData } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    staleTime: 60_000,
  })
  const selfUid = tokenData?.uid ?? ''
  const { data: conversations = [], isLoading } = useConversations(
    client,
    selfUid
  )

  const groups = useMemo(
    () => conversations.filter((c) => c.type === 'group'),
    [conversations]
  )

  // 每个群前 9 名成员的名字/头像 —— 与会话列表同一个 queryKey,那边拉过就命中缓存。
  const memberUids = useMemo(
    () => Array.from(new Set(groups.flatMap((c) => c.members.slice(0, 9)))),
    [groups]
  )
  const { data: memberInfo = {} } = useQuery({
    queryKey: ['im', 'group-member-info', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: memberUids.length > 0,
    staleTime: 60_000,
  })

  const groupCids = useMemo(() => groups.map((c) => c.cid), [groups])
  const { data: groupAvatars = {} } = useQuery({
    queryKey: ['im', 'group-avatars', groupCids],
    queryFn: () => resolveGroupAvatars(groupCids),
    enabled: groupCids.length > 0,
    staleTime: 50 * 60 * 1000,
  })

  const unreadTotal = useMemo(
    () => groups.reduce((sum, c) => sum + c.unread_count, 0),
    [groups]
  )

  return { groups, selfUid, isLoading, memberInfo, groupAvatars, unreadTotal }
}

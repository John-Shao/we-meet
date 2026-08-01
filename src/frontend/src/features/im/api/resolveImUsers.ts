import { fetchApi } from '@/api/fetchApi'

export interface ImUserInfo {
  id: string
  full_name: string
  short_name: string
  /** Presigned avatar GET URL; '' when the user has no uploaded avatar. */
  avatar_url?: string
  /**
   * 该成员在本组织已无在职关系(P10 离职流程)。
   *
   * 解析端点刻意**不**把离职者剔掉 —— 那样历史消息里的名字会退回裸 uid,
   * 比「张三(已离职)」糟糕得多。所以人照常解析,由这个 flag 决定怎么标。
   * 老后端不返回该字段,`undefined` 即「没离职」。
   */
  left?: boolean
}

/**
 * POST /api/v1.0/im/users/resolve — map IM uids → we-meet display names.
 *
 * Org-scoped server-side: only uids that belong to a user in the caller's
 * organization come back; unknown uids are simply absent. Used to label direct
 * peers / group members from the conversation summary's `members` (raw uids),
 * so the client never has to carry display identities itself.
 */
export const resolveImUsers = (
  imUids: string[],
): Promise<Record<string, ImUserInfo>> =>
  fetchApi<Record<string, ImUserInfo>>('/im/users/resolve/', {
    method: 'POST',
    body: JSON.stringify({ im_uids: imUids }),
  })

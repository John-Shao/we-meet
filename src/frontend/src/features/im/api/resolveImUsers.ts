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
  /**
   * 该 uid 是群机器人(jusi role='bot')。机器人不是 User,后端在同一个解析
   * 端点里额外查一遍机器人表 —— 于是气泡拿头像/名字/描述副标题不用多发请求。
   * 老后端不返回该字段,`undefined` 即「不是机器人」。
   */
  is_bot?: boolean
  /** 机器人的一行说明,挂在气泡的发送人名字后面。真人不返回。 */
  description?: string
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

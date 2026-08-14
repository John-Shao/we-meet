import { fetchApi } from '@/api/fetchApi'
import { apiUrl } from '@/api/apiUrl'

/**
 * 邀请链接的落地页数据 (P10 M4)。
 *
 * 解析端点**匿名可达** —— 收到链接的人多半还没登录,甚至还没有账号,页面得
 * 先能告诉他是谁在邀请他。所以这个请求刻意不走 fetchApi:那一层会带 Bearer
 * 并在 401 时静默刷新,而这里根本没有 token 可带,让它去跑一遍刷新流程只会
 * 在未登录时白白多一次失败请求。
 *
 * 后端:src/backend/core/api/invite.py
 */

export interface InviteInfo {
  valid: boolean
  organization_name?: string
  department_name?: string
  org_role?: string
  title?: string
  require_approval?: boolean
}

export interface MyJoinRequest {
  id: string
  organization_name: string
  department_name: string
  org_role: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
  reject_reason: string
  created_at: string
  reviewed_at: string | null
}

export const fetchInviteInfo = async (code: string): Promise<InviteInfo> => {
  const response = await fetch(apiUrl(`/invite/${encodeURIComponent(code)}/`), {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    // 包括 429。对访客来说「暂时看不了」和「链接无效」没有区别,而把限流
    // 说破反而是在告诉爆破者他撞到了墙。
    return { valid: false }
  }
  return response.json()
}

/** 申请加入。需要已登录。 */
export const applyToInvite = (code: string): Promise<MyJoinRequest> =>
  fetchApi<MyJoinRequest>(`/invite/${encodeURIComponent(code)}/apply/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const fetchMyJoinRequests = (
  inviteCode?: string
): Promise<MyJoinRequest[]> => {
  const query = inviteCode
    ? `?invite_code=${encodeURIComponent(inviteCode)}`
    : ''
  return fetchApi<MyJoinRequest[]>(`/join-requests/mine/${query}`)
}

export const cancelJoinRequest = (id: string): Promise<MyJoinRequest> =>
  fetchApi<MyJoinRequest>(`/join-requests/${id}/cancel/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

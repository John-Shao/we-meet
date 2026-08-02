import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * 邀请链接与申请队列(M 端,P10 M4)。
 *
 * 与「添加成员」(adminInvitations.ts)的区别在**谁指定了人**:添加是管理员
 * 指名道姓填手机号,邀请是发一份不指向具体人的凭证,谁拿到谁申请。所以这里
 * 有有效期、用量上限和审批,而那边一个都不需要。
 *
 * 后端:src/backend/core/api/admin_invite_links.py
 */

export interface InviteLink {
  id: string
  code: string
  department: { id: string; name: string } | null
  org_role: string
  title: string
  require_approval: boolean
  expires_at: string
  max_uses: number | null
  used_count: number
  is_active: boolean
  is_expired: boolean
  created_by: { id: string; full_name: string | null; short_name: string | null } | null
  created_at: string
}

export interface CreateInviteLinkInput {
  department?: string | null
  org_role?: string
  title?: string
  require_approval?: boolean
  max_uses?: number | null
  expires_in_days?: number
}

export interface JoinRequest {
  id: string
  full_name: string
  phone: string
  department: { id: string; name: string } | null
  org_role: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
  invited_by: { id: string; full_name: string | null; short_name: string | null } | null
  link_code: string
  reviewed_by: { id: string; full_name: string | null; short_name: string | null } | null
  reviewed_at: string | null
  reject_reason: string
  created_at: string
}

/** 有效期上限,与后端 MAX_EXPIRY_DAYS 一致。 */
export const MAX_EXPIRY_DAYS = 30
export const EXPIRY_PRESETS = [1, 3, 7, 14, 30]

export const fetchInviteLinks = (activeOnly = true): Promise<Paginated<InviteLink>> =>
  fetchApi<Paginated<InviteLink>>(
    `/admin/invite-links/${activeOnly ? '?active=1' : ''}`
  )

export const createInviteLink = (input: CreateInviteLinkInput): Promise<InviteLink> =>
  fetchApi<InviteLink>('/admin/invite-links/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const revokeInviteLink = (id: string): Promise<unknown> =>
  fetchApi(`/admin/invite-links/${id}/`, { method: 'DELETE' })

export const fetchJoinRequests = (
  status = 'pending',
  mineOnly = false
): Promise<Paginated<JoinRequest>> => {
  const params = new URLSearchParams({ status })
  if (mineOnly) params.set('mine', '1')
  return fetchApi<Paginated<JoinRequest>>(`/admin/join-requests/?${params}`)
}

export const approveJoinRequest = (
  id: string,
  input: { department?: string | null; org_role?: string } = {}
): Promise<JoinRequest> =>
  fetchApi<JoinRequest>(`/admin/join-requests/${id}/approve/`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const rejectJoinRequest = (id: string, reason: string): Promise<JoinRequest> =>
  fetchApi<JoinRequest>(`/admin/join-requests/${id}/reject/`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })

/** 落地页地址。二维码渲染的就是这个,邀请码是它的末段。 */
export const inviteUrl = (code: string) =>
  `${window.location.origin}/invite/${code}`

/** `BZGZLJZK` → `BZGZ LJZK`:邀请码是要念出来和手抄的。 */
export const formatInviteCode = (code: string) =>
  code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code

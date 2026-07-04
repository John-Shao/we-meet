import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Member governance client for the console (M 端).
 *
 * Reads hit the admin membership list (all lifecycle statuses, unlike the
 * active-only directory); writes hit the `IsOrgAdmin`-guarded endpoints in
 * `core/api/admin_org.py`.
 */
export interface AdminMember {
  /** Membership row id — the PATCH/DELETE handle. */
  id: string
  user_id: string
  sub: string | null
  full_name: string | null
  short_name: string | null
  email: string | null
  avatar_url: string
  title: string
  org_role: string
  is_primary: boolean
  status: string
  department: { id: string; name: string } | null
}

export interface MemberListParams {
  status?: string
  department?: string
  org_role?: string
  q?: string
  page?: number
}

export const fetchAdminMembers = (
  params: MemberListParams,
): Promise<Paginated<AdminMember>> => {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.department) qs.set('department', params.department)
  if (params.org_role) qs.set('org_role', params.org_role)
  if (params.q) qs.set('q', params.q)
  if (params.page) qs.set('page', String(params.page))
  const s = qs.toString()
  return fetchApi<Paginated<AdminMember>>(
    `/admin/memberships/${s ? `?${s}` : ''}`,
  )
}

export interface UpdateMembershipInput {
  department?: string | null
  org_role?: string
  title?: string
  status?: string
  is_primary?: boolean
}

export const updateMembership = (
  id: string,
  input: UpdateMembershipInput,
): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

export const deleteMembership = (id: string): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/`, { method: 'DELETE' })

export const ORG_ROLES = [
  'member',
  'dept_admin',
  'administrator',
  'owner',
] as const

export const MEMBER_STATUSES = [
  'active',
  'invited',
  'suspended',
  'left',
] as const

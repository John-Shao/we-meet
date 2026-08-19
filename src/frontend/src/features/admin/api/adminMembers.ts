import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

/**
 * Member governance client for the console (M 端).
 *
 * Reads hit the admin membership list (all lifecycle statuses, unlike the
 * active-only directory); writes hit the `IsOrgAdmin`-guarded endpoints in
 * `core/api/admin_org.py`.
 */

/** An option from one of the org dictionaries (人员类型 / 职级 / 序列). */
export interface DictRef {
  id: string
  code: string
  label: string
}

/** Lightweight reference to another membership, used by the reporting lines. */
export interface ManagerRef {
  membership_id: string
  user_id: string
  full_name: string
}

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
  // --- work profile (P10 M1) ---
  employee_no: string
  employee_type: DictRef | null
  job_level: DictRef | null
  job_sequence: DictRef | null
  hire_date: string | null
  work_country: string
  work_city: string
  alias: string
  work_station: string
  extension: string
  source: string
  manager: ManagerRef | null
  dotted_manager: ManagerRef | null
  // --- offboarding ---
  left_at: string | null
  left_reason: string
  /** Frozen org facts from the moment they left — the departed list reads this. */
  left_snapshot: {
    department_name?: string
    department_path?: string
    title?: string
    employee_no?: string
    employee_type_label?: string
    manager_name?: string
  }
  /** Computed server-side from `left_at`; null while still employed. */
  left_days: number | null
}

export interface MemberListParams {
  status?: string
  /** Comma-separated statuses to omit, e.g. `left` for the "still here" tab. */
  exclude_status?: string
  department?: string
  include_subtree?: boolean
  org_role?: string
  employee_type?: string
  left_after?: string
  left_before?: string
  ordering?: string
  q?: string
  page?: number
}

export const fetchAdminMembers = (
  params: MemberListParams
): Promise<Paginated<AdminMember>> => {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.exclude_status) qs.set('exclude_status', params.exclude_status)
  if (params.department) qs.set('department', params.department)
  if (params.include_subtree) qs.set('include_subtree', 'true')
  if (params.org_role) qs.set('org_role', params.org_role)
  if (params.employee_type) qs.set('employee_type', params.employee_type)
  if (params.left_after) qs.set('left_after', params.left_after)
  if (params.left_before) qs.set('left_before', params.left_before)
  if (params.ordering) qs.set('ordering', params.ordering)
  if (params.q) qs.set('q', params.q)
  if (params.page) qs.set('page', String(params.page))
  const s = qs.toString()
  return fetchApi<Paginated<AdminMember>>(
    `/admin/memberships/${s ? `?${s}` : ''}`
  )
}

export interface UpdateMembershipInput {
  department?: string | null
  org_role?: string
  title?: string
  status?: string
  is_primary?: boolean
  // --- work profile ---
  employee_no?: string
  employee_type?: string | null
  job_level?: string | null
  job_sequence?: string | null
  manager?: string | null
  dotted_manager?: string | null
  hire_date?: string | null
  work_country?: string
  work_city?: string
  alias?: string
  work_station?: string
  extension?: string
}

export const updateMembership = (
  id: string,
  input: UpdateMembershipInput
): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

export const deleteMembership = (id: string): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/`, { method: 'DELETE' })

// --- lifecycle (P10 M1) ------------------------------------------------------

/** What a departing member would leave behind — shown before confirming. */
export interface OwnedResources {
  headed_departments: { id: string; name: string }[]
  direct_reports_count: number
  owned_rooms: number
  owned_recordings: number
}

export const fetchOwnedResources = (id: string): Promise<OwnedResources> =>
  fetchApi<OwnedResources>(`/admin/memberships/${id}/owned-resources/`)

export interface OffboardInput {
  left_at?: string
  reason?: string
  /** Membership id of the replacement head, when this member heads a department. */
  transfer_head_to?: string | null
  allow_orphan_head?: boolean
  disable_login?: boolean
}

export const offboardMember = (
  id: string,
  input: OffboardInput
): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/offboard/`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const rehireMember = (
  id: string,
  input: { department?: string | null; org_role?: string } = {}
): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/rehire/`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

/** Delete a departed member's row for good (飞书's 清空列表). */
export const purgeMember = (id: string): Promise<unknown> =>
  fetchApi(`/admin/memberships/${id}/purge/`, { method: 'DELETE' })

// --- bulk --------------------------------------------------------------------

/** Members the batch could not touch, with the guard that stopped each one. */
export interface BulkSkip {
  id: string
  label: string
  reason: unknown
}

export const bulkChangeDepartment = (
  ids: string[],
  department: string | null
): Promise<{ moved: number; skipped: BulkSkip[] }> =>
  fetchApi(`/admin/memberships/bulk-department/`, {
    method: 'POST',
    body: JSON.stringify({ ids, department }),
  })

export const bulkOffboard = (
  ids: string[],
  input: { reason?: string; allow_orphan_head?: boolean } = {}
): Promise<{ offboarded: number; skipped: BulkSkip[] }> =>
  fetchApi(`/admin/memberships/bulk-offboard/`, {
    method: 'POST',
    body: JSON.stringify({ ids, ...input }),
  })

/** Server-side cap — mirrored here so the UI can stop the user before the 400. */
export const BULK_LIMIT = 200

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

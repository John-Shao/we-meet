/**
 * DTOs for the directory (通讯录) API.
 *
 * Backend source: src/backend/core/api/directory.py
 *   GET /api/v1.0/directory/members
 *   GET /api/v1.0/directory/departments
 */

export interface DirectoryDepartmentRef {
  id: string
  name: string
}

/** A person card returned by the directory member endpoints. */
export interface DirectoryMember {
  /** we-meet user id — pass as `peer_user_id` to start a direct IM conversation. */
  id: string
  /** Membership row id — admins PATCH /admin/memberships/{membership_id}/ to move depts. */
  membership_id: string
  sub: string | null
  full_name: string | null
  short_name: string | null
  email: string | null
  avatar_url: string
  title: string
  org_role: string
  department: DirectoryDepartmentRef | null
  is_self: boolean
}

export interface DirectoryDepartmentHead {
  id: string
  full_name: string | null
  short_name: string | null
}

/** A department node (flat; build the tree client-side from `parent` / `path`). */
export interface DirectoryDepartment {
  id: string
  name: string
  parent: string | null
  path: string
  depth: number
  head: DirectoryDepartmentHead | null
  sort_order: number
}

export type { Paginated } from '@/api/Paginated'

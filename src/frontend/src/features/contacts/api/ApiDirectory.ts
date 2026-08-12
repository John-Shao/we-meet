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
  /**
   * 调用方是否把这个人设成了星标联系人(每张成员卡片都带,免二次请求)。
   * **只表归类** —— 不影响通知,通知看 `special_alert`。
   */
  is_starred: boolean
  /**
   * 调用方是否对这个人开了「他的消息特别提醒」(消息穿透免打扰时段)。
   * 与 `is_starred` **相互独立**:可以只开一个。
   */
  special_alert: boolean
  /**
   * 该成员是否已离职。列表里永远是 false(列表只出在职的);为 true 的卡片只可能
   * 来自 `GET /directory/members/{id}/` 的墓碑响应——历史消息里点头像深链过来的
   * 那条路径。墓碑卡不带 `phone`/`email`(人走了联系方式不再由组织代为分发)。
   */
  left: boolean
}

export type ExternalContactStatus = 'none' | 'pending' | 'accepted' | 'declined'
export type ExternalContactDirection =
  | 'none'
  | 'incoming'
  | 'outgoing'
  | 'accepted'
  | 'declined'

/** Minimal cross-organization card; department and direct identifiers stay hidden. */
export interface ExternalContact {
  relationship_id: string | null
  id: string
  full_name: string | null
  short_name: string | null
  avatar_url: string
  organization: { id: string; name: string } | null
  status: ExternalContactStatus
  direction: ExternalContactDirection
  requested_at: string | null
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
  /** 客户可编辑的外部对接标识(飞书的「部门ID」),与不可变的 team_key 无关。 */
  code: string
  /** 在职直属成员数,服务端 annotate 而非逐行 count(部门树整棵返回)。 */
  member_count: number
}

export type { Paginated } from '@/api/Paginated'

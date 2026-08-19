import { fetchApi } from '@/api/fetchApi'

/**
 * 用户组 —— 一个可被授权的**主体**,不只是「存下来的一批人」。
 *
 * Backend source: src/backend/core/api/admin_org.py → UserGroupViewSet.
 * Unpaginated on purpose: a company has tens of groups, not thousands.
 */
export interface UserGroup {
  id: string
  name: string
  description: string
  /**
   * 授权行里存的那个不透明 key(`group:<hex>`),与部门的 team_key 同一套语义。
   * 只读且**不可变** —— 历史授权行按原样存着它,改名不能让它失效。
   */
  group_key: string
  source: string
  is_active: boolean
  member_count: number
}

export interface UserGroupMember {
  /** we-meet user id —— 移除成员传这个。 */
  id: string
  full_name: string | null
  short_name: string | null
  email: string | null
  avatar_url: string
  added_at: string
}

export const fetchUserGroups = (query?: string): Promise<UserGroup[]> => {
  const q = query?.trim()
  return fetchApi<UserGroup[]>(
    `/admin/user-groups/${q ? `?q=${encodeURIComponent(q)}` : ''}`
  )
}

export const createUserGroup = (input: {
  name: string
  description?: string
}): Promise<UserGroup> =>
  fetchApi<UserGroup>('/admin/user-groups/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateUserGroup = (
  id: string,
  input: { name?: string; description?: string; is_active?: boolean }
): Promise<UserGroup> =>
  fetchApi<UserGroup>(`/admin/user-groups/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

/** 软删。授权行会留着但不再解析得到任何人。 */
export const deleteUserGroup = (id: string): Promise<unknown> =>
  fetchApi(`/admin/user-groups/${id}/`, { method: 'DELETE' })

export const fetchUserGroupMembers = (id: string): Promise<UserGroupMember[]> =>
  fetchApi<UserGroupMember[]>(`/admin/user-groups/${id}/members/`)

export interface AddMembersResult {
  added: number
  already_member: number
  /** 不是本组织在职成员,服务端拒绝加入 —— 报出来而不是静默丢掉。 */
  skipped: number
}

export const addUserGroupMembers = (
  id: string,
  userIds: string[]
): Promise<AddMembersResult> =>
  fetchApi<AddMembersResult>(`/admin/user-groups/${id}/add-members/`, {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds }),
  })

export const removeUserGroupMember = (
  id: string,
  userId: string
): Promise<unknown> =>
  fetchApi(`/admin/user-groups/${id}/remove-member/`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })

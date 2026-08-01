import { fetchApi } from '@/api/fetchApi'

/**
 * 自定义管理角色与授权。
 *
 * Backend source: src/backend/core/api/admin_roles.py.
 * 全部不分页 —— 角色和持有人都是几十条量级。
 */

export interface PermissionEntry {
  code: string
  label: string
  /** 只用于角色编辑器分组显示,无语义。 */
  group: string
  /**
   * 任何自定义角色都授不到(目前只有 `org.role.write`)。能编辑角色的角色可以
   * 给自己写任何权限 —— 那是标准提权原语,所以它只留给 owner/administrator。
   */
  owner_only: boolean
}

export interface AdminRole {
  id: string
  name: string
  /** 创建后不可改:应用逻辑与内置角色 seed 都按它认人。 */
  code: string
  description: string
  permissions: string[]
  /** 内置角色可改权限集、可停用,但删不掉。 */
  is_builtin: boolean
  is_active: boolean
  assignment_count: number
}

export interface RoleAssignment {
  id: string
  role: string
  role_name: string
  membership: string
  member_name: string
  scope_type: 'all' | 'departments'
  departments: { id: string; name: string }[]
}

export const fetchPermissionCatalogue = (): Promise<PermissionEntry[]> =>
  fetchApi<{ permissions: PermissionEntry[] }>('/admin/permissions/').then(
    (r) => r.permissions,
  )

export const fetchAdminRoles = (): Promise<AdminRole[]> =>
  fetchApi<AdminRole[]>('/admin/roles/')

export const createAdminRole = (input: {
  name: string
  code: string
  description?: string
  permissions: string[]
}): Promise<AdminRole> =>
  fetchApi<AdminRole>('/admin/roles/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateAdminRole = (
  id: string,
  input: {
    name?: string
    description?: string
    permissions?: string[]
    is_active?: boolean
  },
): Promise<AdminRole> =>
  fetchApi<AdminRole>(`/admin/roles/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

export const deleteAdminRole = (id: string): Promise<unknown> =>
  fetchApi(`/admin/roles/${id}/`, { method: 'DELETE' })

/** 补齐本组织缺失的内置角色(hr / it / admin_office)。幂等。 */
export const seedBuiltinRoles = (): Promise<{ created: number }> =>
  fetchApi<{ created: number }>('/admin/roles/seed-builtin/', { method: 'POST' })

export const fetchRoleAssignments = (params?: {
  role?: string
  membership?: string
}): Promise<RoleAssignment[]> => {
  const qs = new URLSearchParams()
  if (params?.role) qs.set('role', params.role)
  if (params?.membership) qs.set('membership', params.membership)
  const s = qs.toString()
  return fetchApi<RoleAssignment[]>(`/admin/role-assignments/${s ? `?${s}` : ''}`)
}

export const createRoleAssignment = (input: {
  role: string
  /** Membership id(不是 user id)—— 上下级/授权都挂在组织关系上。 */
  membership: string
  scope_type: 'all' | 'departments'
  department_ids?: string[]
}): Promise<RoleAssignment> =>
  fetchApi<RoleAssignment>('/admin/role-assignments/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const deleteRoleAssignment = (id: string): Promise<unknown> =>
  fetchApi(`/admin/role-assignments/${id}/`, { method: 'DELETE' })

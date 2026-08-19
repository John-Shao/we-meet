import { fetchApi } from '@/api/fetchApi'

import type { DirectoryDepartment } from './ApiDirectory'

/**
 * Org admin console writes (require org administrator/owner — the backend
 * enforces via IsOrgAdmin; the UI hides these unless the caller's own directory
 * card reports an admin org_role).
 *
 * Backend source: src/backend/core/api/admin_org.py
 */

export interface CreateDepartmentPayload {
  name: string
  parent?: string | null
}

export const createDepartment = (
  payload: CreateDepartmentPayload
): Promise<DirectoryDepartment> =>
  fetchApi<DirectoryDepartment>('/admin/departments/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

/**
 * Move a member between departments (null = organization-level, no department).
 * PATCH /admin/memberships/{id}/ — org admins only (backend enforces).
 */
export const updateMembershipDepartment = (
  membershipId: string,
  departmentId: string | null
): Promise<unknown> =>
  fetchApi(`/admin/memberships/${membershipId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ department: departmentId }),
  })

/**
 * Soft-delete a department. Its members fall back to organization-level
 * ("no department"). DELETE /admin/departments/{id}/ — org admins only.
 * Fails (400) if the department still has sub-departments.
 */
export const deleteDepartment = (departmentId: string): Promise<unknown> =>
  fetchApi(`/admin/departments/${departmentId}/`, { method: 'DELETE' })

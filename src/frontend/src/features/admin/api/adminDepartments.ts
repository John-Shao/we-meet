import { fetchApi } from '@/api/fetchApi'
import type { DirectoryDepartment } from '@/features/contacts/api/ApiDirectory'

/**
 * Department admin client for the management console (M 端).
 *
 * Reads reuse the org-scoped directory tree (`/directory/departments/`); writes
 * hit the `IsOrgAdmin`-guarded admin endpoints (`/admin/departments/`,
 * backend `core/api/admin_org.py`). The shared `DirectoryDepartment` DTO is the
 * canonical department shape.
 */
export type AdminDepartment = DirectoryDepartment

/** The caller org's department tree (flat, ordered by path). */
export const fetchAdminDepartments = (): Promise<AdminDepartment[]> =>
  fetchApi<AdminDepartment[]>('/directory/departments/')

export interface CreateDepartmentInput {
  name: string
  /** Parent department id, or null/undefined for a top-level department. */
  parent?: string | null
}

export const createDepartment = (
  input: CreateDepartmentInput,
): Promise<AdminDepartment> =>
  fetchApi<AdminDepartment>('/admin/departments/', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export interface UpdateDepartmentInput {
  name?: string
  /** we-meet user id of the department head, or null to clear. */
  head?: string | null
  sort_order?: number
}

export const updateDepartment = (
  id: string,
  input: UpdateDepartmentInput,
): Promise<AdminDepartment> =>
  fetchApi<AdminDepartment>(`/admin/departments/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

/**
 * Soft-delete a department. Its members fall back to organization-level unless
 * `reassignToId` is given (then they move there). Backend refuses (400) if the
 * department still has sub-departments.
 */
export const deleteDepartment = (
  id: string,
  reassignToId?: string | null,
): Promise<unknown> => {
  const qs = reassignToId ? `?reassign=${encodeURIComponent(reassignToId)}` : ''
  return fetchApi(`/admin/departments/${id}/${qs}`, { method: 'DELETE' })
}

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
  payload: CreateDepartmentPayload,
): Promise<DirectoryDepartment> =>
  fetchApi<DirectoryDepartment>('/admin/departments/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

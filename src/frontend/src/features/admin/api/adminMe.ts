import { fetchApi } from '@/api/fetchApi'

/**
 * The caller's own membership context, used by the management console (M 端)
 * to gate access and label the current organization.
 *
 * Backend source: src/backend/core/api/directory.py → GET /directory/me/
 */
export interface AdminMe {
  organization: { id: string; name: string } | null
  org_role: string | null
  is_org_admin: boolean
}

export const fetchAdminMe = (): Promise<AdminMe> =>
  fetchApi<AdminMe>('/directory/me/')

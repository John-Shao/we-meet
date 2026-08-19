import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'
import { toApiPath } from './fetchDirectoryMembers'

/**
 * GET /api/v1.0/directory/departments/{id}/members — members of one department,
 * or its whole subtree when `includeSubtree` is set.
 *
 * Returns the full page envelope so callers can follow `next`; a large
 * department would otherwise stop at 100 people with no indication.
 */
export const fetchDepartmentMembersPage = (
  departmentId: string,
  includeSubtree = false,
  pageUrl?: string
): Promise<Paginated<DirectoryMember>> => {
  if (pageUrl) {
    return fetchApi<Paginated<DirectoryMember>>(toApiPath(pageUrl))
  }
  const qs = includeSubtree ? '?include_subtree=true' : ''
  return fetchApi<Paginated<DirectoryMember>>(
    `/directory/departments/${departmentId}/members/${qs}`
  )
}

/** First page only — see `fetchDepartmentMembersPage` for the paging version. */
export const fetchDepartmentMembers = (
  departmentId: string,
  includeSubtree = false
): Promise<DirectoryMember[]> =>
  fetchDepartmentMembersPage(departmentId, includeSubtree).then(
    (page) => page.results
  )

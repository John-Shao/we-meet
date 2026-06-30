import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'

/**
 * GET /api/v1.0/directory/departments/{id}/members — members of one department,
 * or its whole subtree when `includeSubtree` is set. Returns the first page.
 */
export const fetchDepartmentMembers = (
  departmentId: string,
  includeSubtree = false,
): Promise<DirectoryMember[]> => {
  const qs = includeSubtree ? '?include_subtree=true' : ''
  return fetchApi<Paginated<DirectoryMember>>(
    `/directory/departments/${departmentId}/members/${qs}`,
  ).then((page) => page.results)
}

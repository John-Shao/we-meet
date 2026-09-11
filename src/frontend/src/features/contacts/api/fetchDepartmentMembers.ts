import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'
import {
  buildQuery,
  toApiPath,
  type DirectoryListOptions,
} from './fetchDirectoryMembers'

/**
 * GET /api/v1.0/directory/departments/{id}/members — members of one department,
 * or its whole subtree when `includeSubtree` is set.
 *
 * Returns the full page envelope so callers can follow `next`; a large
 * department would otherwise stop at 100 people with no indication.
 *
 * `options` 只作用于第一页:翻页走服务端给的 `next`,那里面已经带着 ordering/department。
 */
export const fetchDepartmentMembersPage = (
  departmentId: string,
  includeSubtree = false,
  pageUrl?: string,
  options: DirectoryListOptions = {}
): Promise<Paginated<DirectoryMember>> => {
  if (pageUrl) {
    return fetchApi<Paginated<DirectoryMember>>(toApiPath(pageUrl))
  }
  const qs = buildQuery([
    ['include_subtree', includeSubtree ? 'true' : null],
    ['ordering', options.pinyin ? 'pinyin' : null],
  ])
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

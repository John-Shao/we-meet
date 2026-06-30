import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'

/**
 * GET /api/v1.0/directory/members — org-scoped member directory (one card per
 * user, via their primary membership). Optional `query` filters on name/email.
 *
 * Returns the first page's results (≤100); the picker doesn't paginate.
 */
export const fetchDirectoryMembers = (
  query?: string,
): Promise<DirectoryMember[]> => {
  const trimmed = query?.trim()
  const qs = trimmed ? `?q=${encodeURIComponent(trimmed)}` : ''
  return fetchApi<Paginated<DirectoryMember>>(
    `/directory/members/${qs}`,
  ).then((page) => page.results)
}

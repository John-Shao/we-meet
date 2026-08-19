import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember, Paginated } from './ApiDirectory'

/**
 * Turn a DRF absolute `next` URL into the path `fetchApi` expects.
 * Falls back to the raw value if it isn't a URL we recognise.
 */
export const toApiPath = (absoluteUrl: string): string => {
  try {
    const url = new URL(absoluteUrl)
    return `${url.pathname.replace(/^\/api\/v1\.0/, '')}${url.search}`
  } catch {
    return absoluteUrl
  }
}

/**
 * GET /api/v1.0/directory/members — org-scoped member directory (one card per
 * user, via their primary membership). Optional `query` filters on name/email.
 *
 * Returns the whole page envelope, not just `results`: callers need `next` to
 * keep paging. Dropping it capped every consumer at the first 100 members —
 * including the pickers behind group creation, starred contacts and calendar
 * invites, where a missing colleague reads as "search is broken" rather than
 * "the list was truncated".
 */
export const fetchDirectoryMembersPage = (
  query?: string,
  pageUrl?: string
): Promise<Paginated<DirectoryMember>> => {
  if (pageUrl) {
    return fetchApi<Paginated<DirectoryMember>>(toApiPath(pageUrl))
  }
  const trimmed = query?.trim()
  const qs = trimmed ? `?q=${encodeURIComponent(trimmed)}` : ''
  return fetchApi<Paginated<DirectoryMember>>(`/directory/members/${qs}`)
}

/**
 * First page only (≤100). Only for callers that genuinely want a bounded
 * preview — anything that must not miss a member pages with
 * `fetchDirectoryMembersPage`.
 */
export const fetchDirectoryMembers = (
  query?: string
): Promise<DirectoryMember[]> =>
  fetchDirectoryMembersPage(query).then((page) => page.results)

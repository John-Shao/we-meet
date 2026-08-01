import { useQuery } from '@tanstack/react-query'

import { fetchApi } from '@/api/fetchApi'

/**
 * The caller's own membership context: which organization they are in, their
 * role, and whether they administer it.
 *
 * Backend source: src/backend/core/api/directory.py → GET /directory/me/
 */
export interface OrgContext {
  organization: { id: string; name: string } | null
  org_role: string | null
  is_org_admin: boolean
}

export const fetchOrgContext = (): Promise<OrgContext> =>
  fetchApi<OrgContext>('/directory/me/')

/**
 * Lives outside `features/admin` on purpose.
 *
 * The C 端 Header needs `is_org_admin` to decide whether to offer the console
 * link, and importing the admin module's hook to get it would pull the whole
 * console into the main bundle — defeating the `lazy(() => import(
 * '@/features/admin'))` split in App.tsx. It was never admin-only data anyway.
 *
 * Shared React Query key, so the Header and the console's guard resolve one
 * request between them.
 */
export const useOrgContext = () =>
  useQuery({
    queryKey: ['org', 'me'],
    queryFn: fetchOrgContext,
    staleTime: 5 * 60_000,
  })

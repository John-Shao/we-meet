import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember } from './ApiDirectory'

/**
 * GET /api/v1.0/directory/members/{userId} — a single org member card by user id
 * (DRF RetrieveModelMixin, lookup_field=user_id). Used to open a member's detail
 * directly, e.g. deep-linked from an IM message avatar (`/contacts?member=<id>`).
 */
export const fetchDirectoryMember = (
  userId: string,
): Promise<DirectoryMember> =>
  fetchApi<DirectoryMember>(
    `/directory/members/${encodeURIComponent(userId)}/`,
  )

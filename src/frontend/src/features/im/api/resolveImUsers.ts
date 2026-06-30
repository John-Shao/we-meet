import { fetchApi } from '@/api/fetchApi'

export interface ImUserInfo {
  id: string
  full_name: string
  short_name: string
  /** Presigned avatar GET URL; '' when the user has no uploaded avatar. */
  avatar_url?: string
}

/**
 * POST /api/v1.0/im/users/resolve — map IM uids → we-meet display names.
 *
 * Org-scoped server-side: only uids that belong to a user in the caller's
 * organization come back; unknown uids are simply absent. Used to label direct
 * peers / group members from the conversation summary's `members` (raw uids),
 * so the client never has to carry display identities itself.
 */
export const resolveImUsers = (
  imUids: string[],
): Promise<Record<string, ImUserInfo>> =>
  fetchApi<Record<string, ImUserInfo>>('/im/users/resolve/', {
    method: 'POST',
    body: JSON.stringify({ im_uids: imUids }),
  })

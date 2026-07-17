import { fetchApi } from '@/api/fetchApi'

export interface RoomUserEntry {
  id: string
  full_name: string
  short_name: string
  /** Presigned GET URL; '' when unset (fall back to the letter avatar). */
  avatar_url: string
}

/**
 * Resolve LiveKit participant identities (= OIDC subs, see backend
 * `utils.generate_token`) to org-scoped directory profiles — the in-call
 * multi-party grid must not trust the token's self-chosen display name
 * (P4 实测问题2: it surfaces stale join-preview names / synthetic emails).
 * Subs that don't resolve are absent from the response.
 */
export const resolveRoomUsers = (
  subs: string[]
): Promise<Record<string, RoomUserEntry>> =>
  fetchApi<Record<string, RoomUserEntry>>('/im/users/resolve-subs/', {
    method: 'POST',
    body: JSON.stringify({ subs }),
  })

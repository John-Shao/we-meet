import { fetchApi } from '@/api/fetchApi'

/**
 * P5 建议参会 — the room's invited-but-maybe-absent people.
 * See docs/extensions/会中拉人P5_建议参会与统一邀请面板设计.md §4.
 *
 * The card carries `sub` (LiveKit identity == OIDC sub) so callers diff the
 * list against the live roster locally — presence subtraction never happens
 * server-side, which is what makes join/leave reflect instantly.
 */
export interface SuggestedParticipant {
  /** we-meet user id — the picker/tracker currency. */
  id: string
  /** OIDC sub == LiveKit participant identity (presence diffing). */
  sub: string
  full_name: string
  short_name: string
  email: string
  avatar_url: string
  title: string
  department: { id: string; name: string } | null
  is_self: boolean
  /** "member" (room member / calendar mirror) | "group" | "manual". */
  source: string
}

export const fetchSuggestedParticipants = async (
  roomIdOrSlug: string
): Promise<SuggestedParticipant[]> => {
  const data = await fetchApi<{ suggestions: SuggestedParticipant[] }>(
    `/rooms/${roomIdOrSlug}/suggested-participants/`
  )
  return data.suggestions
}

/**
 * Fire-and-forget invitee report: ringing must never block on (or break
 * because of) the suggestion bookkeeping, so failures are swallowed.
 */
export const reportSuggestedParticipants = (
  roomIdOrSlug: string,
  userIds: string[],
  source: 'group' | 'manual'
): void => {
  if (userIds.length === 0) return
  void fetchApi(`/rooms/${roomIdOrSlug}/suggested-participants/`, {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds, source }),
  }).catch(() => undefined)
}

import { fetchApi } from '@/api/fetchApi'

import type { ImDirectConversationResponse } from './ApiIm'

/**
 * Calls POST /api/v1.0/im/conversations/direct. The backend resolves the caller's
 * own uid, computes a deterministic cid over the sorted (self_uid, peer_uid) pair,
 * and asks jusi-light-im admin to create-or-get the direct conversation.
 *
 * Idempotent: same (self, peer) pair always returns the same `cid` regardless
 * of who initiates.
 */
export const createDirectConversation = (
  peerUid: string,
): Promise<ImDirectConversationResponse> =>
  fetchApi<ImDirectConversationResponse>('/im/conversations/direct/', {
    method: 'POST',
    body: JSON.stringify({ peer_uid: peerUid }),
  })

/**
 * Contact-picker variant: pass a we-meet user id and let the backend resolve the
 * peer's IM uid server-side (org-scoped). Preferred over {@link createDirectConversation}
 * for UI flows — the client never has to know the raw IM uid.
 */
export const createDirectConversationByUserId = (
  peerUserId: string,
): Promise<ImDirectConversationResponse> =>
  fetchApi<ImDirectConversationResponse>('/im/conversations/direct/', {
    method: 'POST',
    body: JSON.stringify({ peer_user_id: peerUserId }),
  })

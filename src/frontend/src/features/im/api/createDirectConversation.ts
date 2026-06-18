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

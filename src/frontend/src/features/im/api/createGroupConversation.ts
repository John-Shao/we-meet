import { fetchApi } from '@/api/fetchApi'

import type { ImGroupConversationResponse } from './ApiIm'

/**
 * Calls POST /api/v1.0/im/conversations/group. The backend resolves each
 * we-meet user id to its IM uid server-side (org-scoped), adds the caller as
 * owner, generates a fresh group cid, and asks jusi-light-im admin to create
 * the conversation.
 *
 * Unlike direct conversations, groups are NOT deduplicated — every call creates
 * a distinct conversation.
 */
export const createGroupConversation = (
  memberUserIds: string[],
  name: string
): Promise<ImGroupConversationResponse> =>
  fetchApi<ImGroupConversationResponse>('/im/conversations/group/', {
    method: 'POST',
    body: JSON.stringify({ member_user_ids: memberUserIds, name }),
  })

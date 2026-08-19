import { fetchApi } from '@/api/fetchApi'

import type { ImRemoveMemberResponse } from './ApiIm'

/**
 * POST /api/v1.0/im/conversations/remove-member (P9 踢人). Owner-only — the
 * backend verifies the caller is the group owner via jusi's member roster.
 */
export const removeMember = (
  cid: string,
  memberUserId: string
): Promise<ImRemoveMemberResponse> =>
  fetchApi<ImRemoveMemberResponse>('/im/conversations/remove-member/', {
    method: 'POST',
    body: JSON.stringify({ cid, member_user_id: memberUserId }),
  })

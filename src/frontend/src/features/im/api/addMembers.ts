import { fetchApi } from '@/api/fetchApi'

import type { ImAddMembersResponse } from './ApiIm'

/**
 * POST /api/v1.0/im/conversations/add-members (P9 拉人).
 * Adds org members to an existing group; the backend resolves user ids → IM
 * uids, calls jusi admin add-members, and posts a system message. Any current
 * member may add.
 */
export const addMembers = (
  cid: string,
  memberUserIds: string[],
): Promise<ImAddMembersResponse> =>
  fetchApi<ImAddMembersResponse>('/im/conversations/add-members/', {
    method: 'POST',
    body: JSON.stringify({ cid, member_user_ids: memberUserIds }),
  })

import { fetchApi } from '@/api/fetchApi'

import type { ImUpdateMetaResponse } from './ApiIm'

/**
 * POST /api/v1.0/im/conversations/update — update a group's name + description.
 * Owner-only (backend verifies). jusi stores meta wholesale, so we always send
 * the *complete* desired meta: when renaming, pass the current description (and
 * vice-versa) so the unchanged field is preserved. `kind` picks the announced
 * system message.
 */
export const updateGroupMeta = (
  cid: string,
  args: { name: string; description: string; kind: 'rename' | 'description' }
): Promise<ImUpdateMetaResponse> =>
  fetchApi<ImUpdateMetaResponse>('/im/conversations/update/', {
    method: 'POST',
    body: JSON.stringify({ cid, ...args }),
  })

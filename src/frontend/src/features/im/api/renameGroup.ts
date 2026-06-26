import { fetchApi } from '@/api/fetchApi'

import type { ImRenameResponse } from './ApiIm'

/**
 * POST /api/v1.0/im/conversations/rename (P9 改群名). Owner-only — the backend
 * verifies ownership, updates meta.name, and posts a system message.
 */
export const renameGroup = (cid: string, name: string): Promise<ImRenameResponse> =>
  fetchApi<ImRenameResponse>('/im/conversations/rename/', {
    method: 'POST',
    body: JSON.stringify({ cid, name }),
  })

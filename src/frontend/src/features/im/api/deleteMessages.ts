import { fetchApi } from '@/api/fetchApi'

/**
 * POST /api/v1.0/im/messages/delete/ — "delete for me" of the given messages.
 *
 * The endpoint only verifies membership; jusi-light-im has no server-side
 * delete yet, so the actual hiding is client-local (caller persists the mids
 * and filters them out). Deleted messages stay visible to other members.
 */
export const deleteMessages = (
  cid: string,
  mids: string[],
): Promise<{ cid: string; deleted: number }> =>
  fetchApi<{ cid: string; deleted: number }>('/im/messages/delete/', {
    method: 'POST',
    body: JSON.stringify({ cid, mids }),
  })

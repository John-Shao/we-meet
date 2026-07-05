import { fetchApi } from '@/api/fetchApi'

/**
 * POST /api/v1.0/im/messages/delete/ — batch-delete messages from a conversation.
 *
 * Deleted messages are hidden for all conversation members.
 */
export const deleteMessages = (
  cid: string,
  mids: string[],
): Promise<{ cid: string; deleted: number }> =>
  fetchApi<{ cid: string; deleted: number }>('/im/messages/delete/', {
    method: 'POST',
    body: JSON.stringify({ cid, mids }),
  })

import { fetchApi } from '@/api/fetchApi'

/**
 * POST /api/v1.0/im/conversations/announce-leave (P9.1). Posts a
 * "X 退出群聊" system message; call it just before leaving (while still a
 * member). Best-effort — the actual leave goes through the SDK.
 */
export const announceLeave = (cid: string): Promise<{ cid: string }> =>
  fetchApi<{ cid: string }>('/im/conversations/announce-leave/', {
    method: 'POST',
    body: JSON.stringify({ cid }),
  })

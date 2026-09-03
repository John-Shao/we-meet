import { fetchImToken } from './fetchImToken'

/**
 * Soft-hide a direct or group conversation for the caller without leaving it.
 * A later incoming message may resurface the conversation.
 */
export const hideConversation = async (cid: string): Promise<void> => {
  if (!cid) throw new Error('hideConversation: cid required')

  const baseURL = (
    (import.meta.env.VITE_JUSI_IM_BASE_URL as string | undefined) ?? ''
  ).replace(/\/$/, '')
  if (!baseURL) {
    throw new Error('VITE_JUSI_IM_BASE_URL is not configured')
  }

  const { token } = await fetchImToken()
  const response = await fetch(
    `${baseURL}/v1/conversations/${encodeURIComponent(cid)}/hide`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `hideConversation failed (${response.status})${detail ? `: ${detail}` : ''}`
    )
  }
}

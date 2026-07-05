/**
 * POST /api/v1.0/im/messages/delete — batch-delete messages from a conversation.
 *
 * Deleted messages are hidden for all conversation members.
 */
export const deleteMessages = async (
  cid: string,
  mids: string[],
): Promise<{ cid: string; deleted: number }> => {
  const response = await fetch('/api/v1.0/im/messages/delete/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ cid, mids }),
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = await response.json()
      if (data?.detail) message = data.detail
      else if (typeof data === 'string') message = data
    } catch {
      // use status text
    }
    throw new Error(message)
  }

  return response.json()
}

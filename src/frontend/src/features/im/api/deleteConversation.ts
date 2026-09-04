import type { Client } from '@jusi/light-im-sdk'

import { hideConversation } from './hideConversation'

/**
 * Delete a conversation with WeChat-style semantics for the caller: discard
 * all existing history, then hide the row until a future message resurfaces it.
 * Group membership is intentionally unchanged.
 */
export const deleteConversation = async (
  client: Client,
  cid: string
): Promise<void> => {
  await client.clearHistory(cid)
  await hideConversation(cid)
}

import { fetchApi } from '@/api/fetchApi'

export interface DraftReply {
  mid: string
  sender: string
  summary: string
}

export interface LocalDraft {
  cid: string
  text: string
  reply: DraftReply | null
  updated_at: string
}

export type RecentEmoji =
  | { kind: 'unicode'; value: string }
  | { kind: 'custom'; id: string; key: string; name: string }

export interface CustomEmoji {
  id: string
  name: string
  key: string
  url: string
  content_type: string
  width: number
  height: number
  animated: boolean
  sort_order: number
}

const storageKey = (userKey: string) => `im-input-v2:${userKey}`

export const readLocalDrafts = (
  userKey: string
): Record<string, LocalDraft> => {
  if (!userKey) return {}
  try {
    return JSON.parse(localStorage.getItem(storageKey(userKey)) || '{}')
  } catch {
    return {}
  }
}

export const writeLocalDraft = (
  userKey: string,
  cid: string,
  text: string,
  reply: DraftReply | null
) => {
  const all = readLocalDrafts(userKey)
  if (!text && !reply) delete all[cid]
  else all[cid] = { cid, text, reply, updated_at: new Date().toISOString() }
  localStorage.setItem(storageKey(userKey), JSON.stringify(all))
  window.dispatchEvent(new CustomEvent('im-draft-changed', { detail: { cid } }))
}

export const fetchInputPreferences = () =>
  fetchApi<{ recent_emojis: RecentEmoji[] }>('/im/preferences/')

export const saveRecentEmojis = (recent_emojis: RecentEmoji[]) =>
  fetchApi<{ recent_emojis: RecentEmoji[] }>('/im/preferences/', {
    method: 'PATCH',
    body: JSON.stringify({ recent_emojis: recent_emojis.slice(0, 24) }),
  })

export const fetchCustomEmojis = () =>
  fetchApi<CustomEmoji[]>('/im/custom-emojis/')

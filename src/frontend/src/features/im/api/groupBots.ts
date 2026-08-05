import { fetchApi } from '@/api/fetchApi'

import type { ImBot, ImBotAvatarUpload, ImBotSecret } from './ApiIm'

/**
 * 群机器人管理 (`/api/v1.0/im/bots/`).
 *
 * Kept in one file rather than the module's usual one-function-per-file layout
 * because these seven calls are one CRUD surface — splitting them would mean
 * seven files that each import the same DTO and are only ever used together.
 *
 * Everything except `listGroupBots` is owner-only server-side.
 */

export const listGroupBots = (cid: string): Promise<ImBot[]> =>
  fetchApi<ImBot[]>(`/im/bots/?cid=${encodeURIComponent(cid)}`)

export interface CreateBotArgs {
  cid: string
  name: string
  description: string
  avatar_key?: string
  avatar_color_index?: number
}

export const createGroupBot = (args: CreateBotArgs): Promise<ImBot> =>
  fetchApi<ImBot>('/im/bots/', {
    method: 'POST',
    body: JSON.stringify(args),
  })

export interface UpdateBotArgs {
  name?: string
  description?: string
  avatar_key?: string
  avatar_color_index?: number
  sign_verify_enabled?: boolean
  keywords?: string[]
  ip_allowlist?: string[]
  is_active?: boolean
  /** Validated server-side at write time — a bad address 400s here, not later. */
  callback_url?: string
  callback_include_identity?: boolean
}

export const updateGroupBot = (
  botId: string,
  args: UpdateBotArgs
): Promise<ImBot> =>
  fetchApi<ImBot>(`/im/bots/${botId}/`, {
    method: 'PATCH',
    body: JSON.stringify(args),
  })

export const deleteGroupBot = (botId: string): Promise<void> =>
  fetchApi<void>(`/im/bots/${botId}/`, { method: 'DELETE' })

/** Fetched on demand — the list endpoint deliberately ships no secrets. */
export const fetchBotSecret = (botId: string): Promise<ImBotSecret> =>
  fetchApi<ImBotSecret>(`/im/bots/${botId}/secret/`)

/**
 * The **outbound** callback key — a different secret behind a different door.
 *
 * Without it the receiving service cannot verify our `X-WeMeet-Signature` and
 * has to fall back to "the URL is a secret", which is exactly what the
 * signature was there to replace. 404s until a callback URL is configured.
 */
export const fetchBotCallbackSecret = (botId: string): Promise<ImBotSecret> =>
  fetchApi<ImBotSecret>(`/im/bots/${botId}/callback-secret/`)

export const resetBotSecret = (botId: string): Promise<ImBotSecret> =>
  fetchApi<ImBotSecret>(`/im/bots/${botId}/reset-secret/`, { method: 'POST' })

export const resetBotToken = (botId: string): Promise<{ webhook_url: string }> =>
  fetchApi<{ webhook_url: string }>(`/im/bots/${botId}/reset-token/`, {
    method: 'POST',
  })

/**
 * Upload a bot avatar and return the object key to submit with the form.
 *
 * The presigned PUT is a **bare fetch**: adding our Authorization header would
 * invalidate the signature (same exception as `uploadAvatar` / `uploadChatImage`).
 */
export const uploadBotAvatar = async (blob: Blob): Promise<string> => {
  const presigned = await fetchApi<ImBotAvatarUpload>(
    '/im/bots/avatar-upload-url/',
    {
      method: 'POST',
      body: JSON.stringify({ content_type: 'image/png', size: blob.size }),
    }
  )
  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: blob,
    headers: presigned.headers ?? { 'Content-Type': 'image/png' },
  })
  if (!put.ok) throw new Error(`Storage upload failed (${put.status})`)
  return presigned.object_key
}

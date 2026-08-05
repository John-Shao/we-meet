/**
 * DTOs for the we-meet → jusi-light-im bridge endpoint.
 *
 * Backend source: src/backend/core/api/im.py — POST /api/v1.0/im/token
 */
export interface ImTokenResponse {
  uid: string
  token: string
  ws_url: string
  expires_at: number
}

/**
 * Result of POST /api/v1.0/im/conversations/direct — create-or-get 1-on-1 conv.
 */
export interface ImDirectConversationResponse {
  cid: string
  type: 'direct'
  members: string[]
  self_uid: string
}

/**
 * Result of POST /api/v1.0/im/conversations/group — create a group conv.
 */
export interface ImGroupConversationResponse {
  cid: string
  type: 'group'
  owner_uid: string
  members: string[]
  self_uid: string
}

/** Result of POST /api/v1.0/im/conversations/add-members (P9 拉人). */
export interface ImAddMembersResponse {
  cid: string
  added: number
  members: string[]
}

/** Result of POST /api/v1.0/im/conversations/remove-member (P9 踢人). */
export interface ImRemoveMemberResponse {
  cid: string
  removed: number
  members: string[]
}

/** Result of POST /api/v1.0/im/conversations/update (群名 + 群描述). */
export interface ImUpdateMetaResponse {
  cid: string
  name: string
  description: string
}

/**
 * 群机器人 (GET /api/v1.0/im/bots/?cid=…).
 *
 * The credential fields are `null` for anyone who is not the group owner —
 * every member may see *that* a bot posts here, not how to post as it.
 */
export interface ImBot {
  id: string
  cid: string
  kind: 'custom' | 'builtin'
  slug: string
  /** jusi uid — matches a message's sender_uid, which is how a bubble knows. */
  uid: string
  name: string
  description: string
  /** Presigned GET. Always set: the server renders the swatch when unuploaded. */
  avatar_url?: string
  avatar_color_index: number
  is_active: boolean
  disabled_reason: string
  created_at: string
  last_used_at: string | null
  message_count: number
  webhook_url: string | null
  sign_verify_enabled: boolean | null
  keywords: string[] | null
  ip_allowlist: string[] | null
  /**
   * 出站回调 (A3). Owner-only, like every other field above — members get null.
   *
   * `callback_secret` is deliberately absent: it is the key we sign outbound
   * calls with, and it never leaves the server.
   */
  callback_url: string | null
  callback_include_identity: boolean | null
  /** Flips to false on its own after repeated failures; saving the URL re-arms it. */
  callback_enabled: boolean | null
  callback_failure_count: number | null
  /**
   * The **bucket** of the last callback's failure, `''` when the last one was
   * fine. Never the upstream's own words — that would be an SSRF read channel.
   */
  callback_last_error: CallbackFailure | null
}

/** Mirrors `services/bot_callback.FAILURE_BUCKETS`; `''` means "nothing wrong". */
export type CallbackFailure =
  | ''
  | 'timeout'
  | 'refused'
  | 'unreachable'
  | 'blocked'

/** Result of GET /im/bots/{id}/secret/ and POST /im/bots/{id}/reset-secret/. */
export interface ImBotSecret {
  secret: string
}

/** Presigned PUT for a bot avatar (POST /im/bots/avatar-upload-url/). */
export interface ImBotAvatarUpload {
  upload_url: string
  object_key: string
  expires_in: number
  headers?: Record<string, string>
}

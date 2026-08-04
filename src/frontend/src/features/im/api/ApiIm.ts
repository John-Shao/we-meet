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
}

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

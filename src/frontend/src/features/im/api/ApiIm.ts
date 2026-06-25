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

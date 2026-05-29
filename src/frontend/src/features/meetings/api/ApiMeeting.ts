/**
 * Wire types for the Sprint 2.2.c meeting-detail endpoints.
 *
 * Backend:
 *   GET /api/v1.0/rooms/{id}/summary/
 *   GET /api/v1.0/rooms/{id}/action-items/
 *   GET /api/v1.0/rooms/{id}/transcripts/
 */

export type SummaryStatus = 'pending' | 'success' | 'failed'

export interface ApiActionItem {
  id: string
  content: string
  owner_text: string
  due_text: string
  sort_order: number
  is_completed: boolean
  source_transcript_id: string | null
  created_at: string
}

export interface ApiSummary {
  id: string
  content: string
  model_used: string
  transcripts_count: number
  status: SummaryStatus
  error_message: string
  created_at: string
  updated_at: string
  action_items: ApiActionItem[]
}

export interface ApiRecentMeeting {
  id: string
  name: string
  slug: string | null
  summary_updated_at: string | null
  summary_status: SummaryStatus | null
}

export interface ApiTranscript {
  id: string
  speaker_identity: string
  speaker_name: string
  text: string
  language: string
  translations: Record<string, string>
  started_at: string
  ended_at: string | null
}

export interface ApiRoomAccessUser {
  id: string
  full_name: string | null
  short_name: string | null
  email?: string | null
}

export interface ApiRoomAccess {
  id: string
  role: string
  user: ApiRoomAccessUser
}

/**
 * Room detail (GET /api/v1.0/rooms/{id}/). ``accesses`` is only returned by
 * the backend to administrators / the owner, so it is optional here.
 */
export interface ApiRoomDetail {
  id: string
  name: string
  slug: string | null
  created_at: string
  closed_at: string
  owner: string | null
  accesses?: ApiRoomAccess[]
}

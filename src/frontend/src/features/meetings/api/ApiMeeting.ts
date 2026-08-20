/**
 * Wire types for the Sprint 2.2.c meeting-detail endpoints.
 *
 * Backend:
 *   GET /api/v1.0/rooms/{id}/summary/
 *   GET /api/v1.0/rooms/{id}/action-items/
 *   GET /api/v1.0/rooms/{id}/transcripts/
 */

export type SummaryStatus = 'pending' | 'success' | 'failed'
export type ActionItemStatus =
  | 'proposed'
  | 'confirmed'
  | 'completed'
  | 'dismissed'

export interface ApiActionItem {
  id: string
  session_id: string | null
  content: string
  owner_text: string
  due_text: string
  assignee: ApiRoomAccessUser | null
  due_at: string | null
  status: ActionItemStatus
  confirmed_by: ApiRoomAccessUser | null
  confirmed_at: string | null
  completed_at: string | null
  task_id: string | null
  sort_order: number
  is_completed: boolean
  source_transcript_id: string | null
  can_manage: boolean
  can_update_status: boolean
  created_at: string
}

/** 纪要闭环 D1:智能章节(时间窗可空——LLM 未回填合法时间戳时仅展示标题要点)。 */
export interface ApiSummaryChapter {
  id: string
  title: string
  digest: string
  started_at: string | null
  ended_at: string | null
  sort_order: number
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
  /** 纪要闭环 D2:三板块之三(旧后端无此字段,可空兜底)。 */
  chapters?: ApiSummaryChapter[]
  /** 纪要闭环 M2(D3)可编辑:content 永远是 AI 原文,展示用 effective_content。 */
  is_edited?: boolean
  effective_content?: string
  ai_updated_after_edit?: boolean
  edited_by?: ApiRoomAccessUser | null
  edited_at?: string | null
}

export interface ApiRecentMeeting {
  id: string
  name: string
  slug: string | null
  summary_updated_at: string | null
  summary_status: SummaryStatus | null
  /** 我是否是房主 —— 列表含「我只是参会」的会议,删除仅房主可做。 */
  is_owner: boolean
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

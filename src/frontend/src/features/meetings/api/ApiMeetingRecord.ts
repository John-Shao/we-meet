/** Phase 1 read contract. Capture/media controls are not exposed yet. */
export type MeetingRecordSource = 'meeting' | 'audio_recording' | 'upload'

export interface ApiMeetingRecord {
  id: string
  source_type: MeetingRecordSource
  meeting_session_id: string | null
  source_session_id: string | null
  title: string
  origin_at: string
  retention_mode: 'media' | 'text' | 'unknown'
  revision: number
  source_available: boolean
  capabilities: {
    read_summary: boolean
    read_transcript: boolean
    play_media: boolean
    download_media: boolean
    edit: boolean
    manage: boolean
    capture: boolean
  }
}

export interface MeetingRecordPage<T> {
  results: T[]
  next_cursor: string | null
}

export interface MeetingRecordFilters {
  scope?: 'recent' | 'owned' | 'participated' | 'shared'
  source_type?: MeetingRecordSource
  meeting_session_id?: string
  q?: string
  cursor?: string
}

/** A room-only selector can return 409 when the room has been reused. */
export type LegacyMeetingRecordSource =
  | { room_id: string; meeting_session_id?: string; summary_id?: never }
  | { meeting_session_id: string; room_id?: string; summary_id?: never }
  | { summary_id: string; room_id?: never; meeting_session_id?: never }

/** Compatibility rows retain original timestamps; no guessed media offsets. */
export interface ApiRecordTranscript {
  id: string
  session_id: string
  speaker_identity: string
  speaker_name: string
  text: string
  language: string
  started_at: string
  ended_at: string | null
}

export interface ApiRecordSummary {
  id: string
  session_id: string
  status: 'pending' | 'success' | 'failed'
  content: string
  is_edited: boolean
  model_used: string
  updated_at: string
  legacy: true
}

export interface RecordSourceReference {
  segment_id: string
  segment_revision: number
  start_ms: number
  end_ms: number | null
}

export interface RecordSummaryPoint {
  text: string
  source_refs: RecordSourceReference[]
}

export interface ApiRecordSummaryVersion {
  id: string
  stage: 'final'
  coverage_status: 'unverified'
  input_snapshot_id: string
  input_revision: number
  is_current: boolean
  model_used: string
  created_at: string
  content: {
    overview: string
    decisions: RecordSummaryPoint[]
    chapters: RecordSummaryPoint[]
    action_items: (RecordSummaryPoint & {
      owner_text: string
      due_text: string
    })[]
    open_questions: RecordSummaryPoint[]
  }
}

export interface ApiRecordTranscriptVersion {
  id: string
  revision: number
  segments: (RecordSourceReference & {
    text: string
    speaker_name: string
    speaker_identity: string
    language: string
  })[]
}

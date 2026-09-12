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
  source_type?: MeetingRecordSource
  meeting_session_id?: string
  q?: string
  cursor?: string
}

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

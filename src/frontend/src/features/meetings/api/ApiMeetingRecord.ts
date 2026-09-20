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
  /** 列表视图(对齐飞书的表格)需要的两列:所有者显示名与创建/修改时间。 */
  owner?: string | null
  created_at?: string
  updated_at?: string
  is_ongoing?: boolean
  has_summary?: boolean
  /** Exact standalone capture, only exposed to its current owner. */
  capture_id?: string | null
  upload?: {
    can_control?: boolean
    media_type: 'audio' | 'video'
    name: string
    size: number
    status: 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed'
  } | null
  capabilities: {
    batch_correct?: boolean
    read_summary: boolean
    read_transcript: boolean
    play_media: boolean
    download_media: boolean
    edit: boolean
    /**
     * Owner-only rename of an ended standalone recording. The backend has served
     * this since the record-title batch and Android has always consumed it; the
     * field was simply absent from the Web contract, so Web could not offer it.
     */
    rename: boolean
    manage: boolean
    capture: boolean
    generate_summary: boolean
  }
}

/** Rename is guarded by the title the caller last saw: 409 means it changed. */
export interface RecordTitlePayload {
  title: string
  expected_title: string
}

export interface MeetingRecordPage<T> {
  supported_filters?: string[]
  results: T[]
  next_cursor: string | null
}

export interface MeetingRecordFilters {
  created_from?: string
  created_before?: string
  ordering?: 'created_at' | '-created_at'
  scope?: 'recent' | 'owned' | 'participated' | 'shared'
  source_type?: MeetingRecordSource | 'recordings'
  meeting_session_id?: string
  room_id?: string
  q?: string
  cursor?: string
  is_ongoing?: 'true' | 'false'
  has_summary?: 'true' | 'false'
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
  /** Stable token to echo back as the `speaker` filter; never a display name. */
  identity?: string
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

export type SummaryStage = 'realtime' | 'quick' | 'final'

export interface ApiRecordSummaryVersion {
  id: string
  stage: SummaryStage
  source_observed_at?: string
  source_segment_count?: number
  source_through_ms?: number
  coverage_status: 'unverified'
  /** Delivery of emitted text; does not prove complete audio recognition. */
  delivery_status: 'complete' | 'incomplete' | 'unverified' | 'open'
  /** Provider task closure for observed input only; never full audio coverage. */
  asr_status?:
    | 'finished'
    | 'incomplete'
    | 'unverified'
    | 'no_audio_observed'
    | 'in_progress'
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
  delivery: {
    status?: 'complete' | 'incomplete' | 'unverified'
    streams?: {
      id: string
      state: 'open' | 'complete' | 'incomplete'
      final_sequence: number | null
      received: number
      valid: boolean
    }[]
  }
  segments: (RecordSourceReference & {
    text: string
    speaker_name: string
    speaker_identity: string
    language: string
  })[]
}

/**
 * One speaker of an original-text read.
 *
 * `id` is what the `speaker` filter expects. For a capture-backed record it is
 * a `MeetingSpeaker` UUID; for an online meeting it is the LiveKit identity,
 * because that is how the two sources identify a speaker. A display name is
 * never safe as a filter token — two participants can share one.
 */
export interface ApiRecordSpeaker {
  id: string
  label: string
  /** `diarized` / `unknown` for captures, `online` for meeting identities. */
  identity_type: 'diarized' | 'unknown' | 'online'
  /** Present for capture-backed speakers; accepted as a filter alias. */
  source_key?: string
  /** Present for online speakers: how many rows this person contributed. */
  rows?: number
  /**
   * What a reader should see, already resolved by the server: the person a
   * human bound this track to, else the recogniser's own label.
   */
  display_name?: string
  /** The bound person, or null while the track is still only "Speaker 1". */
  attributed_user_id?: string | null
  attributed_at?: string | null
  /**
   * Whether this reader may change the binding. Only capture-backed records
   * have tracks to bind, and only an editor may do it, so the control is
   * absent rather than disabled when this is false.
   */
  can_attribute?: boolean
}

/** One person the reader may bind a speaker track to. */
export interface ApiAttributionCandidate {
  id: string
  name: string
}

export interface ApiSummaryJob {
  id: string
  stage?: SummaryStage
  chunk_progress?: { completed: number; total: number } | null
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled'
  attempt: number
  generation: number
  input_revision: number
  retryable: boolean
  error_code: string
  updated_at: string
  dispatch_pending: boolean
}

export interface SummaryRequestPayload {
  operation: 'generate' | 'regenerate' | 'retry'
  stage?: SummaryStage
  expected_revision: number
  expected_job_id: string | null
  expected_attempt: number | null
}

export interface ApiSummaryRequest {
  request_id: string
  replayed: boolean
  dispatch_state: 'pending' | 'sent' | 'abandoned'
  job: ApiSummaryJob
}

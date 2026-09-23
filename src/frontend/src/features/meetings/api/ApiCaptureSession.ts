/** Opt-in standalone capture protocol; storage receipts do not imply ASR completion. */
export type CaptureCommand =
  | 'start'
  | 'pause'
  | 'resume'
  | 'interrupt'
  | 'stop'
  | 'finalize'

export interface ApiCaptureSession {
  id: string
  record_id: string
  device_id: string
  status:
    | 'preparing'
    | 'recording'
    | 'paused'
    | 'interrupted'
    | 'stopping'
    | 'stopped'
  revision: number
  started_at: string
  ended_at: string | null
  media_status: 'not_connected' | 'uploading' | 'saved' | 'incomplete' | 'empty'
  captured_duration_ms: number | null
  /** Audio acknowledgement only; text receipts must not advance this value. */
  last_acked_sequence: number
  missing_ranges: Array<{ start_ms: number; end_ms: number }> | null
  missing_sequences?: number[] | null
  coverage_status: 'unverified'
  audio_retention?: CaptureAudioRetention
}

export interface CaptureAudioRetention {
  mode: 'media' | 'text'
  temporary_until: string | null
  retry_until: string | null
  expired: boolean
  cleanup_status: 'not_started' | 'pending' | 'failed' | 'complete'
  cleanup_error: string
  deleted_at: string | null
}

/** POST /capture-sessions/ with a stable UUID Idempotency-Key header. */
export interface CreateCaptureRequest {
  device_id: string
  /** Random UUID v4. Retain securely for recovery; never include in URLs/logs. */
  lease_key: string
  title?: string
  /** Retention preference, not evidence that audio is already stored. */
  retention_mode: 'media' | 'text'
}

/** POST /capture-sessions/{id}/commands/; also requires X-Capture-Lease. */
export interface CaptureCommandRequest {
  command: CaptureCommand
  device_id: string
  expected_revision: number
}

export interface CaptureOperationResponse {
  operation_id: string
  replayed: boolean
  /** Historical operation result; on replay this can be older than capture. */
  result: ApiCaptureSession
  capture: ApiCaptureSession
}

/** Recovery is scoped to one source_track_id; gaps are never implicit ACKs. */
export interface CaptureTranscriptReceipts {
  results: Array<{
    id: string
    ingest_id: string
    source_sequence: number
  }>
  next_after_sequence: number | null
  coverage_status: 'unverified'
}

export interface ApiSpeakerTimeline {
  basis: 'recognized_extent'
  status: 'available' | 'partial' | 'unavailable'
  reason: 'multiple_clocks' | 'interval_limit' | null
  extent_ms: number | null
  intervals: { start_ms: number; end_ms: number }[]
}

export interface ApiMeetingSpeaker {
  id: string
  label: string
  identity_type: 'diarized' | 'unknown'
  activity?: {
    basis: 'recognized_speaker_time'
    status: 'available' | 'partial' | 'unavailable'
    duration_ms: number | null
    share_percent: number | null
    timeline?: ApiSpeakerTimeline
  }
}

/** /meeting-records/{id}/original-segments/, separately authorized from summaries. */
export interface ApiMeetingOriginalSegment {
  playback_alignment?: import('../wordAlignment').PlaybackAlignment
  correction_revision?: number
  can_correct?: boolean
  id: string
  revision: 1
  capture_session_id: string
  source_track_id: string
  source_sequence: number
  start_ms: number
  end_ms: number | null
  speaker_id: string
  speaker_label: string
  /** The reader's text: the newest correction, else what the recogniser said. */
  text: string
  /** The recogniser's own words, so a correction never looks original. */
  original_text?: string
  is_corrected?: boolean
  language: string
}

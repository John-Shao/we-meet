/** Opt-in backend protocol. Microphone, upload and ASR adapters are not connected. */
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
  media_status: 'not_connected'
  captured_duration_ms: null
  /** Audio acknowledgement only; text receipts must not advance this value. */
  last_acked_sequence: number
  missing_ranges: null
  coverage_status: 'unverified'
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

export interface ApiMeetingSpeaker {
  id: string
  label: string
  identity_type: 'diarized' | 'unknown'
}

/** /meeting-records/{id}/original-segments/, separately authorized from summaries. */
export interface ApiMeetingOriginalSegment {
  id: string
  revision: 1
  capture_session_id: string
  source_track_id: string
  source_sequence: number
  start_ms: number
  end_ms: number | null
  speaker_id: string
  speaker_label: string
  text: string
  language: string
}

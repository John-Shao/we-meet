import type { DiarizationJob, DiarizationState } from './diarization'
export const OWNER = '11111111-1111-4111-8111-111111111111'
export const CAPTURE = '22222222-2222-4222-8222-222222222222'
export const ASR = '33333333-3333-4333-8333-333333333333'
export const JOB = '44444444-4444-4444-8444-444444444444'
export const KEY = '55555555-5555-4555-8555-555555555555'
export const job = (): DiarizationJob => ({
  id: JOB,
  generation: 1,
  status: 'queued',
  source_transcription_id: ASR,
  source_revision: 1,
  published_count: 0,
})
export const state = (): DiarizationState => ({
  available: true,
  can_start: true,
  record_revision: 1,
  source_transcription_id: ASR,
  active_job_id: null,
  results: [],
})

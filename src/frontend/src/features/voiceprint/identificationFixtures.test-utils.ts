import type {
  IdentityOptions,
  IdentityResponse,
  IdentitySubmission,
} from './identificationApi'

export const OWNER = '11111111-1111-4111-8111-111111111111'
export const RECORD = '22222222-2222-4222-8222-222222222222'
export const SPEAKER = '33333333-3333-4333-8333-333333333333'
export const ORG = '44444444-4444-4444-8444-444444444444'
export const KEY = '55555555-5555-4555-8555-555555555555'
export const JOB = '66666666-6666-4666-8666-666666666666'
export const SUGGESTION = '77777777-7777-4777-8777-777777777777'
export const options = (): IdentityOptions => ({
  record_revision: 1,
  required_organization_id: null,
  personal_allowed: true,
  targets: [{ id: SPEAKER, name: 'Speaker 0' }],
  scopes: {
    results: [{ id: ORG, name: 'Example organization', enabled: true }],
    next_offset: null,
  },
})
export const response = (processing = false): IdentityResponse => ({
  record_revision: 1,
  request: {
    id: ORG,
    request_key: KEY,
    organization_id: null,
    source_revision: 1,
    created_at: '2026-10-10T00:00:00Z',
    processing,
    jobs: [
      {
        id: JOB,
        speaker_id: SPEAKER,
        status: processing ? 'queued' : 'succeeded',
        retryable: false,
        suggestion: processing
          ? null
          : {
              id: SUGGESTION,
              state: 'pending',
              result: 'suggested',
              reason: 'all_clips_agree',
              clip_count: 3,
              speech_ms: 10000,
              query_intervals: [
                { start_ms: 100, end_ms: 4000 },
                { start_ms: 10100, end_ms: 14000 },
                { start_ms: 20100, end_ms: 24000 },
              ],
              can_confirm: true,
              verification_unavailable: false,
              candidate: { id: OWNER, name: 'Ada' },
            },
      },
    ],
  },
})
export const submission = (): IdentitySubmission => ({
  request_key: KEY,
  expected_revision: 1,
  organization_id: null,
  user_ids: [OWNER],
  speaker_ids: [SPEAKER],
})

import type { Enrollment, Sample, Settings } from './api'

export const OWNER = '11111111-1111-4111-8111-111111111111'
export const ORG = '22222222-2222-4222-8222-222222222222'
export const PROFILE = '33333333-3333-4333-8333-333333333333'
export const ENROLLMENT = '44444444-4444-4444-8444-444444444444'
export const SAMPLE = '55555555-5555-4555-8555-555555555555'
export const KEY = '66666666-6666-4666-8666-666666666666'
export const expiry = () => new Date(Date.now() + 600000).toISOString()
export const settings = (patch: Partial<Settings> = {}): Settings => ({
  organization_id: null,
  available: true,
  version: 1,
  generation: 1,
  allow_enrollment: true,
  allow_accumulation: false,
  allow_identification: false,
  profiles: [
    {
      id: PROFILE,
      status: 'pending',
      generation: 1,
      confirmed_at: null,
      last_updated_at: null,
    },
  ],
  ...patch,
})
export const enrollment = (patch: Partial<Enrollment> = {}): Enrollment => ({
  id: ENROLLMENT,
  organization_id: null,
  profile_id: PROFILE,
  status: 'open',
  expires_at: expiry(),
  consent_version: 1,
  generation: 1,
  challenges: Array.from({ length: 6 }, (_, i) => `Read prompt ${i + 1}`),
  max_clips: 6,
  uploaded_slots: [],
  sample_rate: 24000,
  channels: 1,
  format: 'pcm16_wav',
  clip_duration_ms: { minimum: 3000, maximum: 10000 },
  upload_token: 'x'.repeat(43),
  ...patch,
})
export const sample = (patch: Partial<Sample> = {}): Sample => ({
  id: SAMPLE,
  profile_id: PROFILE,
  status: 'quality_pending',
  source_type: 'enrollment',
  duration_ms: 8000,
  expires_at: expiry(),
  confirmable: false,
  audio_available: true,
  ...patch,
})

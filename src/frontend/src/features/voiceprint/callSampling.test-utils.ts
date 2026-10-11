import { type SamplingConnection } from './callSamplingApi'
import { OWNER, ORG } from './fixtures.test-utils'

export { OWNER, ORG }
export const SESSION = '77777777-7777-4777-8777-777777777777'
export const ROOM = 'RM_synthetic'
export const PARTICIPANT = 'PA_synthetic'
export function connection(): SamplingConnection {
  return {
    room_sid: ROOM,
    organization_id: null,
    organization_name: null,
    observed_at: new Date().toISOString(),
    limits: {
      clip_ms: 10000,
      session_ms: 60000,
      daily_ms: 120000,
      candidate_retention_seconds: 86400,
    },
    permission: {
      available: true,
      version: 3,
      allow_enrollment: true,
      allow_accumulation: true,
    },
    control: {
      session_id: SESSION,
      participant_sid: PARTICIPANT,
      revision: 0,
      paused: true,
      shared_microphone: true,
      device_group: '',
      state: 'paused',
      stop_reason: '',
      runtime: { state: 'stopped', reason: 'paused', updated_at: null },
    },
  }
}
export function activeConnection(): SamplingConnection {
  const value = connection()
  value.control = {
    ...value.control,
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
    state: 'ready',
    runtime: {
      state: 'sampling',
      reason: '',
      updated_at: value.observed_at,
      remaining_ms: { session_ms: 60000, daily_ms: 120000 },
    },
  }
  return value
}

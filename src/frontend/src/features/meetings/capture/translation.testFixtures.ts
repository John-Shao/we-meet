import type {
  CaptureTranslationRun,
  CaptureTranslationSource,
  CaptureTranslationPayload,
  CaptureTranslationState,
  CaptureTranslationTicket,
} from './translationProtocol'

export const source: CaptureTranslationSource = {
  viewerId: '11111111-1111-4111-8111-111111111111',
  captureId: '22222222-2222-4222-8222-222222222222',
  recordId: '33333333-3333-4333-8333-333333333333',
  deviceId: 'web',
  leaseKey: '44444444-4444-4444-8444-444444444444',
}
export const run = (): CaptureTranslationRun => ({
  id: '55555555-5555-4555-8555-555555555555',
  capture_id: source.captureId,
  generation: 1,
  source_revision: 2,
  configuration: {
    source_language: 'zh',
    target_language: 'en',
    mode: 'simultaneous',
    audio: false,
    save_translations: false,
    model: 'qwen3.8-livetranslate-flash-realtime',
    region: 'cn-beijing',
  },
  status: 'starting',
  deadline: new Date(Date.now() + 30000).toISOString(),
  ended_at: null,
  error_code: '',
})
export const state = (
  current: CaptureTranslationRun | null = run()
): CaptureTranslationState => ({
  source: {
    capture_id: source.captureId,
    record_id: source.recordId,
    revision: 2,
    status: 'recording',
  },
  available: true,
  can_start: !current || ['incomplete', 'stopped'].includes(current.status),
  can_stop: !!current && ['starting', 'translating'].includes(current.status),
  can_save_translations: true,
  current,
})
export const payload = (): CaptureTranslationPayload => ({
  device_id: 'web',
  operation: 'start',
  expected_revision: 2,
  expected_run_id: null,
  configuration: {
    source_language: 'zh',
    target_language: 'en',
    mode: 'simultaneous',
    audio: false,
    save_translations: false,
  },
})
export const ticket = (current = run()): CaptureTranslationTicket => ({
  ticket: 'isolated-signed-ticket',
  gateway_url: 'wss://gateway.invalid/capture-translation',
  expires_at: current.deadline,
  source: {
    run_id: current.id,
    capture_id: source.captureId,
    user_id: source.viewerId,
    device_id: 'web',
    generation: current.generation,
    source_revision: current.source_revision,
  },
})

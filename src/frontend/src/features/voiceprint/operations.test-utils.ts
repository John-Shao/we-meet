import { operationOutcomes, operationQueues } from './operations'

export function operationFixture() {
  return {
    schema_version: 1,
    window_hours: 24,
    observed_at: '2026-10-11T08:00:00Z',
    available: false,
    queues: Object.fromEntries(
      operationQueues.map((name) => [
        name,
        {
          states: { queued: 2, running: 1, failed: 4 },
          completed_in_window: 5,
          oldest_pending_seconds: 12,
          request_to_finish_p95_seconds: null,
        },
      ])
    ),
    contribution_cleanup: { queued: 2, purged: 3 },
    profiles: { paused: 6 },
    samples_in_window: { declared_quality_speech_ms: 30000 },
    suggestions_in_window: {
      human_rejected_suggestions: 7,
      results: Object.fromEntries(operationOutcomes.map((name) => [name, 1])),
    },
  }
}

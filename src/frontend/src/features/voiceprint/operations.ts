export const operationQueues = [
  'encoding',
  'quality',
  'identification',
  'deletion',
] as const
export type OperationQueue = (typeof operationQueues)[number]
export const operationOutcomes = [
  'unknown',
  'ambiguous',
  'insufficient_audio',
  'mixed_speaker',
  'unavailable',
] as const
export type OperationSummary = {
  observedAt: string
  available: boolean
  queues: Record<
    OperationQueue,
    {
      pending: number
      failed: number
      completed: number
      oldest: number | null
      p95: number | null
    }
  >
  cleanupPending: number
  pausedProfiles: number
  speechSeconds: number
  rejectedSuggestions: number
  outcomes: Record<(typeof operationOutcomes)[number], number>
}

const invalid = () => new Error('voiceprint_response_invalid')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid()
  return value as Record<string, unknown>
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw invalid()
  return value
}
function seconds(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw invalid()
  return value
}

/** Keep only validated numeric aggregates; never retain arbitrary response fields. */
export function parseOperations(value: unknown): OperationSummary {
  const data = object(value)
  if (
    data.schema_version !== 1 ||
    data.window_hours !== 24 ||
    typeof data.observed_at !== 'string' ||
    !Number.isFinite(Date.parse(data.observed_at)) ||
    typeof data.available !== 'boolean'
  )
    throw invalid()
  const queues = object(data.queues)
  const parsed = {} as OperationSummary['queues']
  for (const name of operationQueues) {
    const row = object(queues[name])
    const states = object(row.states)
    const queued = count(states.queued)
    const running = count(states.running)
    parsed[name] = {
      pending: count(queued + running),
      failed: count(states.failed),
      completed: count(row.completed_in_window),
      oldest: seconds(row.oldest_pending_seconds),
      p95: seconds(row.request_to_finish_p95_seconds),
    }
  }
  const cleanup = object(data.contribution_cleanup)
  const samples = object(data.samples_in_window)
  const suggestions = object(data.suggestions_in_window)
  return {
    observedAt: data.observed_at,
    available: data.available,
    queues: parsed,
    cleanupPending: count(count(cleanup.queued) + count(cleanup.purged)),
    pausedProfiles: count(object(data.profiles).paused),
    speechSeconds: count(samples.declared_quality_speech_ms) / 1000,
    rejectedSuggestions: count(suggestions.human_rejected_suggestions),
    outcomes: Object.fromEntries(
      operationOutcomes.map((name) => [
        name,
        count(object(suggestions.results)[name]),
      ])
    ) as OperationSummary['outcomes'],
  }
}

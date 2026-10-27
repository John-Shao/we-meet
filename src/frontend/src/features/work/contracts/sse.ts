/** E6 SSE contract: Last-Event-ID replay, heartbeat and 409 resync. */

export interface WorkEvent<T = Record<string, unknown>> {
  event_id: string
  task_id: string
  seq: number
  schema_version: 'work-event-v1'
  occurred_at: string
  type: string
  payload: T
}

export interface SseOptions {
  lastEventId?: string | null
  onEvent: (event: WorkEvent) => void
  onResyncRequired: () => void
  signal?: AbortSignal
}

export interface SseConnection {
  close(): void
}

/** 409 resync_required means the client must refetch the Task snapshot. */
export function isResyncRequired(status: number, code: string): boolean {
  return status === 409 && code === 'resync_required'
}

export function parseEventFrame(frame: string): WorkEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return data ? (JSON.parse(data) as WorkEvent) : null
}

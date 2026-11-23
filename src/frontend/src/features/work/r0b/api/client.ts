import { WorkApiError } from '../../r0a/api/client'
import type { RunReconciliations } from './types'

// The R0a contract client has no operation for this v2 face, so the call is hand-owned
// like the history hand-back beside it. The response is work.list_run_reconciliations'
// closed document (0021:551); nothing here re-derives its fields.
const parseError = async (response: Response): Promise<WorkApiError> => {
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === 'object') {
      body = parsed as Record<string, unknown>
    }
  } catch {
    // A non-JSON error body still carries the status; WorkApiError falls back to service_degraded.
  }
  return new WorkApiError(response.status, body)
}

export const fetchWorkRunReconciliations = async (
  runId: string
): Promise<RunReconciliations> => {
  const response = await fetch(
    `/work/v2/runs/${encodeURIComponent(runId)}/reconciliations`,
    {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }
  )
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as RunReconciliations
}
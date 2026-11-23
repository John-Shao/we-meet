import { WorkApiError, getWorkCSRFToken } from '../../r0a/api/client'
import type { RunReconciliations } from './types'
import type { WorkLocalPolicy, WorkLocalPolicyWrite } from './types'

// The R0a contract client has no operation for these v2 faces, so the calls are hand-owned
// like the history hand-back beside them. The responses are the SQL functions' closed
// documents (0021:551, 0020:420-449); nothing here re-derives their fields.
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

export const fetchWorkLocalPolicy = async (): Promise<WorkLocalPolicy> => {
  const response = await fetch('/work/v2/admin/local-policy', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as WorkLocalPolicy
}

/**
 * §1.4's PATCH /admin/local-policy (0020:217-355). The server records client_request_id in
 * the audit row but keeps no replay receipt - a resend with the same expected revision is
 * refused as governance_revision_conflict - so each call mints its own id and is not retried
 * beyond the stale-CSRF recovery every mutation transport has.
 */
export const setWorkLocalPolicy = async (
  body: WorkLocalPolicyWrite
): Promise<WorkLocalPolicy> => {
  const send = (token: string) =>
    fetch('/work/v2/admin/local-policy', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(body),
    })

  let response = await send(await getWorkCSRFToken())
  let failure: WorkApiError | null = null
  if (response.status === 403) {
    const refused = await parseError(response)
    if (refused.code === 'csrf_invalid') {
      // The server refuses a stale token before any side effect, so one refresh cannot
      // double-write; bootstrap is a GET and cannot recurse into this path.
      response = await send(await getWorkCSRFToken(true))
      if (!response.ok) failure = await parseError(response)
    } else {
      failure = refused
    }
  } else if (!response.ok) {
    failure = await parseError(response)
  }
  if (failure) throw failure
  return (await response.json()) as WorkLocalPolicy
}

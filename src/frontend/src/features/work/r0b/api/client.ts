import { WorkApiError, getWorkCSRFToken } from '../../r0a/api/client'
import type {
  RunReconciliations,
  WorkLocalPolicy,
  WorkLocalPolicyWrite,
  WorkReadonlyGrantList,
  WorkReadonlyGrantRevoke,
  WorkReadonlyGrantRevoked,
} from './types'

// The R0a contract client has no operation for these v2 faces, so the calls are hand-owned
// like the history hand-back beside them. The responses are the SQL functions' closed
// documents (0021:551, 0020:420-449, 0042:2583-2619); nothing here re-derives their fields.
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

/**
 * Every hand-owned mutation below is a double-submit write (csrf.go:16-17). The generated
 * R0a transport retries once after csrf_invalid because the server refuses a stale token
 * before any side effect; bootstrap is a GET, so the refresh cannot recurse. Any other 403
 * is a real refusal and is thrown as-is.
 */
const sendMutation = async (
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown
): Promise<unknown> => {
  const send = (token: string) =>
    fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(body),
    })

  let response = await send(await getWorkCSRFToken())
  if (response.status === 403) {
    const refused = await parseError(response)
    if (refused.code !== 'csrf_invalid') throw refused
    response = await send(await getWorkCSRFToken(true))
  }
  if (!response.ok) throw await parseError(response)
  return await response.json()
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
 * refused as governance_revision_conflict - so each call mints its own id.
 */
export const setWorkLocalPolicy = async (
  body: WorkLocalPolicyWrite
): Promise<WorkLocalPolicy> =>
  (await sendMutation(
    '/work/v2/admin/local-policy',
    'PATCH',
    body
  )) as WorkLocalPolicy

/**
 * §1.4 row 70: the owner's own run-scoped readonly grants (0042:2583-2619). Expired and
 * revoked rows stay in the answer on purpose; omitting the run id lists every grant the
 * caller owns across runs.
 */
export const fetchWorkReadonlyGrants = async (
  runId?: string
): Promise<WorkReadonlyGrantList> => {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : ''
  const response = await fetch(`/work/v2/readonly-grants${query}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as WorkReadonlyGrantList
}

/**
 * 0042:2518-2580. expected_revision is the CAS anchor and the request id lands in the
 * receipt index, so a lost response may be retried with the same id and answers
 * replayed=true. A stale revision or a non-active row is refused as
 * idempotency_key_conflict / invalid_transition rather than silently revoking.
 */
export const revokeWorkReadonlyGrant = async (
  grantId: string,
  body: WorkReadonlyGrantRevoke
): Promise<WorkReadonlyGrantRevoked> =>
  (await sendMutation(
    `/work/v2/readonly-grants/${encodeURIComponent(grantId)}/revoke`,
    'POST',
    body
  )) as WorkReadonlyGrantRevoked

import { WorkApiError, getWorkCSRFToken } from '../../r0a/api/client'
import type { WorkClient } from './generated/r0b-client.mjs'
import {
  WorkApiError as ContractApiError,
  createWorkClient,
} from './generated/r0b-client.mjs'
import type {
  RunReconciliations,
  WorkLocalPolicy,
  WorkLocalPolicyWrite,
  WorkReadonlyGrantList,
  WorkReadonlyGrantRevoke,
  WorkReadonlyGrantRevoked,
} from './types'

/**
 * The call layer is generated from work-r0b-browser-openapi.yaml (the four browser
 * consumers of the /work/v2 surface). Paths, methods, parameters, CSRF requirements and
 * success statuses all come from the contract, and `npm run check:work-r0b-api` (wired
 * into `npm test`) fails if the committed artifacts drift. This file keeps only the
 * app-facing surface: export names, the app's WorkApiError, and the cookie/CSRF config.
 *
 * The generated client owns the refresh-and-retry after csrf_invalid: the server refuses
 * a stale token before any side effect, so one refresh cannot double-write.
 */
const api = (): WorkClient =>
  createWorkClient({
    // Resolved per call so a test that stubs the global after import still drives the
    // real path, and so this module never captures a stale reference.
    fetchImpl: (input, init) => fetch(input, init),
    getCsrfToken: () => getWorkCSRFToken(),
    refreshCsrfToken: () => getWorkCSRFToken(true),
  })

const envelopeOf = (error: unknown): Record<string, unknown> => {
  const data =
    error instanceof ContractApiError
      ? error.data
      : (error as Record<string, unknown>)
  return (data ?? {}) as Record<string, unknown>
}

/** Unwraps a generated response and rethrows refusals as the app's own error shape. */
const unwrap = async <T>(pending: Promise<{ data: unknown }>): Promise<T> => {
  try {
    const response = await pending
    return response.data as T
  } catch (error) {
    if (error instanceof ContractApiError) {
      throw new WorkApiError(error.status, envelopeOf(error))
    }
    throw error
  }
}

export const fetchWorkRunReconciliations = (runId: string) =>
  unwrap<RunReconciliations>(api().getRunReconciliations({ path: { runId } }))

/**
 * device-design §3.3's display fact. The response is the function's two keys; the run's
 * own `state` is deliberately not touched here — control-design §4.2 forbids inventing a
 * run state for a hand-back.
 */
export const fetchWorkRunHistoryHandback = async (
  runId: string
): Promise<boolean> => {
  const document = await unwrap<{ history_handback?: unknown }>(
    api().getRunHistoryHandback({ path: { runId } })
  )
  return document.history_handback === true
}

export const fetchWorkLocalPolicy = () =>
  unwrap<WorkLocalPolicy>(api().getAdminLocalPolicy())

/**
 * §1.4's PATCH /admin/local-policy (0020:217-355). The server records client_request_id in
 * the audit row but keeps no replay receipt - a resend with the same expected revision is
 * refused as governance_revision_conflict - so each call mints its own id.
 */
export const setWorkLocalPolicy = (body: WorkLocalPolicyWrite) =>
  unwrap<WorkLocalPolicy>(api().setAdminLocalPolicy({ body }))

/**
 * §1.4 row 70: the owner's own run-scoped readonly grants (0042:2583-2619). Expired and
 * revoked rows stay in the answer on purpose; omitting the run id lists every grant the
 * caller owns across runs.
 */
export const fetchWorkReadonlyGrants = (runId?: string) =>
  unwrap<WorkReadonlyGrantList>(
    api().listReadonlyGrants({ query: runId ? { run_id: runId } : undefined })
  )

/**
 * 0042:2518-2580. expected_revision is the CAS anchor and the request id lands in the
 * receipt index, so a lost response may be retried with the same id and answers
 * replayed=true. A stale revision or a non-active row is refused as
 * idempotency_key_conflict / invalid_transition rather than silently revoking.
 */
export const revokeWorkReadonlyGrant = (
  grantId: string,
  body: WorkReadonlyGrantRevoke
) =>
  unwrap<WorkReadonlyGrantRevoked>(
    api().revokeReadonlyGrant({ path: { grantId }, body })
  )

import type {
  WorkAcceptanceResult,
  WorkAdminOverview,
  WorkAdminSeatList,
  WorkAuditExport,
  WorkArtifactContent,
  WorkArtifactVersionCreated,
  WorkBootstrap,
  WorkInboxList,
  WorkInputResponse,
  WorkOrgUsage,
  WorkOperationList,
  WorkPreviewResponse,
  WorkRunAccepted,
  WorkProviderConfig,
  WorkSubmitResponse,
  WorkTaskDeletion,
  WorkTaskArtifactWorkspace,
  WorkTaskDetail,
  WorkTaskList,
  WorkTemplate,
  PermissionMode,
} from './types'
import type { WorkClient } from './generated/r0a-client.mjs'
import {
  OPERATIONS,
  WorkApiError as ContractApiError,
  createWorkClient,
} from './generated/r0a-client.mjs'

/**
 * The call layer is generated. Paths, HTTP methods, which operations require the double-submit
 * token, the stream flag, the success status and the request/response schema names all come from
 * r0a-openapi-v1.yaml through ./generated/r0a-client.mjs, and `npm run check:work-api` (wired into
 * `npm test`, which CI runs) fails if that file drifts from the contract. What stays here is only
 * the app-facing surface: the exported function names and argument shapes every query, mutation and
 * component already speaks, the WorkApiError the app branches on, and the three transports the
 * generated client cannot serve verbatim (marked below).
 */
let csrfToken: string | null = null

// Built per call, and that is not a cache miss waiting to be fixed: the generated client keeps the
// token it refreshed during one request, and a long-lived instance would then carry it past a
// re-bootstrap (a different session, or a test that resets the module token). The single-call
// lifetime is also exactly the retry-once window the transport is meant to have.
const api = (): WorkClient =>
  createWorkClient({
    // Resolved per call so a test that stubs the global after import still drives the real path,
    // and so this module never captures a stale reference.
    fetchImpl: (input, init) => fetch(input, init),
    // A cold start has no token yet. Fetching bootstrap here keeps the recovery path the previous
    // hand-written client had by accident - it sent the mutation, took the 403 csrf_invalid and
    // refreshed - without relying on a round trip that the server must first refuse.
    getCsrfToken: async () =>
      csrfToken ?? (await fetchWorkBootstrap()).csrf_token,
    // The server refuses a stale token before any side effect, so one refresh-and-retry is safe;
    // bootstrap is a GET and needs no token, so this cannot recurse further.
    refreshCsrfToken: async () => (await fetchWorkBootstrap()).csrf_token,
  })

export class WorkApiError extends Error {
  status: number
  code: string
  currentRevision?: number
  recoveryAction?: string
  correlationId?: string

  constructor(status: number, body: Record<string, unknown>) {
    super(
      typeof body.message === 'string' ? body.message : `Work API ${status}`
    )
    this.status = status
    this.code = typeof body.code === 'string' ? body.code : 'service_degraded'
    this.currentRevision =
      typeof body.current_revision === 'number'
        ? body.current_revision
        : undefined
    this.recoveryAction =
      typeof body.recovery_action === 'string'
        ? body.recovery_action
        : undefined
    this.correlationId =
      typeof body.correlation_id === 'string' ? body.correlation_id : undefined
  }
}

// D5 §7 names the codes that must carry dedicated copy (#30 A, 2026-11-04). The contract's
// `ui` column classifies 60 codes into 23 families but is not part of the Error payload
// (code/message/retryable/correlation_id/current_revision/recovery_action, additionalProperties
// false), so the copy keys off the code itself; `ui` stays a contract-side authoring aid.
const WORK_ERROR_KEYS: Record<string, string> = {
  artifact_read_only: 'errors.artifactReadOnly',
  admin_access_denied: 'errors.adminAccessDenied',
  audit_export_not_found: 'errors.auditExportNotFound',
  audit_export_not_ready: 'errors.auditExportNotReady',
  audit_export_already_downloaded: 'errors.auditExportAlreadyDownloaded',
  audit_export_range_invalid: 'errors.auditExportRangeInvalid',
  audit_export_expired: 'errors.auditExportExpired',
  download_token_invalid: 'errors.downloadTokenInvalid',
  download_token_expired: 'errors.downloadTokenExpired',
}

// Returns an i18n key for the caught error. The server's `message` field is Chinese;
// callers must pass the key through `t()` rather than displaying it verbatim.
export const workErrorMessage = (cause: unknown): string => {
  if (cause instanceof WorkApiError) {
    if (cause.code === 'resync_required') return 'errors.resyncRequired'
    const dedicated = WORK_ERROR_KEYS[cause.code]
    if (dedicated) return dedicated
  }
  return 'errors.generic'
}

export const setWorkCSRFToken = (token: string | null) => {
  csrfToken = token
}

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

/**
 * Contract path templates still carry their `/work/v1` prefix and `{placeholders}`, which is what
 * the three transports below need before handing the URL to fetch.
 */
const contractPath = (operationId: string): string => {
  const operation = OPERATIONS.find(
    (entry) => entry.operationId === operationId
  )
  if (!operation) {
    throw new Error(
      `r0a-openapi-v1.yaml no longer declares ${operationId}; this transport is not generated ` +
        `because its consumer is typed on a raw Response, so fix the call site instead`
    )
  }
  return operation.path
}

const fillPath = (
  template: string,
  values: Record<string, string | number>
): string =>
  template.replace(/{(\w+)}/g, (match, name: string) =>
    name in values ? encodeURIComponent(String(values[name])) : match
  )

const parseError = async (response: Response): Promise<WorkApiError> => {
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    /* non-JSON gateway error */
  }
  return new WorkApiError(response.status, body)
}

export const fetchWorkBootstrap = async (): Promise<WorkBootstrap> => {
  const data = await unwrap<WorkBootstrap>(api().getBootstrap())
  setWorkCSRFToken(data.csrf_token)
  return data
}

export const fetchWorkTemplates = () =>
  unwrap<{ items: WorkTemplate[] }>(api().listTemplates())

export const fetchWorkTasks = (view: string, cursor?: string | null) =>
  unwrap<WorkTaskList>(
    api().listTasks({
      query: { view, limit: 20, ...(cursor ? { cursor } : {}) },
    })
  )

export const fetchWorkInbox = (cursor?: string | null) =>
  unwrap<WorkInboxList>(
    api().listInbox({ query: { limit: 20, ...(cursor ? { cursor } : {}) } })
  )

export const fetchWorkRunOperations = (runId: string, cursor?: string | null) =>
  unwrap<WorkOperationList>(
    api().listOperations({
      path: { runId },
      query: { limit: 20, ...(cursor ? { cursor } : {}) },
    })
  )

export const fetchWorkTask = (taskId: string) =>
  unwrap<WorkTaskDetail>(api().getTask({ path: { taskId } }))

/**
 * Task-scoped artifact deep link. Not a contract operation: the drift gate keeps it visible as
 * IMPLEMENTED_ONLY (test/go-surface-drift.test.mjs), so the path is genuinely hand-owned here and
 * is the reason this file cannot be fully generated.
 */
export const fetchWorkArtifactWorkspace = (
  taskId: string,
  artifactId: string
) =>
  unwrap<WorkTaskArtifactWorkspace>(
    fetchWithEnvelope(
      fillPath('/work/v1/tasks/{taskId}/artifacts/{artifactId}', {
        artifactId,
        taskId,
      })
    )
  )

export const workTaskArtifactContentUrl = (
  taskId: string,
  artifactId: string,
  versionNo: number,
  disposition: 'inline' | 'attachment' = 'inline'
) =>
  fillPath(
    '/work/v1/tasks/{taskId}/artifacts/{artifactId}/versions/{versionNo}/content',
    { artifactId, taskId, versionNo }
  ) + `?disposition=${disposition}`

/** Same deep link, and the body is text with a content type the caller shows, so it stays raw. */
export const fetchWorkArtifactContent = async (
  taskId: string,
  artifactId: string,
  versionNo: number,
  disposition: 'inline' | 'attachment' = 'inline'
): Promise<WorkArtifactContent> => {
  const response = await fetch(
    workTaskArtifactContentUrl(taskId, artifactId, versionNo, disposition),
    {
      credentials: 'same-origin',
      headers: { Accept: 'text/markdown, text/plain' },
    }
  )
  if (!response.ok) throw await parseError(response)
  const contentType = response.headers.get('content-type') ?? ''
  return {
    text: await response.text(),
    mediaType: contentType.split(';')[0].trim(),
  }
}

// The contract leaves media_type optional with a default and the handler applies it (inputs.go
// resolvedMediaType), but the derived types treat a defaulted property as always present, so the
// only legal value is stated here. The server stores the same thing either way.
export const createWorkInput = (body: {
  client_request_id: string
  goal: string
  background: string
}) =>
  unwrap<WorkInputResponse>(
    api().createInput({ body: { ...body, media_type: 'text/markdown' } })
  )

export const createWorkPreview = (body: {
  input_ref: string
  template_id: string
  permission_mode: PermissionMode
}) => unwrap<WorkPreviewResponse>(api().createTaskPreview({ body }))

export const submitWorkTask = (body: {
  client_request_id: string
  input_ref: string
  template_id: string
  permission_mode: PermissionMode
  preview_hash: string
}) => unwrap<WorkSubmitResponse>(api().submitTask({ body }))

export const updateWorkTaskTitle = (
  taskId: string,
  body: {
    client_request_id: string
    expected_revision: number
    title: string
  }
) => unwrap<unknown>(api().updateTask({ path: { taskId }, body }))

export const deleteWorkTask = (taskId: string, expectedRevision: number) =>
  unwrap<WorkTaskDeletion>(
    api().deleteTask({
      path: { taskId },
      query: { expected_revision: expectedRevision },
    })
  )

export const retryWorkTask = (
  taskId: string,
  body: {
    client_request_id: string
    expected_revision: number
    target: { kind: string; profile: string }
  }
) =>
  // R0a advertises exactly one execution target (bootstrap.go returns
  // [{kind: "cloud", profile: "text-v1"}]), which is what the contract narrows to; the app's own
  // body type stays loose because it is built from the bootstrap response.
  unwrap<WorkRunAccepted>(
    api().retryTask({
      path: { taskId },
      body: {
        ...body,
        target: body.target as { kind: 'cloud'; profile: 'text-v1' },
      },
    })
  )

export const cancelWorkRun = (runId: string) =>
  unwrap<unknown>(
    api().cancelRun({
      path: { runId },
      // CancelRequest requires client_request_id (8-128). The control plane does
      // not dedupe cancellation yet, so a per-attempt id satisfies the wire
      // contract; the gap is recorded in docs/plan/work-project.md.
      body: { client_request_id: crypto.randomUUID() },
    })
  )

export const acceptWorkTask = (
  taskId: string,
  body:
    | {
        client_request_id: string
        expected_revision: number
        completion_reason: string
      }
    | {
        client_request_id: string
        expected_revision: number
        artifact_id: string
        version_no: number
      }
) => unwrap<WorkAcceptanceResult>(api().acceptTask({ path: { taskId }, body }))

// D5:209. base_version_no is the optimistic-concurrency token: it must equal the
// newest published version or the server answers 409 version_conflict rather than
// overwriting. client_request_id is the retry dedup, so a timeout resend publishes
// nothing new - the same key must be reused until the call succeeds.
export const createWorkArtifactVersion = (
  artifactId: string,
  body: {
    client_request_id: string
    base_version_no: number
    media_type?: string
    content: string
  }
) =>
  unwrap<WorkArtifactVersionCreated>(
    api().createArtifactVersion({
      path: { artifactId },
      body: {
        ...body,
        media_type: (body.media_type ?? 'text/markdown') as
          | 'text/markdown'
          | 'text/plain',
      },
    })
  )

/**
 * The contract declares this operation (streamTaskEvents, with Last-Event-ID), but its consumer is
 * typed on a Response whose body the hook reads itself, so the stream stays a raw fetch. The path
 * and the header name come from the table; the generated client's own stream support is what would
 * replace this once useTaskEventStream is retyped onto the frame iterator.
 */
export const openWorkEventStream = (
  taskId: string,
  signal: AbortSignal,
  lastEventId?: string
) => {
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (lastEventId) headers.set('Last-Event-ID', lastEventId)
  return fetch(fillPath(contractPath('streamTaskEvents'), { taskId }), {
    credentials: 'same-origin',
    headers,
    signal,
  })
}

export const fetchAdminOverview = () =>
  unwrap<WorkAdminOverview>(api().getAdminOverview())

export const fetchAdminSeats = (cursor?: string | null) =>
  unwrap<WorkAdminSeatList>(
    api().listSeats({ query: { limit: 20, ...(cursor ? { cursor } : {}) } })
  )

export const fetchAdminUsage = (from: string, to: string) =>
  unwrap<WorkOrgUsage>(api().getAdminUsage({ query: { from, to } }))

export const fetchAdminProviderConfig = () =>
  unwrap<WorkProviderConfig>(api().getProviderConfig())

export const createAdminAuditExport = (body: {
  client_request_id: string
  range_from: string
  range_to: string
  format: 'csv' | 'json'
}) => unwrap<WorkAuditExport>(api().createAuditExport({ body }))

export const fetchAdminAuditExport = (exportId: string) =>
  unwrap<WorkAuditExport>(api().getAuditExport({ path: { exportId } }))

export const createAdminAuditExportTicket = (exportId: string) =>
  unwrap<{ token: string }>(
    api().createAuditExportTicket({ path: { exportId } })
  )

/**
 * The ticket comes from the generated operation; the download itself must stay a raw fetch because
 * the caller turns the body into a Blob for the browser's save dialog - reading it as text through
 * the generated parser would re-encode the bytes the export worker wrote.
 */
export const downloadAdminAuditExport = async (exportId: string) => {
  const { token } = await createAdminAuditExportTicket(exportId)
  const response = await fetch(
    fillPath(contractPath('getAuditExportContent'), { exportId }),
    {
      credentials: 'same-origin',
      headers: { 'X-Download-Token': token },
    }
  )
  if (!response.ok) throw await parseError(response)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `audit-export-${exportId}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

import type {
  WorkCredentialRevoked,
  WorkProviderConfigInput,
  WorkProviderCredential,
  WorkProviderCredentialInput,
  WorkProviderCredentialRotateInput,
  WorkProviderRevoked,
  WorkProviderRevokeInput,
} from './types'

export const setAdminProviderConfig = (body: WorkProviderConfigInput) =>
  unwrap<WorkProviderConfig>(api().setProviderConfig({ body }))

export const revokeAdminProviderConfig = (body: WorkProviderRevokeInput) =>
  unwrap<WorkProviderRevoked>(api().revokeProviderConfig({ body }))

export const createAdminProviderCredential = (
  body: WorkProviderCredentialInput
) => unwrap<WorkProviderCredential>(api().createProviderCredential({ body }))

export const rotateAdminProviderCredential = (
  credentialId: string,
  body: WorkProviderCredentialRotateInput
) =>
  unwrap<WorkProviderCredential>(
    api().rotateProviderCredential({ path: { credentialId }, body })
  )

export const revokeAdminProviderCredential = (
  credentialId: string,
  body: WorkProviderRevokeInput
) =>
  unwrap<WorkCredentialRevoked>(
    api().revokeProviderCredential({ path: { credentialId }, body })
  )

/** Raw-JSON fetch for the deep link above; refusals keep the app's error shape. */
async function fetchWithEnvelope(path: string): Promise<{ data: unknown }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw await parseError(response)
  return { data: await response.json() }
}

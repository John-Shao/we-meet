/**
 * E6 live Work API client. Uses the same-origin session cookie and the
 * contract's csrf_token; no bearer token is declared for R0a.
 */
import type {
  Bootstrap,
  ErrorEnvelope,
  Page,
  Run,
  TaskDetail,
  TaskRun,
  TaskSummary,
  WorkApiClient,
} from '../contracts/api'
import {
  parseEventFrame,
  type SseConnection,
  type SseOptions,
} from '../contracts/sse'

export class WorkApiError extends Error {
  status: number
  code: string
  retryable: boolean
  correlationId: string
  recoveryAction: string | null
  currentRevision: number | null

  constructor(status: number, payload: Partial<ErrorEnvelope>) {
    super(payload.message || payload.code || 'work_api_error')
    this.name = 'WorkApiError'
    this.status = status
    this.code = payload.code || 'service_degraded'
    this.retryable = payload.retryable ?? status >= 500
    this.correlationId = payload.correlation_id || ''
    this.recoveryAction = payload.recovery_action ?? null
    this.currentRevision = payload.current_revision ?? null
  }
}

let csrfToken: string | null = null

const cookieCsrf = () => {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

const queryString = (params: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

type RequestOptions = {
  method?: string
  body?: unknown
  headers?: HeadersInit
  signal?: AbortSignal
  raw?: boolean
}

const request = async <T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> => {
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.body !== undefined)
    headers.set('Content-Type', 'application/json')
  const method = options.method || 'GET'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = csrfToken || cookieCsrf()
    if (token) headers.set('X-CSRFToken', token)
  }
  const response = await fetch(`/work/v1${path}`, {
    method,
    credentials: 'include',
    headers,
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (!response.ok) {
    let payload: Partial<ErrorEnvelope> = {}
    try {
      payload = (await response.json()) as Partial<ErrorEnvelope>
    } catch {
      payload = {}
    }
    throw new WorkApiError(response.status, payload)
  }
  if (options.raw) return response as T
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const createWorkApiClient = (): WorkApiClient => ({
  async getBootstrap() {
    const bootstrap = await request<Bootstrap>('/bootstrap')
    csrfToken = bootstrap.csrf_token
    return bootstrap
  },
  createInput: (body) => request('/inputs', { method: 'POST', body }),
  listTemplates: () => request<Page<unknown>>('/templates'),
  createTaskPreview: (body) =>
    request('/task-previews', { method: 'POST', body }),
  listTasks: (query) =>
    request<Page<TaskSummary>>(
      `/tasks${queryString({
        view: query.view,
        cursor: query.cursor,
        limit: query.limit,
      })}`
    ),
  submitTask: (body) => request<TaskRun>('/tasks', { method: 'POST', body }),
  getTask: (taskId) => request<TaskDetail>(`/tasks/${taskId}`),
  updateTask: (taskId, body) =>
    request<TaskSummary>(`/tasks/${taskId}`, { method: 'PATCH', body }),
  deleteTask: (taskId, expectedRevision) =>
    request(
      `/tasks/${taskId}${queryString({ expected_revision: expectedRevision })}`,
      {
        method: 'DELETE',
      }
    ),
  retryTask: (taskId, body) =>
    request<TaskRun>(`/tasks/${taskId}/runs`, { method: 'POST', body }),
  getRun: (runId) => request<Run>(`/runs/${runId}`),
  listOperations: (runId, query = {}) =>
    request(
      `/runs/${runId}/operations${queryString({
        cursor: query.cursor,
        limit: query.limit,
      })}`
    ),
  cancelRun: (runId, body) =>
    request<Run>(`/runs/${runId}/cancel`, { method: 'POST', body }),
  listInbox: (query = {}) =>
    request(
      `/inbox${queryString({ cursor: query.cursor, limit: query.limit })}`
    ),
  createArtifactVersion: (artifactId, body) =>
    request(`/artifacts/${artifactId}/versions`, { method: 'POST', body }),
  getArtifactVersion: (artifactId, versionNo) =>
    request(`/artifacts/${artifactId}/versions/${versionNo}`),
  getArtifactContent: (artifactId, versionNo, disposition = 'inline') =>
    request<Response>(
      `/artifacts/${artifactId}/versions/${versionNo}/content${queryString({
        disposition,
      })}`,
      { raw: true }
    ),
  acceptTask: (taskId, body) =>
    request(`/tasks/${taskId}/acceptances`, { method: 'POST', body }),
  getUserUsage: (query) => request(`/me/usage${queryString(query)}`),
  getAdminUsage: (query) => request(`/admin/usage${queryString(query)}`),
  getProviderConfig: () => request('/admin/provider-config'),
  setProviderConfig: (body) =>
    request('/admin/provider-config', { method: 'PUT', body }),
  revokeProviderConfig: (body) =>
    request('/admin/provider-config/revoke', { method: 'POST', body }),
  createProviderCredential: (body) =>
    request('/admin/provider-credentials', { method: 'POST', body }),
  rotateProviderCredential: (credentialId, body) =>
    request(`/admin/provider-credentials/${credentialId}/rotate`, {
      method: 'POST',
      body,
    }),
  revokeProviderCredential: (credentialId, body) =>
    request(`/admin/provider-credentials/${credentialId}/revoke`, {
      method: 'POST',
      body,
    }),
  getAdminOverview: () => request('/admin/overview'),
  listSeats: (query = {}) =>
    request(
      `/admin/seats${queryString({ cursor: query.cursor, limit: query.limit })}`
    ),
  createAuditExport: (body) =>
    request('/admin/audit-exports', { method: 'POST', body }),
  getAuditExport: (exportId) => request(`/admin/audit-exports/${exportId}`),
  createAuditExportTicket: (exportId, body = {}) =>
    request(`/admin/audit-exports/${exportId}/download-ticket`, {
      method: 'POST',
      body,
    }),
  getAuditExportContent: (exportId, token) =>
    request<Response>(`/admin/audit-exports/${exportId}/content`, {
      raw: true,
      headers: { 'X-Download-Token': token },
    }),
})

/** SSE subscription over fetch so Last-Event-ID can be sent as a header. */
export const subscribeTaskEvents = async (
  taskId: string,
  options: SseOptions
): Promise<SseConnection> => {
  const controller = options.signal ? undefined : new AbortController()
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (options.lastEventId) headers.set('Last-Event-ID', options.lastEventId)
  const response = await fetch(`/work/v1/tasks/${taskId}/events`, {
    credentials: 'include',
    headers,
    signal: options.signal || controller?.signal,
  })
  if (response.status === 409) {
    options.onResyncRequired()
    throw new WorkApiError(
      409,
      (await response.json()) as Partial<ErrorEnvelope>
    )
  }
  if (!response.ok || !response.body) {
    throw new WorkApiError(response.status, {})
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      let doneReading = false
      while (!doneReading) {
        const chunk = await reader.read()
        doneReading = chunk.done
        if (doneReading) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const event = parseEventFrame(frame)
          if (event) options.onEvent(event)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  void pump.catch(() => undefined)
  return { close: () => controller?.abort() }
}

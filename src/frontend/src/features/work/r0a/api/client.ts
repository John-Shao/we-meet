import type {
  WorkAcceptanceResult,
  WorkArtifactContent,
  WorkBootstrap,
  WorkInputResponse,
  WorkPreviewResponse,
  WorkSubmitResponse,
  WorkTaskDetail,
  WorkTaskList,
  WorkTemplate,
} from './types'

const BASE = '/work/v1'
let csrfToken: string | null = null

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

export const setWorkCSRFToken = (token: string | null) => {
  csrfToken = token
}

const parseError = async (response: Response): Promise<WorkApiError> => {
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    /* non-JSON gateway error */
  }
  return new WorkApiError(response.status, body)
}

const request = async <T>(
  path: string,
  options: RequestInit = {},
  retryCSRF = true
): Promise<T> => {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  if (method !== 'GET' && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken)
  }
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  if (!response.ok) {
    const error = await parseError(response)
    if (retryCSRF && method !== 'GET' && error.code === 'csrf_invalid') {
      await fetchWorkBootstrap()
      return request<T>(path, options, false)
    }
    throw error
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const fetchWorkBootstrap = async (): Promise<WorkBootstrap> => {
  const data = await request<WorkBootstrap>('/bootstrap')
  setWorkCSRFToken(data.csrf_token)
  return data
}

export const fetchWorkTemplates = () =>
  request<{ items: WorkTemplate[] }>('/templates')

export const fetchWorkTasks = (view: string, cursor?: string | null) => {
  const params = new URLSearchParams({ view, limit: '20' })
  if (cursor) params.set('cursor', cursor)
  return request<WorkTaskList>(`/tasks?${params.toString()}`)
}

export const fetchWorkTask = (taskId: string) =>
  request<WorkTaskDetail>(`/tasks/${encodeURIComponent(taskId)}`)

export const workArtifactContentUrl = (
  artifactId: string,
  versionNo: number,
  disposition: 'inline' | 'attachment' = 'inline'
) =>
  `${BASE}/artifacts/${encodeURIComponent(artifactId)}/versions/${versionNo}/content?disposition=${disposition}`

export const fetchWorkArtifactContent = async (
  artifactId: string,
  versionNo: number,
  disposition: 'inline' | 'attachment' = 'inline'
): Promise<WorkArtifactContent> => {
  const response = await fetch(
    workArtifactContentUrl(artifactId, versionNo, disposition),
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

export const createWorkInput = (body: {
  client_request_id: string
  goal: string
  background: string
}) =>
  request<WorkInputResponse>('/inputs', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const createWorkPreview = (body: {
  input_ref: string
  template_id: string
  permission_mode: string
}) =>
  request<WorkPreviewResponse>('/task-previews', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const submitWorkTask = (body: {
  client_request_id: string
  input_ref: string
  template_id: string
  permission_mode: string
  preview_hash: string
}) =>
  request<WorkSubmitResponse>('/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const updateWorkTaskTitle = (
  taskId: string,
  body: {
    client_request_id: string
    expected_revision: number
    title: string
  }
) =>
  request(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const cancelWorkRun = (runId: string) =>
  request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })

export const acceptWorkTask = (
  taskId: string,
  body: {
    client_request_id: string
    expected_revision: number
    completion_reason: string
  }
) =>
  request<WorkAcceptanceResult>(
    `/tasks/${encodeURIComponent(taskId)}/acceptances`,
    { method: 'POST', body: JSON.stringify(body) }
  )

export const openWorkEventStream = (
  taskId: string,
  signal: AbortSignal,
  lastEventId?: string
) => {
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (lastEventId) headers.set('Last-Event-ID', lastEventId)
  return fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/events`, {
    credentials: 'same-origin',
    headers,
    signal,
  })
}

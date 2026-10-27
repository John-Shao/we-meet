/**
 * E6 Work API contract. Mirrors docs/plan/assets/work-r0a-design-2026-10-25/
 * r0a-openapi-v1.yaml (29 paths / 33 operations). Generated schemas remain
 * authoritative; this file only fixes the client surface and error shape.
 */

export type WorkOperationId =
  | 'getBootstrap'
  | 'createInput'
  | 'listTemplates'
  | 'createTaskPreview'
  | 'listTasks'
  | 'submitTask'
  | 'getTask'
  | 'updateTask'
  | 'deleteTask'
  | 'retryTask'
  | 'getRun'
  | 'listOperations'
  | 'cancelRun'
  | 'streamTaskEvents'
  | 'listInbox'
  | 'createArtifactVersion'
  | 'getArtifactVersion'
  | 'getArtifactContent'
  | 'acceptTask'
  | 'getUserUsage'
  | 'getAdminUsage'
  | 'getProviderConfig'
  | 'setProviderConfig'
  | 'revokeProviderConfig'
  | 'createProviderCredential'
  | 'rotateProviderCredential'
  | 'revokeProviderCredential'
  | 'getAdminOverview'
  | 'listSeats'
  | 'createAuditExport'
  | 'getAuditExport'
  | 'createAuditExportTicket'
  | 'getAuditExportContent'

export type PermissionMode = 'ask_each' | 'auto_readonly'
export type DisplayState =
  | 'open'
  | 'queued'
  | 'running'
  | 'awaiting_acceptance'
  | 'completed'
  | 'failed'
  | 'run_canceled'
  | 'reconciling'
  | 'quota_exhausted'
  | 'canceling'
  | 'canceled'
  | 'archived'
export type TaskState =
  | 'open'
  | 'awaiting_acceptance'
  | 'completed'
  | 'canceled'
  | 'archived'
export type RunState =
  | 'queued'
  | 'active'
  | 'waiting'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface ErrorEnvelope {
  code: string
  message: string
  retryable: boolean
  correlation_id: string
  current_revision?: number | null
  recovery_action?: string | null
}

export interface Target {
  kind: 'cloud'
  profile: 'text-v1'
}

export interface Intent {
  input_ref: string
  target: Target
  template?: { id: string; version: number } | null
  permission_mode: PermissionMode
  output: {
    format: 'markdown'
    audience?: string | null
    length?: 'short' | 'medium' | 'long' | null
    required_sections?: string[]
  }
  suite?: null
  connectors?: []
}

export interface Run {
  id: string
  task_id: string
  attempt_no: number
  state: RunState
  wait_reason: 'quota' | 'provider' | 'reconcile' | null
  terminal_reason: string | null
  control_revision: number
  runtime_version: string
  created_at: string
  updated_at: string
}

export interface TaskSummary {
  task_id: string
  title: string
  display_state: DisplayState
  task_state: TaskState
  permission_mode: PermissionMode
  active_run_id: string | null
  latest_run_id: string | null
  latest_run: Run | null
  latest_artifact: {
    artifact_id: string
    version_no: number
    content_hash: string
  } | null
  revision: number
  pending_acceptance: boolean
  blocking_operations: number
  quota: { reserved_tokens: number; settled_tokens: number }
  created_at: string
  updated_at: string
}

export interface TaskDetail {
  summary: TaskSummary
  input_ref: string
  goal: string
  background: string | null
  template: unknown | null
  snapshot: Record<string, unknown>
}

export interface TaskRun {
  task: TaskSummary
  run: Run
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export interface Bootstrap {
  subject_id: string
  org: {
    id: string
    name: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
    work_seat: boolean
  }
  permissions: string[]
  phases: ['R0a']
  execution_targets: Target[]
  allowed_permission_modes: PermissionMode[]
  limits: {
    max_goal_chars: number
    max_background_chars: number
    max_artifact_bytes: number
    max_active_runs: number
  }
  csrf_token: string
}

export interface WorkApiClient {
  getBootstrap(): Promise<Bootstrap>
  createInput(body: {
    client_request_id: string
    goal: string
    background?: string
    media_type?: 'text/markdown'
  }): Promise<unknown>
  listTemplates(): Promise<Page<unknown>>
  createTaskPreview(body: { intent: Intent }): Promise<unknown>
  listTasks(query: {
    view?: string
    cursor?: string
    limit?: number
  }): Promise<Page<TaskSummary>>
  submitTask(body: {
    client_request_id: string
    preview_hash: string
    intent: Intent
  }): Promise<TaskRun>
  getTask(taskId: string): Promise<TaskDetail>
  updateTask(
    taskId: string,
    body: {
      client_request_id: string
      expected_revision: number
      title: string
    }
  ): Promise<TaskSummary>
  deleteTask(taskId: string, expectedRevision: number): Promise<unknown>
  retryTask(
    taskId: string,
    body: {
      client_request_id: string
      expected_revision: number
      target: Target
    }
  ): Promise<TaskRun>
  getRun(runId: string): Promise<Run>
  listOperations(
    runId: string,
    query?: { cursor?: string; limit?: number }
  ): Promise<Page<unknown>>
  cancelRun(
    runId: string,
    body: { client_request_id: string; reason?: string }
  ): Promise<Run>
  listInbox(query?: { cursor?: string; limit?: number }): Promise<Page<unknown>>
  createArtifactVersion(artifactId: string, body: unknown): Promise<unknown>
  getArtifactVersion(artifactId: string, versionNo: number): Promise<unknown>
  getArtifactContent(
    artifactId: string,
    versionNo: number,
    disposition?: 'inline' | 'attachment'
  ): Promise<Response>
  acceptTask(taskId: string, body: unknown): Promise<unknown>
  getUserUsage(query: { from: string; to: string }): Promise<unknown>
  getAdminUsage(query: { from: string; to: string }): Promise<unknown>
  getProviderConfig(): Promise<unknown>
  setProviderConfig(body: unknown): Promise<unknown>
  revokeProviderConfig(body: { reason: string }): Promise<unknown>
  createProviderCredential(body: unknown): Promise<unknown>
  rotateProviderCredential(
    credentialId: string,
    body: { api_key: string }
  ): Promise<unknown>
  revokeProviderCredential(
    credentialId: string,
    body: { reason: string }
  ): Promise<unknown>
  getAdminOverview(): Promise<unknown>
  listSeats(query?: { cursor?: string; limit?: number }): Promise<Page<unknown>>
  createAuditExport(body: unknown): Promise<unknown>
  getAuditExport(exportId: string): Promise<unknown>
  createAuditExportTicket(
    exportId: string,
    body?: { ttl_seconds?: number }
  ): Promise<unknown>
  getAuditExportContent(exportId: string, token: string): Promise<Response>
}

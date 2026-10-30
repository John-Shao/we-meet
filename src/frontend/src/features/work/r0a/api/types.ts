export type PermissionMode = 'ask_each' | 'auto_readonly'

export interface WorkBootstrap {
  subject_id: string
  org: {
    id: string
    name: string
    role: string
    work_seat: boolean
  }
  permissions: string[]
  phases: string[]
  execution_targets: { kind: string; profile: string }[]
  allowed_permission_modes: PermissionMode[]
  limits: {
    max_goal_chars: number
    max_background_chars: number
    max_artifact_bytes: number
    max_active_runs: number
  }
  csrf_token: string
}

export interface WorkTemplate {
  id: string
  version: number
  name: string
  description: string
  sections: string[]
  content_hash: string
}

export interface WorkRun {
  id: string
  task_id: string
  attempt_no: number
  state: string
  wait_reason: string | null
  terminal_reason: string | null
  control_revision: number
  runtime_version: string
  created_at: string
  updated_at: string
}

export interface WorkArtifactSummary {
  artifact_id: string
  version_no: number
  content_hash: string
}

export interface WorkArtifactContent {
  text: string
  mediaType: string
}

export interface WorkTaskSummary {
  task_id: string
  title: string
  display_state: string
  task_state: string
  permission_mode: PermissionMode
  active_run_id: string | null
  latest_run_id: string | null
  latest_run: WorkRun | null
  latest_artifact: WorkArtifactSummary | null
  revision: number
  pending_acceptance: boolean
  blocking_operations: number
  quota: {
    reserved_tokens: number
    settled_tokens: number
  }
  created_at: string
  updated_at: string
}

export interface WorkSnapshotTemplate {
  id: string
  version: number
  content_hash: string
}

export interface WorkSnapshot {
  snapshot_id: string
  snapshot_revision: number
  template: WorkSnapshotTemplate
  limits: { token_upper_bound: number }
  permission_mode: string
  created_at: string
}

export interface WorkTaskDetail {
  summary: WorkTaskSummary
  input_ref: string
  goal: string
  background: string | null
  template: WorkTemplate | null
  snapshot: WorkSnapshot | null
  latest_event_id: string | null
}

export interface WorkTaskList {
  items: WorkTaskSummary[]
  next_cursor: string | null
}

export interface WorkInputResponse {
  input_ref: string
  content_hash: string
  bytes: number
  expires_at: string
}

export interface WorkPreviewResponse {
  preview_hash: string
  expires_at: string
  token_upper_bound: number
  template: WorkTemplate
  input_ref: string
  input_hash: string
  input_bytes: number
}

export interface WorkSubmitResponse {
  task_id: string
  run_id: string
  revision: number
  task_state: string
  display_state: string
  input_ref: string
}

export interface WorkAcceptance {
  id: string
  task_id: string
  artifact_id: string | null
  version_no: number | null
  completion_reason: string | null
  actor_subject_id: string
  task_revision: number
  created_at: string
}

export interface WorkAcceptanceResult {
  acceptance: WorkAcceptance
  task: WorkTaskSummary
}

export interface WorkTaskEvent {
  event_id: string
  task_id: string
  run_id?: string | null
  seq: number
  schema_version: string
  occurred_at: string
  type: string
  payload: Record<string, unknown>
}

export type WorkTaskView =
  | 'all'
  | 'pending'
  | 'running'
  | 'awaiting_acceptance'
  | 'completed'

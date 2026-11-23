/**
 * Schema types for work-r0b-browser-openapi.yaml.
 *
 * Hand-authored, not generated: the shapes are the SQL functions' closed documents
 * (0021:551, 0061/0062, 0020:420-449, 0042:2583-2619), and the contract gate
 * (test/browser-contract.test.mjs) pins this file's interface set to the schema names
 * declared in the YAML. Field-level authority stays with those functions.
 *
 * The frontend copy is byte-identical to this file (scripts/gen-work-r0b-api.mjs).
 */

export type components = {
  schemas: {
    RunReconciliations: RunReconciliations
    HistoryHandback: HistoryHandback
    LocalPolicy: LocalPolicy
    LocalPolicyWriteRequest: LocalPolicyWriteRequest
    ReadonlyGrantList: ReadonlyGrantList
    ReadonlyGrant: ReadonlyGrant
    ReadonlyGrantRevokeRequest: ReadonlyGrantRevokeRequest
    ReadonlyGrantRevoked: ReadonlyGrantRevoked
  }
}

export type ReconciliationResolutionState =
  | 'pending'
  | 'downgraded_readonly'
  | 'evidence_exhausted'

export type ReconciliationContactPath =
  | 'wait_for_reconciliation'
  | 'wait_for_late_evidence'
  | 'operator_ticket'

export interface RunReconciliationItem {
  operation_id: string
  kind: string
  operation_state: string
  reconcile_requested_at: string | null
  waited_seconds: number | null
  resolution_state: ReconciliationResolutionState
  evidence_sources: string[]
  ticket_id: string | null
  has_authoritative_evidence: boolean
  contact_path: ReconciliationContactPath
}

export interface RunReconciliations {
  org_id: string
  run_id: string
  task_id: string
  run_state: string
  wait_reason: string | null
  blocking: {
    new_run: boolean
    acceptance: boolean
  }
  items: RunReconciliationItem[]
}

export interface HistoryHandback {
  run_id: string
  history_handback: boolean
}

export type LocalPolicyGate =
  | 'ready'
  | 'local_policy_not_configured'
  | 'local_policy_incomplete'

export type LocalClassification = 'local_only' | 'remote_excerpt_allowed'

export interface LocalPolicyConfigured {
  org_id: string
  configured: true
  gate: LocalPolicyGate
  allowed_tools: string[]
  allowed_destinations: string[]
  classification_rules: unknown[]
  classification_default: LocalClassification
  classification_default_confirmed: boolean
  classification_floor: LocalClassification
  readonly_max_actions: number
  readonly_ttl: string
  input_limit_bytes: number
  output_limit_bytes: number
  effective_epoch: number
  revision: number
}

export interface LocalPolicyUnconfigured {
  org_id: string
  configured: false
  gate: LocalPolicyGate
}

export type LocalPolicy = LocalPolicyConfigured | LocalPolicyUnconfigured

export interface LocalPolicyWriteRequest {
  revision: number
  client_request_id: string
  allowed_tools: string[]
  allowed_destinations: string[]
  classification_rules: unknown[]
  classification_default: LocalClassification
  classification_default_confirmed: boolean
  classification_floor: LocalClassification
  readonly_max_actions: number
  readonly_ttl: string
  input_limit_bytes: number
  output_limit_bytes: number
}

export type ReadonlyGrantStatus =
  | 'active'
  | 'revoked'
  | 'expired'
  | 'invalidated'

export interface ReadonlyGrant {
  id: string
  owner_subject_id: string
  run_id: string
  device_id: string
  workspace_grant_id: string
  grant_revision: number
  tool_set: string[]
  resource_selector_hash: string
  policy_epoch: number
  access_epoch: number
  approval_id: string | null
  expires_at: string
  status: ReadonlyGrantStatus
  consumed_count: number
  revision: number
  created_at: string
  updated_at: string
}

export interface ReadonlyGrantList {
  grants: ReadonlyGrant[]
}

export interface ReadonlyGrantRevokeRequest {
  client_request_id: string
  expected_revision: number
}

export interface ReadonlyGrantRevoked {
  grant_id: string
  status: 'revoked'
  revision: number
  replayed: boolean
}
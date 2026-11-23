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

// 0020:369-412 local_policy_gate. The verdict is the server's; the panel shows it
// rather than deriving it from the document.
export type LocalPolicyGate =
  | 'local_policy_not_configured'
  | 'local_policy_incomplete'
  | 'ready'

// 0020:29-38 classification_rank's closed set.
export type LocalClassification = 'local_only' | 'remote_excerpt_allowed'

// 0020:420-449 get_local_policy: the configured row's columns (minus created_at and
// updated_at) plus configured and gate. classification_rules stays opaque because
// 0020:65-108 owns its shape; re-typing the matchers here would be a second authority.
export interface WorkLocalPolicyConfigured {
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

// 0020:438-444: an organization with no row answers with these three keys only.
export interface WorkLocalPolicyUnconfigured {
  org_id: string
  configured: false
  gate: LocalPolicyGate
}

export type WorkLocalPolicy =
  | WorkLocalPolicyConfigured
  | WorkLocalPolicyUnconfigured

// The PATCH body of api/admin_local_policy.go:59-63: the closed document, the CAS
// anchor and the audit request id. revision 0 is the first write.
export interface WorkLocalPolicyWrite {
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

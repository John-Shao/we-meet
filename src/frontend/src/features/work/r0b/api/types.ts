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
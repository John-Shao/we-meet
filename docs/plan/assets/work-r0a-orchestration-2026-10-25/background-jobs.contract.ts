/**
 * Work R0a background job contracts (D3 §11).
 *
 * These are the non-Run jobs that share the Work database and Temporal cluster
 * with per-Run workflows: outbox relay, content shredder, directory projection
 * sync, audit export worker, expiry sweep and dead-letter operations. The file
 * is a type contract for the implementation (E3/E4/E5) — it does not run
 * anything and proves nothing about Temporal or a Content Store.
 *
 * What it pins down:
 *   - every job writes only through a D1 domain function (no table DML);
 *   - every claim carries a lease and only the holder may finish;
 *   - tenant fairness: one transaction per organization, except the relay,
 *     which is the only cross-org consumer;
 *   - obligation jobs (delivery + retention) keep running under kill switch,
 *     so an incident can never silently lose events or keep purged content.
 */

export type BackgroundJobName =
  | 'outbox_relay'
  | 'content_shredder'
  | 'directory_projection_sync'
  | 'audit_export_worker'
  | 'expiry_sweep'
  | 'dead_letter_ops';

export const BACKGROUND_JOBS: readonly BackgroundJobName[] = Object.freeze([
  'outbox_relay',
  'content_shredder',
  'directory_projection_sync',
  'audit_export_worker',
  'expiry_sweep',
  'dead_letter_ops',
]);

/** Jobs that discharge a delivery or retention duty. They must NOT be gated by
 *  the kill switch, a feature flag, or an organization suspension. */
export const OBLIGATION_JOBS: readonly BackgroundJobName[] = Object.freeze([
  'outbox_relay',
  'content_shredder',
  'directory_projection_sync',
  'expiry_sweep',
]);

/** Jobs that create new work. These are the only ones a switch may stop. */
export const WORK_CREATING_JOBS: readonly BackgroundJobName[] = Object.freeze([
  'audit_export_worker',
]);

/** Temporal task queue per job class: background workers never share the Run
 *  worker pool, so a bulk sweep cannot starve user runs of slots. */
export type JobQueue = 'r0a-relay' | 'r0a-background' | 'r0a-ops';

export interface JobSchedule {
  readonly queue: JobQueue;
  /** Cron or fixed delay. Sweep/sync are Schedule-driven; relay/shredder loop. */
  readonly trigger: 'continuous' | 'schedule';
  readonly intervalSeconds: number;
  /** Rows claimed per organization per round; bounds one tenant's share. */
  readonly batchSizePerOrg: number;
  /** Organizations processed concurrently; must stay below DB pool budget. */
  readonly maxParallelOrgs: number;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  /** Backoff cap in seconds, matching mark_outbox_failed (2^n, <=300s). */
  readonly backoffCapSeconds: number;
}

/** Short transaction that claims work; external calls happen only after commit. */
export interface JobLease {
  readonly job: BackgroundJobName;
  readonly workerId: string;
  readonly claimedUntil: string;
}

/**
 * Cross-organization visibility is a deliberate exception: only the relay runs
 * without `app.org_id`, guarded by the dedicated outbox relay RLS policy.
 */
export interface JobContext {
  readonly orgId: string | null;
  readonly workerId: string;
  /** Sweeps and leases compare against DB time, never the application clock. */
  readonly dbNowIso: string;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Outbox relay
// ---------------------------------------------------------------------------

export type OutboxKind =
  | 'task_event'
  | 'start_workflow'
  | 'cancel_signal'
  | 'content_shred';

export interface OutboxRow {
  readonly eventId: string;
  readonly orgId: string;
  readonly aggregateType: 'task' | 'run' | 'content';
  readonly aggregateId: string;
  readonly kind: OutboxKind;
  readonly outboxSeq: number;
  readonly lease: JobLease;
}

export type OutboxAck =
  | { readonly outcome: 'delivered'; readonly eventId: string }
  | { readonly outcome: 'retry'; readonly eventId: string; readonly errorCode: string; readonly retryable: true }
  | { readonly outcome: 'dead_letter'; readonly eventId: string; readonly errorCode: string; readonly attempts: number };

// ---------------------------------------------------------------------------
// Content shredder
// ---------------------------------------------------------------------------

/** Payload of a content_shred outbox row: references only, never body text. */
export interface ShredRequest {
  readonly eventId: string;
  readonly orgId: string;
  readonly contentRefs: readonly string[];
  readonly source:
    | { readonly kind: 'task_deleted'; readonly taskId: string }
    | { readonly kind: 'input_expired'; readonly inputId: string }
    | { readonly kind: 'audit_export_expired'; readonly exportId: string };
}

export interface ShredAdapter {
  /** Implementation must be idempotent per reference; a repeated call on an
   *  already-deleted reference reports deleted, it does not error. */
  delete(input: ShredRequest, signal: AbortSignal): Promise<{ readonly deletedRefs: number }>;
}

// ---------------------------------------------------------------------------
// Directory projection sync (Host ports -> work.sync_* commands)
// ---------------------------------------------------------------------------

export interface OrgProjectionPayload {
  readonly orgId: string;
  readonly name: string | null;
  readonly status: 'active' | 'suspended' | 'archived';
  readonly executionEnabled: boolean;
  readonly homeRegion: string;
  readonly revision: number;
}

export interface MemberProjectionPayload {
  readonly orgId: string;
  readonly subjectId: string;
  readonly status: 'invited' | 'active' | 'suspended' | 'left';
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
  readonly workSeat: boolean;
  readonly revision: number;
}

export interface ProjectionSyncResult {
  readonly orgRevision: number | null;
  readonly membersApplied: number;
  readonly membersSkippedStale: number;
  readonly entitlementLostSubjects: readonly string[];
}

/** Narrowing is not this job's decision: it records intent, orchestration acts.
 *  D-07 A (signed 2026-10-27): R0a records the hint and pages the on-call; nothing
 *  consumes it automatically. An operator cancels through work.ops_cancel_run
 *  (granted to work_ops only). Auto-cancel is the R0b enhancement (D-07 option B).
 *  The directory adapter never writes a Run row. */
export interface EntitlementNarrowingHint {
  readonly orgId: string;
  readonly subjectId: string;
  readonly reason: 'seat_revoked' | 'membership_inactive';
  readonly action: 'request_cancel';
}

// ---------------------------------------------------------------------------
// Audit export worker
// ---------------------------------------------------------------------------

export type AuditExportState = 'queued' | 'running' | 'ready' | 'expired' | 'failed';

export interface ExportJobClaim {
  readonly exportId: string;
  readonly orgId: string;
  readonly lease: JobLease;
  readonly format: 'csv' | 'json';
  readonly rangeFrom: string;
  readonly rangeTo: string;
}

export interface ExportJobCompletion {
  readonly exportId: string;
  readonly workerId: string;
  /** Object name is derived from the export id so a takeover rewrites, never orphans. */
  readonly contentRef: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly rowCount: number;
  readonly ttlSeconds: number;
}

export interface ExportJobFailure {
  readonly exportId: string;
  readonly workerId: string;
  readonly errorCode: 'content_store_unavailable' | 'export_row_limit_exceeded' | 'export_query_timeout';
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  readonly expiredExports: number;
  readonly expiredInputs: number;
  readonly shredRequestsEnqueued: number;
}

// ---------------------------------------------------------------------------
// Dead-letter operations (human driven)
// ---------------------------------------------------------------------------

export interface DeadLetterCommand {
  readonly eventId: string;
  readonly actorSubjectId: string;
  readonly ticketRef: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Failure taxonomy (maps onto the D1 -> D2 error catalogue)
// ---------------------------------------------------------------------------

export type JobErrorCode =
  | 'outbox_lease_lost'
  | 'audit_export_lease_lost'
  | 'audit_export_not_claimable'
  | 'projection_revision_stale'
  | 'directory_org_context_mismatch'
  | 'content_store_unavailable';

/** All of the above are worker-only codes: public API maps them to 503
 *  service_degraded and keeps the raw code in internal logs only. */
export const WORKER_ONLY_JOB_CODES: readonly JobErrorCode[] = Object.freeze([
  'outbox_lease_lost',
  'audit_export_lease_lost',
  'audit_export_not_claimable',
  'projection_revision_stale',
  'directory_org_context_mismatch',
  'content_store_unavailable',
]);

// ---------------------------------------------------------------------------
// Observability names (D6 telemetry contract is the source of truth)
// ---------------------------------------------------------------------------

export interface JobMetrics {
  readonly job: BackgroundJobName;
  readonly orgId?: string;
}

/** Metric families each job must emit; names must exist in
 *  work-r0a-ops-2026-10-25/telemetry-contract.json (asserted by its tests). */
export const REQUIRED_JOB_METRICS: readonly string[] = Object.freeze([
  'work_background_job_last_success_seconds',
  'work_background_job_runs_total',
  'work_directory_projection_lag_seconds',
  'work_audit_export_backlog',
  'work_audit_export_backlog',
]);

/** Alert names DR3/ops review expects for these jobs. */
export const REQUIRED_JOB_ALERTS: readonly string[] = Object.freeze([
  'WorkBackgroundJobStale',
  'WorkBackgroundJobLeaseTakeovers',
  'WorkDirectoryProjectionStale',
  'WorkAuditExportBacklog',
  'WorkAuditExportFailureRatio',
  'WorkAuditExportSlow',
  'WorkAuditExportTokenFailureBurst',
  'WorkContentShredBacklog',
]);

/**
 * Work R0a RunWorkflow + Activity contract.
 *
 * Design-only types. No Temporal SDK import: the runtime implementation must
 * map these contracts onto the chosen Temporal SDK. All content remains in the
 * Content Store; workflow inputs/history carry IDs and hashes only.
 */

export type RunWorkflowVersion = 'r0a-v1';
export type IsoDateTime = string;
export type WaitReason = 'budget' | 'provider' | 'reconcile';
export type RunTerminal = 'succeeded' | 'failed' | 'canceled';
export type OperationOutcome = 'succeeded' | 'failed';
export type ErrorClass = 'domain_terminal' | 'domain_wait' | 'transient' | 'unknown';

export interface RunWorkflowInput {
  runId: string;
  taskId: string;
  orgId: string;
  workflowVersion: RunWorkflowVersion;
}

export interface RunWorkflowStatus {
  runId: string;
  state: 'queued' | 'active' | 'waiting' | 'cancel_requested' | 'succeeded' | 'failed' | 'canceled';
  waitReason: WaitReason | null;
  operationId: string | null;
  dispatchAttemptId: string | null;
  stepNo: number;
  lastErrorCode: string | null;
}

export interface CancelSignal {
  requestId: string;
  reason?: string;
}

export interface BudgetAvailableSignal {
  requestId: string;
  accountKey: string;
  periodId: string;
}

export interface ResumeSignal {
  requestId: string;
  reason: 'budget' | 'reconcile' | 'operator';
}

/** R0a golden path has no manual approval; kept for R0b/R2 compatibility. */
export interface ApprovalDecidedSignal {
  requestId: string;
  approvalId: string;
  decision: 'approved' | 'rejected';
  expectedRevision: number;
  paramsHash: string;
}

export interface PreparedRun {
  runId: string;
  taskId: string;
  orgId: string;
  snapshotId: string;
  fence: number;
  target: { kind: 'cloud'; profile: 'text-v1' };
  permissionMode: 'ask_each' | 'auto_readonly';
  priceVersion: string;
}

export interface BudgetReservation {
  reservationId: string;
  operationId: string;
  amountCents: number;
  currency: string;
  reservationSeq: number;
}

export interface DispatchPermit {
  operationId: string;
  dispatchAttemptId: string;
  fence: number;
  requestHash: string;
}

export interface ModelCallRequest {
  runId: string;
  taskId: string;
  orgId: string;
  operationId: string;
  dispatchAttemptId: string;
  fence: number;
  requestHash: string;
  stepNo: number;
  inputRef: string;
  checkpointRef: string | null;
  templateRef: string | null;
  outputFormat: 'markdown';
  priceVersion: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface ModelCallResult {
  contentRef: string;
  contentHash: string;
  bytes: number;
  mediaType: 'text/markdown';
  providerRequestId: string;
  usage: ModelUsage;
}

export interface ArtifactDraft {
  artifactId: string;
  versionNo: number;
  contentRef: string;
  contentHash: string;
  bytes: number;
  mediaType: 'text/markdown';
}

export interface FinishRunRequest {
  runId: string;
  orgId: string;
  outcome: RunTerminal;
  reason: string | null;
}

export interface ReconcileResolution {
  operationId: string;
  resolution: 'sent_succeeded' | 'not_sent' | 'unresolved';
  providerRequestId: string | null;
  billableCents: number;
  evidenceRef: string | null;
}

/**
 * Every activity is idempotent by `(runId, operationId/logicalKey, requestHash)`.
 * `invokeModel` is the only activity that may produce an external side effect;
 * after dispatch it must not be blindly retried.
 */
export interface RunActivities {
  prepareRun(input: RunWorkflowInput): Promise<PreparedRun>;
  acquireRun(runId: string, orgId: string): Promise<PreparedRun>;
  createModelOperation(
    runId: string,
    orgId: string,
    logicalKey: string,
    requestHash: string,
  ): Promise<{ operationId: string }>;
  authorizeOperation(
    operationId: string,
    orgId: string,
    policyEpoch: number,
  ): Promise<void>;
  reserveBudget(
    orgId: string,
    accountKey: string,
    periodId: string,
    operationId: string,
    amountCents: number,
  ): Promise<BudgetReservation>;
  claimDispatch(
    operationId: string,
    orgId: string,
    consumerId: string,
    fence: number,
  ): Promise<DispatchPermit | null>;
  invokeModel(request: ModelCallRequest): Promise<ModelCallResult>;
  finishOperation(
    operationId: string,
    orgId: string,
    outcome: OperationOutcome,
    providerRequestId: string | null,
    receiptRef: string | null,
  ): Promise<void>;
  settleBudget(
    reservationId: string,
    amountCents: number,
    priceVersion: string,
    usage: ModelUsage,
    settlementRevision: number,
  ): Promise<void>;
  publishArtifact(
    orgId: string,
    taskId: string,
    runId: string,
    logicalName: string,
    contentRef: string,
    contentHash: string,
    bytes: number,
    mediaType: 'text/markdown',
    provenance: Record<string, unknown>,
  ): Promise<ArtifactDraft>;
  finishRun(request: FinishRunRequest): Promise<void>;
  markOperationUnknown(operationId: string, orgId: string, reason: string): Promise<void>;
  cancelOperation(operationId: string, orgId: string, actorSubjectId: string, reason: string | null): Promise<void>;
  waitRun(runId: string, orgId: string, reason: WaitReason): Promise<void>;
  resumeRun(runId: string, orgId: string): Promise<void>;
  reconcileOperation(resolution: ReconcileResolution): Promise<void>;
}

export interface ActivityPolicy {
  startToCloseTimeout: string;
  heartbeatTimeout?: string;
  scheduleToCloseTimeout?: string;
  maximumAttempts: number;
  initialInterval: string;
  backoffCoefficient: number;
  nonRetryableErrorTypes: readonly string[];
}

export const WORKFLOW_DEFAULTS = {
  workflowVersion: 'r0a-v1',
  workflowIdPrefix: 'run:',
  runTimeout: '30 minutes',
  modelActivityTimeout: '15 minutes',
  activityHeartbeat: '30 seconds',
  historyRetention: '7 days',
  maxRunBytes: 262144,
  maxModelOperations: 3,
  budgetWaitTimeout: '24 hours',
  outboxBacklogLimit: 1000,
  outboxOldestAge: '5 minutes',
} as const;

/** The workflow ID is stable per Run; retries use a new Run and a new ID. */
export function workflowIdForRun(runId: string): string {
  return `${WORKFLOW_DEFAULTS.workflowIdPrefix}${runId}`;
}

export const ACTIVITY_POLICIES: Record<string, ActivityPolicy> = {
  prepareRun: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_found', 'run_not_current', 'snapshot_not_in_task'],
  },
  acquireRun: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_found', 'run_not_current', 'run_not_queued'],
  },
  createModelOperation: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_accepting_operations', 'operation_key_conflict', 'scope_unavailable'],
  },
  authorizeOperation: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['approval_required', 'operation_not_authorizable'],
  },
  reserveBudget: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['budget_exhausted', 'operation_not_reservable'],
  },
  claimDispatch: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_current', 'run_not_active'],
  },
  invokeModel: {
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '30 seconds',
    scheduleToCloseTimeout: '15 minutes',
    maximumAttempts: 1,
    initialInterval: '1 second',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: ['provider_unknown', 'dispatch_not_won'],
  },
  finishOperation: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['operation_not_dispatching'],
  },
  settleBudget: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['settlement_revision_not_monotonic', 'settlement_out_of_bounds'],
  },
  publishArtifact: {
    startToCloseTimeout: '30 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_accepting_artifacts', 'artifact_deleted', 'invalid_artifact'],
  },
  finishRun: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['run_not_current', 'canceled_task_cannot_succeed'],
  },
  markOperationUnknown: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [],
  },
  cancelOperation: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [],
  },
  waitRun: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [],
  },
  resumeRun: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [],
  },
  reconcileOperation: {
    startToCloseTimeout: '10 seconds',
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['operation_not_reconcilable'],
  },
};

export const ERROR_CLASSIFICATION: Record<string, ErrorClass> = {
  run_not_found: 'domain_terminal',
  run_not_current: 'domain_terminal',
  run_not_queued: 'domain_terminal',
  run_not_accepting_operations: 'domain_terminal',
  operation_key_conflict: 'domain_terminal',
  operation_not_authorizable: 'domain_terminal',
  operation_not_dispatching: 'domain_terminal',
  operation_not_reconcilable: 'domain_terminal',
  approval_required: 'domain_wait',
  budget_exhausted: 'domain_wait',
  run_not_accepting_artifacts: 'domain_terminal',
  artifact_deleted: 'domain_terminal',
  settlement_revision_not_monotonic: 'domain_terminal',
  settlement_out_of_bounds: 'domain_terminal',
  provider_timeout_after_dispatch: 'unknown',
  network_reset_after_dispatch: 'unknown',
  receipt_lost: 'unknown',
  db_unavailable: 'transient',
  temporal_unavailable: 'transient',
  content_store_unavailable: 'transient',
  provider_rate_limited: 'transient',
  provider_5xx: 'transient',
};

export const OUTBOX_AGGREGATE_TYPES = {
  taskEvent: 'task',
  workflowStart: 'run',
} as const;

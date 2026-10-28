// Phase 0 wire-contract draft; no Temporal SDK dependency or runtime implementation.
export const RUNTIME_CONTRACT_VERSION = 'work-runtime-fragment-v1' as const;
export type DecimalFence = string;
export type Sha256 = `sha256:${string}`;
export type ModelLogicalKey = 'model:1' | 'model:2' | 'model:3';

export interface StoredReference {
  refId: string;
  hash: Sha256;
}

export interface ModelIntent {
  request: StoredReference;
  requestHash: Sha256;
  logicalKey: ModelLogicalKey;
}

export interface FragmentPermit {
  operationId: string;
  dispatchAttemptId: string;
  requestHash: Sha256;
}

interface FragmentInputBase {
  kind: 'advance_request';
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  executionId: string;
  runId: string;
  taskId: string;
  orgId: string;
  snapshotId: string;
  runtimeVersion: string;
  fence: DecimalFence;
  deadlineUnixMs: number;
}

export type AdvanceRuntimeRequest = FragmentInputBase & (
  | { mode: 'plan'; checkpoint: StoredReference | null; intent: null; permit: null }
  | { mode: 'execute'; checkpoint: StoredReference; intent: ModelIntent; permit: FragmentPermit }
);

interface FragmentResultBase {
  kind: 'advance_result';
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  executionId: string;
}

export type AdvanceRuntimeResult = FragmentResultBase & (
  | { state: 'MODEL_REQUEST'; checkpoint: StoredReference; intent: ModelIntent }
  | { state: 'CHECKPOINTED'; checkpoint: StoredReference; receipt: StoredReference }
  | {
      state: 'WAITING_RECONCILE';
      checkpoint: StoredReference | null;
      operationId: string;
      reason: 'provider_unknown' | 'receipt_unavailable';
    }
  | { state: 'FINISHED'; checkpoint: StoredReference; artifact: StoredReference }
  | {
      state: 'FAILED';
      checkpoint: StoredReference | null;
      reason: 'invalid_context' | 'checkpoint_failed' | 'runtime_fault' | 'deadline_exceeded';
    }
  | { state: 'CANCELED'; checkpoint: StoredReference | null; reason: 'cancel_requested' }
);

export interface RuntimeHeartbeat {
  kind: 'runtime_heartbeat';
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  executionId: string;
  sequence: number;
  phase: 'starting' | 'planning' | 'executing' | 'persisting' | 'stopping';
}

export interface RuntimeCancel {
  kind: 'runtime_cancel';
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  executionId: string;
  reason: 'cancel_requested' | 'deadline_exceeded' | 'worker_shutdown';
}

export interface RuntimeActivities {
  advanceRuntime(request: AdvanceRuntimeRequest): Promise<AdvanceRuntimeResult>;
}

export const RUNTIME_ACTIVITY_DRAFT = {
  contractVersion: RUNTIME_CONTRACT_VERSION,
  taskQueue: 'work-r0a-runtime',
  activityType: 'advanceRuntime',
  maximumAttempts: 1,
  startToCloseTimeoutMs: 960_000,
  scheduleToCloseTimeoutMs: 1_020_000,
  heartbeatTimeoutMs: 30_000,
  childHeartbeatIntervalMs: 10_000,
  cancelGraceMs: 5_000,
  maxWireBytes: 16_384,
  maxModelOperationsPerRun: 3,
  maxModelOperationsPerFragment: 1,
  evidence: 'schema_only',
  approval: 'design_signed',
} as const;

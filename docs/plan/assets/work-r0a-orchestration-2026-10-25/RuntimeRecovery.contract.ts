// Content Store design objects, not Temporal payloads or implemented database commands.
import type { ModelIntent, ModelLogicalKey, StoredReference } from './AdvanceRuntime.contract.js';

export interface RecoveryBinding {
  orgId: string;
  taskId: string;
  runId: string;
  snapshotId: string;
  runtimeVersion: string;
}

export interface ModelRequestDocument {
  kind: 'model_request';
  schemaVersion: 'work-model-request-v1';
  binding: RecoveryBinding;
  logicalKey: ModelLogicalKey;
  input: StoredReference;
  template: StoredReference | null;
  priorReceipts: StoredReference[];
  route: {
    provider: 'aliyun' | 'deepseek' | 'volcengine';
    model: string;
    configRevision: string;
    compatProfileVersion: string;
  };
  parameters: {
    maxOutputTokens: number;
    temperatureMilli: number;
    outputFormat: 'markdown';
  };
}

export interface CompletedModel {
  logicalKey: ModelLogicalKey;
  requestHash: `sha256:${string}`;
  receipt: StoredReference;
}

interface CanonicalStateBase {
  kind: 'canonical_state';
  schemaVersion: 'work-canonical-v1';
  binding: RecoveryBinding;
  revision: number;
  previous: StoredReference | null;
  writerExecutionId: string;
  input: StoredReference;
  template: StoredReference | null;
  completedModels: CompletedModel[];
}

export type CanonicalState = CanonicalStateBase & (
  | { phase: 'ready'; pending: null; artifact: null }
  | { phase: 'awaiting_model'; pending: ModelIntent; artifact: null }
  | { phase: 'finished'; pending: null; artifact: StoredReference }
);

export type ReceiptUsage =
  | { source: 'provider' | 'gateway_estimate'; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { source: 'unavailable'; inputTokens: null; outputTokens: null; cachedInputTokens: null };

interface ReceiptBase {
  kind: 'model_receipt';
  schemaVersion: 'work-model-receipt-v1';
  receiptId: string;
  binding: RecoveryBinding;
  logicalKey: ModelLogicalKey;
  operationId: string;
  dispatchAttemptId: string;
  executionId: string;
  requestHash: `sha256:${string}`;
  writerGatewayId: string;
  recordedAtUnixMs: number;
}

export type ModelReceipt = ReceiptBase & (
  | {
      outcome: 'succeeded';
      providerRequestId: string | null;
      content: StoredReference;
      contentBytes: number;
      usage: ReceiptUsage;
      rejectionEvidence: null;
    }
  | {
      outcome: 'rejected_not_executed';
      providerRequestId: string | null;
      content: null;
      contentBytes: 0;
      usage: { source: 'provider'; inputTokens: 0; outputTokens: 0; cachedInputTokens: 0 };
      rejectionEvidence: StoredReference;
    }
);

export const RECOVERY_DESIGN = {
  approval: 'design_signed',
  evidence: 'schema_and_pure_model_only',
  maxDocumentBytes: 262_144,
  maxModelOperations: 3,
  requestHashDomain: 'work-model-request-v1\n',
  checkpointHashDomain: 'work-canonical-v1\n',
  receiptHashDomain: 'work-model-receipt-v1\n',
} as const;

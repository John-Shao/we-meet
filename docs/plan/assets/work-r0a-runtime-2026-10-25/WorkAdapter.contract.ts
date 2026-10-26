/**
 * Work R0a Work Adapter contract.
 *
 * Design-only types. The adapter is the only side-effect boundary between the
 * Pi agent-core and the outside world. It must not access PostgreSQL, KMS or
 * provider keys directly; content goes through scoped Content Store handles.
 */

export type SourceLabel = 'user_input' | 'system_template';
export type PermissionMode = 'ask_each' | 'auto_readonly';
export type IsoDateTime = string;
export type MediaType = 'text/markdown' | 'application/json';

export interface RunContext {
  runId: string;
  taskId: string;
  orgId: string;
  snapshotId: string;
  inputRef: string;
  templateRef: string | null;
  permissionMode: PermissionMode;
  toolAllowlist: readonly ToolId[];
  modelRoute: { provider: string; model: string };
  priceVersion: string;
  deadlineAt: IsoDateTime;
  stepLimit: number;
}

export type ToolId = 'model_call' | 'read_builtin_template' | 'write_artifact_draft';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  sourceLabel: SourceLabel;
}

export interface ModelCallRequest {
  operationId: string;
  dispatchAttemptId: string;
  fence: number;
  requestHash: string;
  stepNo: number;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  priceVersion: string;
}

export interface Usage {
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
  usage: Usage;
  finishReason: 'stop' | 'length' | 'content_filter';
}

export interface TemplateReadRequest {
  templateId: string;
  version: number;
}

export interface TemplateReadResult {
  templateId: string;
  version: number;
  content: string;
  contentHash: string;
}

export interface ArtifactDraftRequest {
  logicalName: string;
  content: string;
  mediaType: MediaType;
  stepNo: number;
}

export interface ArtifactDraftResult {
  contentRef: string;
  contentHash: string;
  bytes: number;
  mediaType: MediaType;
}

export interface CheckpointRequest {
  stepNo: number;
  state: string;
  contentHash: string;
  bytes: number;
}

export interface CheckpointResult {
  stateRef: string;
  contentHash: string;
  bytes: number;
}

export interface UsageReport {
  operationId: string;
  providerRequestId: string;
  usage: Usage;
  priceVersion: string;
}

export type AdapterErrorCode =
  | 'tool_not_allowed'
  | 'source_label_unavailable'
  | 'secret_detected'
  | 'egress_policy_denied'
  | 'request_binding_mismatch'
  | 'provider_timeout'
  | 'provider_unknown'
  | 'provider_rate_limited'
  | 'content_too_large'
  | 'checkpoint_failed'
  | 'canceled'
  | 'sandbox_violation';

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * The adapter never returns raw reasoning. `modelCall` returns only the public
 * answer content reference and usage; the worker/egress owns provider auth.
 */
export interface WorkAdapter {
  getRunContext(): Promise<RunContext>;
  modelCall(request: ModelCallRequest): Promise<ModelCallResult>;
  readBuiltinTemplate(request: TemplateReadRequest): Promise<TemplateReadResult>;
  writeArtifactDraft(request: ArtifactDraftRequest): Promise<ArtifactDraftResult>;
  checkpoint(request: CheckpointRequest): Promise<CheckpointResult>;
  reportUsage(report: UsageReport): Promise<void>;
  onCancel(requestId: string, reason: string | null): Promise<void>;
}

export const R0A_TOOL_IDS: readonly ToolId[] = [
  'model_call',
  'read_builtin_template',
  'write_artifact_draft',
] as const;

export const R0A_SOURCE_LABELS: readonly SourceLabel[] = ['user_input', 'system_template'] as const;

export const ADAPTER_ERRORS = {
  tool_not_allowed: { retryable: false },
  source_label_unavailable: { retryable: false },
  secret_detected: { retryable: false },
  egress_policy_denied: { retryable: false },
  request_binding_mismatch: { retryable: false },
  provider_timeout: { retryable: false },
  provider_unknown: { retryable: false },
  provider_rate_limited: { retryable: true },
  content_too_large: { retryable: false },
  checkpoint_failed: { retryable: true },
  canceled: { retryable: false },
  sandbox_violation: { retryable: false },
} as const;

import type {
  DeviceModelBinding,
  ExecutionProfile,
  ModelProbeStatus,
} from "./driver";

export type {
  DeviceModelBinding,
  ExecutionProfile,
  ModelProbeStatus,
} from "./driver";

export interface StagedLocalInput {
  localInputRef: string;
  contentHash: string;
  byteCount: number;
}

export interface LocalSubmissionInput {
  clientRequestId: string;
  inputRef: string;
  inputHash: string;
  previewHash: string;
  targetSelectionHash: string;
  selectedGrantIds: string[];
  grantRevisions: string[];
  profileId: string;
  profileRevision: number;
  profileHash: string;
  artifactClassificationFloor: "local_only" | "remote_excerpt_allowed";
  availableDestinations: string[];
}

export interface LocalSubmissionConfirmation extends LocalSubmissionInput {
  authEpoch: string;
}

export interface LocalIntentProof {
  v: number;
  orgId: string;
  subjectId: string;
  authPlane: "bearer";
  authEpoch: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  inputHash: string;
  previewHash: string;
  targetSelectionHash: string;
  selectedGrantIds: string[];
  grantRevisions: string[];
  profileId: string;
  profileRevision: string;
  profileHash: string;
  nonce: string;
  expiresAt: string;
  signature: string;
}

export type LocalSubmissionResult =
  | { status: "ready"; localIntent: LocalIntentProof }
  | { status: "unavailable" | "canceled" };

export type LocalContentKind =
  "approval" | "run_transcript" | "artifact_version" | "artifact_edit";

export type LocalContentResult =
  | { status: "opened" | "denied" | "not_on_this_device" }
  | {
      status: "available";
      format: "text/plain" | "text/markdown";
      text: string;
      contentHash: string;
      byteCount: number;
    };

export interface PendingLocalApproval {
  approvalId: string;
  taskId: string;
  runId: string;
  operationId: string;
  actionKind: string;
  risk: string;
  expiresAt: string;
}

export type LocalApprovalListResult =
  | { status: "available"; approvals: PendingLocalApproval[] }
  | { status: "not_on_this_device" | "denied"; approvals: [] };

export interface LocalArtifactEditContext {
  artifactId: string;
  taskId: string;
  baseVersionId: string;
  baseVersionNo: number;
  baseHash: string;
}

export interface LocalArtifactEditDraft {
  requestId: string;
  versionId: string;
  contentHash: string;
  byteCount: number;
  baseByteCount: number;
}

export interface LocalArtifactDraft {
  requestId: string;
  versionId: string;
  artifactId: string;
  taskId: string;
  baseVersionId: string;
  baseVersionNo: number;
  baseHash: string;
  format: "text/plain" | "text/markdown";
  contentHash: string;
  byteCount: number;
  baseByteCount: number;
  publishState: "pending_confirm" | "pending_publish" | "expired";
  createdAt: number;
  clipboardDerived: boolean;
  clipboardSourceVersionIds: string[];
}

export interface LocalArtifactPublication {
  requestId: string;
  versionId: string;
  artifactId: string;
  deviceId: string;
  sessionId: string;
  localRef: string;
  contentHash: string;
  byteCount: number;
  proof: Record<string, unknown>;
  signature: string;
}

export interface PublishedLocalArtifact {
  versionId: string;
  versionNo: number;
  publishAck: string;
  replayed: boolean;
}

export interface LocalArtifactAcceptanceContext {
  taskId: string;
  artifactId: string;
  versionId: string;
  contentHash: string;
  revision: number;
}

export interface LocalArtifactAcceptance {
  acceptanceId: string;
  taskId: string;
  artifactId: string;
  versionNo: number;
  revision: number;
  replayed: boolean;
}

export interface WorkspaceGrantSummary {
  grantId: string;
  rootIdentityHash: string;
  artifactDir: string[];
  classification: "local_only" | "remote_excerpt_allowed";
}

export interface WorkspaceRebindConfirmation {
  runId: string;
  oldGrantId: string;
  newGrantId: string;
  rootIdentityHash: string;
}

export interface WorkspaceRebindResult {
  runId: string;
  oldGrantId: string;
  newGrantId: string;
  bindingRevision: number;
  state: string;
  invalidatedReadonlyGrants: number;
  replayed: boolean;
}

export interface LocalTaskSubmission {
  clientRequestId: string;
  inputRef: string;
  inputHash: string;
  inputBytes: number;
  title: string;
  templateId: string;
  templateVersion: number;
  permissionMode: "ask_each" | "auto_readonly";
  outputFormat: "text/plain" | "text/markdown";
  selectedGrantIds: string[];
}

export interface LocalTaskSubmissionResult {
  taskId: string;
  runId: string;
  revision: number;
  bindingRevision: number;
  taskState: string;
  displayState: string;
  inputRef: string;
}

export interface WorkBridge {
  getActiveExecutionProfile(profileId: string): Promise<ExecutionProfile>;
  getCurrentSessionId(): Promise<string>;
  createDeviceModelBinding(
    profileId: string,
    port: number,
    sessionId: string,
  ): Promise<DeviceModelBinding>;
  getModelProbe(probeId: string): Promise<ModelProbeStatus>;
  stageLocalInput(text: string): Promise<StagedLocalInput>;
  submitLocalTask(
    input: LocalTaskSubmission,
  ): Promise<LocalTaskSubmissionResult>;
  confirmLocalSubmission(
    input: LocalSubmissionInput,
  ): Promise<LocalSubmissionResult>;
  listPendingLocalApprovals(): Promise<LocalApprovalListResult>;
  openLocalContent(
    kind: LocalContentKind,
    id: string,
  ): Promise<LocalContentResult>;
  editLocalArtifact(
    context: LocalArtifactEditContext,
  ): Promise<LocalContentResult>;
  listLocalArtifactDrafts(
    taskId: string,
    artifactId: string,
  ): Promise<LocalArtifactDraft[]>;
  openLocalArtifactDraft(
    taskId: string,
    artifactId: string,
    versionId: string,
  ): Promise<LocalContentResult>;
  acceptLocalArtifactVersion(
    context: LocalArtifactAcceptanceContext,
  ): Promise<{ status: "opened" | "denied" | "not_on_this_device" }>;
  grantWorkspace(artifactDir: string[]): Promise<WorkspaceGrantSummary | null>;
  rebindRunWorkspace(
    runId: string,
    oldGrantId: string,
    newGrantId: string,
  ): Promise<
    | { status: "accepted"; rebound: WorkspaceRebindResult }
    | { status: "denied" | "not_on_this_device" }
  >;
  listWorkspaceGrants(): Promise<WorkspaceGrantSummary[]>;
  onArtifactPublished(
    callback: (published: PublishedLocalArtifact) => void,
  ): () => void;
  onApprovalDecided(
    callback: (decided: { approvalId: string; runId: string }) => void,
  ): () => void;
  onArtifactAccepted(
    callback: (accepted: LocalArtifactAcceptance) => void,
  ): () => void;
  onWorkspaceRebound(
    callback: (rebound: WorkspaceRebindResult) => void,
  ): () => void;
}

/** The §2.1 pairing/certificate/ticket/renewal driver (M2 ruling 甲2). REST stays in this main
 * process; the Broker signs and reports over the pipe. The state machine is deliberately linear:
 *
 *   identity → (stored record ? re-deliver : dialog-confirm → pair → sign → confirm → deliver)
 *   → poll status → renewal window open ? renew : awaiting_ticket ? mint + deliver
 *
 * The certificate is persisted through DeviceStore (safeStorage) and re-delivered on every
 * Broker start, which is what closes the GW21 in-memory-store × 0058 renewal-window restart
 * deadlock. The device-name confirmation gesture is the SHELL's main-process dialog (M2 ruling),
 * not a Broker native dialog and not a renderer call — §1.1's deviation is registered in place.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkApi, WorkApiError, type WorkAuth } from "./api";
import { BrokerPipe, BrokerPipeError, type BrokerReply } from "./pipe";
import { BrokerSupervisor, type WorkDeviceDescriptor } from "./broker";
import { DeviceStore, type DeviceRecord } from "./store";
import type {
  LocalArtifactDraft,
  LocalArtifactAcceptance,
  LocalArtifactAcceptanceContext,
  LocalArtifactEditContext,
  LocalArtifactEditDraft,
  LocalArtifactPublication,
  LocalContentKind,
  LocalContentResult,
  LocalIntentProof,
  LocalSubmissionConfirmation,
  LocalSubmissionInput,
  LocalSubmissionResult,
  LocalTaskSubmission,
  LocalTaskSubmissionResult,
  PublishedLocalArtifact,
  StagedLocalInput,
  WorkspaceGrantSummary,
  WorkspaceRebindConfirmation,
  WorkspaceRebindResult,
} from "./bridge";

export interface WorkConfig {
  /** https://host:port of the device gateway's mTLS listener. */
  gatewayOrigin: string;
  /** Name verified against the gateway's server certificate. */
  serverName: string;
  /** Absolute path to the device CA root PEM the Broker anchors on. */
  caPemPath: string;
}
export interface BrokerConfigFile {
  pipe_name: string;
  shell_pid: number;
  endpoint: string;
  server_name: string;
  ca_pem_path: string;
  container: string;
  provider: string;
  boot_id: string;
  agent_instance_id: string;
  journal_dir: string;
  profile_id: string;
  tool_manifest_hash: string;
  runtime_digest: string;
  last_receipt_seq: number;
  connect_timeout_ms: number;
  reconnect_base_ms: number;
  reconnect_max_ms: number;
}
export interface BrokerHandle {
  pipe: Pick<BrokerPipe, "call" | "close">;
  stop(): Promise<unknown>;
}
export type BrokerFactory = (
  config: BrokerConfigFile,
  configPath: string,
) => Promise<BrokerHandle>;
export interface DriverDeps {
  auth: WorkAuth;
  api: WorkApi;
  work: WorkConfig;
  binding: { issuer: string; clientId: string; serviceOrigin: string };
  resourceRoot: string;
  descriptor?: WorkDeviceDescriptor | null;
  configDir: string;
  store: DeviceStore;
  /** The main-process device-name gesture. undefined = the user cancelled; no pairing happens. */
  askDeviceName(defaultName: string): Promise<string | undefined>;
  /** The main-process system folder selector (§1.1: only the main process may trigger it; the
   * renderer's path string is never the root). undefined = the user cancelled; no grant happens. */
  selectWorkspaceDirectory(): Promise<string | undefined>;
  /** The main-process §4.2 root confirmation dialog. false = cancel (the Broker closes the handle,
   * no grant). The facts carry the actual location + the two warnings. */
  confirmWorkspaceRoot(facts: WorkspaceConfirmation): Promise<boolean>;
  confirmWorkspaceRebind(facts: WorkspaceRebindConfirmation): Promise<boolean>;
  /** The main-process §5.4 model identity confirmation dialog. false = cancel (no binding). */
  confirmLocalModel(facts: ModelConfirmation): Promise<boolean>;
  confirmLocalSubmission(facts: LocalSubmissionConfirmation): Promise<boolean>;
  report(message: string): void;
  brokerFactory?: BrokerFactory;
  pollIntervalMs?: number;
}
export type DriverState =
  "idle" | "starting" | "running" | "stopped" | "failed";

export interface LocalApprovalReadonlyScope {
  toolSet: string[];
  resourceSelectorHash: string;
  grantId: string;
  grantRevision: string;
}

export interface LocalApprovalDestinationFacts {
  localOnlyTaint: boolean;
  currentActionTaints: boolean;
  availableDestinations: string[];
}

export interface LocalApprovalDetail {
  approvalId: string;
  operationId: string;
  paramsHash: string;
  expectedRevision: number;
  policyEpoch: number;
  accessEpoch: number;
  deviceId: string;
  actionKind: string;
  status: string;
  readonlyScope: LocalApprovalReadonlyScope | null;
  destinationFacts: LocalApprovalDestinationFacts;
}

export interface PendingLocalApproval {
  approvalId: string;
  taskId: string;
  runId: string;
  operationId: string;
  actionKind: string;
  risk: string;
  expiresAt: string;
}

export interface LocalApprovalDecisionResult {
  approvalId: string;
  operationId: string;
  decision: "approved" | "rejected";
  approvalRevision: number;
  readonlyGrantId: string | null;
  runId: string;
  replayed: boolean;
}

/** The §4.2 root-acquisition confirmation facts the Broker returns on `chooseWorkspace` (prepare).
 * The dialog renders the ACTUAL location the Broker opened, not the selector path; the two warnings
 * (location differs / other users can write) are the §4.2 step 3/5 gestures. Metadata only, no body. */
export interface WorkspaceConfirmation {
  confirmationToken: string;
  selectedPath: string;
  actualLocation: string;
  volumeLabel: string;
  differsFromSelected: boolean;
  otherUserWritable: boolean;
  rootIdentityHash: string;
  deviceId: string;
  sessionId: string;
}
/** The §5.4 listener-identity confirmation facts the Broker returns on `probeLocalModel` (prepare).
 * The dialog renders process name / path / signer / running account; ownerSid is hex (rendered as a
 * name by the shell). Metadata only, no body. */
export interface ModelConfirmation {
  confirmationToken: string;
  processName: string;
  imagePath: string;
  signerThumbprint: string | null;
  ownerSid: string;
  imageSha256: string;
  listensOnAllInterfaces: boolean;
}
/** The org profile's §5.4 endpoint_policy listener_requirement (three-empty cannot publish). */
export interface ListenerRequirement {
  allowedSigners: string[];
  allowUserPinnedHash: boolean;
  allowedServiceSids: string[];
}

const PROVIDER = "Microsoft Software Key Storage Provider";
// 批2-5 (execution-face §6.4/§6.5, E3 乙): the two digest placeholders are gone. profile_id /
// tool_manifest_hash / runtime_digest are read from the shipped dev fixture profile, whose hashes are
// computed from the bundle's signed bytes (device-bundle/build-manifest.mjs) and re-verified by the
// Broker before spawn (src/device/src/digest.rs). The real ExecutionProfile publish face + binding
// verified path stay M4/M5; this period drives the evidence Run with the dev fixture profile.

/** boot_id derives from the OS boot identity (device-design §2.2): the boot instant computed
 * from the monotonic uptime, quantized to the minute so broker restarts within one OS boot
 * agree. The authoritative OS power/session watcher is a registered deferred item. */
export function bootId(
  nowMs: number = Date.now(),
  uptimeSeconds: number = os.uptime(),
): string {
  return `boot-${Math.floor((nowMs - uptimeSeconds * 1000) / 60000)}`;
}
export function containerFor(
  binding: { issuer: string; clientId: string; serviceOrigin: string },
  subject: string,
): string {
  return (
    "work-device-" +
    createHash("sha256")
      .update(
        `${binding.issuer}|${binding.clientId}|${binding.serviceOrigin}|${subject}`,
      )
      .digest("hex")
      .slice(0, 40)
  );
}

/** Parse the Broker's closed chooseWorkspace facts. The shell validates the shape it renders rather
 * than trusting arbitrary keys; a missing/wrong-typed field is a shape refusal, never a silent UI. */
function workspaceFacts(
  data: Record<string, unknown> | undefined,
): WorkspaceConfirmation {
  const d = data ?? {};
  const str = (k: string) => {
    const v = d[k];
    if (typeof v !== "string") throw new BrokerPipeError("shape");
    return v;
  };
  const bool = (k: string) => {
    const v = d[k];
    if (typeof v !== "boolean") throw new BrokerPipeError("shape");
    return v;
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const rootIdentityHash = str("root_identity_hash");
  const deviceId = str("device_id");
  const sessionId = str("session_id");
  if (
    !/^sha256:[0-9a-f]{64}$/.test(rootIdentityHash) ||
    !uuid.test(deviceId) ||
    !uuid.test(sessionId)
  ) {
    throw new BrokerPipeError("shape");
  }
  return {
    confirmationToken: str("confirmation_token"),
    selectedPath: str("selected_path"),
    actualLocation: str("actual_location"),
    volumeLabel: str("volume_label"),
    differsFromSelected: bool("differs_from_selected"),
    otherUserWritable: bool("other_user_writable"),
    rootIdentityHash,
    deviceId,
    sessionId,
  };
}
/** Parse the Broker's closed probeLocalModel facts (signer_thumbprint may be null). */
function modelFacts(
  data: Record<string, unknown> | undefined,
): ModelConfirmation {
  const d = data ?? {};
  const str = (k: string) => {
    const v = d[k];
    if (typeof v !== "string") throw new BrokerPipeError("shape");
    return v;
  };
  const bool = (k: string) => {
    const v = d[k];
    if (typeof v !== "boolean") throw new BrokerPipeError("shape");
    return v;
  };
  const signer = d.signer_thumbprint;
  if (signer !== null && typeof signer !== "string")
    throw new BrokerPipeError("shape");
  return {
    confirmationToken: str("confirmation_token"),
    processName: str("process_name"),
    imagePath: str("image_path"),
    signerThumbprint: signer,
    ownerSid: str("owner_sid"),
    imageSha256: str("image_sha256"),
    listensOnAllInterfaces: bool("listens_on_all_interfaces"),
  };
}

function previewAuthEpoch(previewHash: string): string {
  const payload = previewHash.startsWith("lp1.")
    ? previewHash.split(".")[1]
    : "";
  if (!payload) throw new BrokerPipeError("shape");
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const epoch = value?.auth_epoch;
    if (typeof epoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(epoch))
      throw new BrokerPipeError("shape");
    return epoch;
  } catch {
    throw new BrokerPipeError("shape");
  }
}

function parseLocalIntentProof(
  value: unknown,
  expected: LocalSubmissionInput,
  authEpoch: string,
): LocalIntentProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerPipeError("shape");
  }
  const d = value as Record<string, unknown>;
  const keys =
    "auth_epoch,auth_plane,device_id,expires_at,grant_revisions,input_hash,nonce,org_id,preview_hash,profile_hash,profile_id,profile_revision,request_id,selected_grant_ids,session_id,signature,subject_id,target_selection_hash,v";
  if (Object.keys(d).sort().join(",") !== keys)
    throw new BrokerPipeError("shape");
  const str = (key: string) => {
    const field = d[key];
    if (typeof field !== "string") throw new BrokerPipeError("shape");
    return field;
  };
  const strings = (key: string) => {
    const field = d[key];
    if (
      !Array.isArray(field) ||
      !field.every((item) => typeof item === "string")
    ) {
      throw new BrokerPipeError("shape");
    }
    return [...field] as string[];
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const selectedGrantIds = strings("selected_grant_ids");
  const grantRevisions = strings("grant_revisions");
  const same = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((item, index) => item === right[index]);
  const orgId = str("org_id");
  const subjectId = str("subject_id");
  const expiresAt = str("expires_at");
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (
    d.v !== 1 ||
    orgId.length === 0 ||
    orgId.length > 256 ||
    /[\x00-\x1f\x7f]/.test(orgId) ||
    subjectId.length === 0 ||
    subjectId.length > 256 ||
    /[\x00-\x1f\x7f]/.test(subjectId) ||
    str("auth_plane") !== "bearer" ||
    str("auth_epoch") !== authEpoch ||
    !uuid.test(str("device_id")) ||
    !uuid.test(str("session_id")) ||
    str("request_id") !== expected.clientRequestId ||
    str("input_hash") !== expected.inputHash.slice("sha256:".length) ||
    str("preview_hash") !== expected.previewHash ||
    str("target_selection_hash") !== expected.targetSelectionHash ||
    !same(selectedGrantIds, expected.selectedGrantIds) ||
    !same(grantRevisions, expected.grantRevisions) ||
    str("profile_id") !== expected.profileId ||
    str("profile_revision") !== String(expected.profileRevision) ||
    str("profile_hash") !== expected.profileHash ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(str("nonce")) ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
      expiresAt,
    ) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + 65_000 ||
    !/^[A-Za-z0-9_-]{86}$/.test(str("signature"))
  ) {
    throw new BrokerPipeError("shape");
  }
  return {
    v: 1,
    orgId,
    subjectId,
    authPlane: "bearer",
    authEpoch,
    deviceId: str("device_id"),
    sessionId: str("session_id"),
    requestId: str("request_id"),
    inputHash: str("input_hash"),
    previewHash: str("preview_hash"),
    targetSelectionHash: str("target_selection_hash"),
    selectedGrantIds,
    grantRevisions,
    profileId: str("profile_id"),
    profileRevision: str("profile_revision"),
    profileHash: str("profile_hash"),
    nonce: str("nonce"),
    expiresAt,
    signature: str("signature"),
  };
}

async function defaultBrokerFactory(
  resourceRoot: string,
  descriptor: WorkDeviceDescriptor | null | undefined,
): Promise<BrokerFactory> {
  return async (config, configPath) => {
    const supervisor = new BrokerSupervisor();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await supervisor.start(
      resourceRoot,
      configPath,
      config.pipe_name,
      descriptor,
    );
    const pipe = await BrokerPipe.connect(config.pipe_name);
    return {
      pipe,
      stop: async () => {
        pipe.close();
        await supervisor.stop();
      },
    };
  };
}

export class WorkDeviceDriver {
  private state: DriverState = "idle";
  private broker?: BrokerHandle;
  private record?: DeviceRecord;
  private thumbprint = "";
  private orgId = "";
  private subject = "";
  // The Host-verified auth_epoch (session revision) every local proof signs. It is NOT
  // auth.epoch (the local login generation): only the verified claims carry the server's
  // value, so it comes from the identity face at start and never from local state.
  private hostEpoch = "";
  private container = "";
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private epoch = -1;
  private factory?: BrokerFactory;
  private readonly pollIntervalMs: number;
  private readonly localGrants = new Map<
    string,
    { deviceId: string; sessionId: string; revision: string }
  >();

  constructor(private readonly deps: DriverDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 10000;
  }
  get currentState(): DriverState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "running") return;
    if (
      process.platform !== "win32" ||
      process.arch !== "x64" ||
      !this.deps.auth.signedIn
    ) {
      this.state = "idle";
      return;
    }
    this.state = "starting";
    this.epoch = this.deps.auth.epoch;
    try {
      const identity = await this.deps.api.request<{
        org_id: string;
        subject_id: string;
        auth_plane: string;
        auth_epoch: string;
      }>("identity");
      this.checkEpoch();
      if (
        typeof identity.auth_plane !== "string" ||
        identity.auth_plane !== "bearer" ||
        typeof identity.auth_epoch !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(identity.auth_epoch)
      ) {
        throw new WorkApiError("work_identity_invalid");
      }
      this.orgId = identity.org_id;
      this.subject = identity.subject_id;
      this.hostEpoch = identity.auth_epoch;
      if (this.deps.auth.subject && this.subject !== this.deps.auth.subject) {
        throw new WorkApiError("work_account_changed");
      }
      this.container = containerFor(this.deps.binding, this.subject);
      const stored = this.deps.store.load();
      this.record =
        stored &&
        stored.container === this.container &&
        stored.orgId === this.orgId
          ? stored
          : undefined;

      const config = this.buildConfig();
      const configPath = path.join(this.deps.configDir, "broker.json");
      this.factory ??=
        this.deps.brokerFactory ??
        (await defaultBrokerFactory(
          this.deps.resourceRoot,
          this.deps.descriptor,
        ));
      this.broker = await this.factory(config, configPath);
      this.checkEpoch();
      const facts = await this.call("getDeviceIdentity");
      this.thumbprint = String(facts.data?.public_key_thumbprint ?? "");
      if (!this.thumbprint) throw new BrokerPipeError("shape");

      if (this.record) {
        try {
          // A fresh Broker has no signing history, so the stored chain goes through the
          // re-delivery carrier with the record's org declared explicitly (M2b ruling 甲).
          await this.redeliver(
            this.record.deviceId,
            this.record.certificatePem,
            this.record.orgId,
            this.record.subject,
          );
        } catch (error) {
          // An expired or foreign chain cannot be re-delivered; the renewal face is the
          // re-issuance path (0058 ruling ②). Anything else is fatal for this record.
          if (
            error instanceof BrokerPipeError &&
            error.code === "certificate_invalid"
          ) {
            await this.renew();
          } else {
            this.deps.store.clear();
            this.record = undefined;
            throw error;
          }
        }
      } else {
        const paired = await this.pair();
        if (!paired) {
          // The user cancelled the name gesture: no pairing row exists, so there is nothing to
          // run. This is a choice, not a failure — no error is reported.
          await this.teardown();
          this.state = "idle";
          return;
        }
      }
      this.checkEpoch();
      this.state = "running";
      this.timer = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
    } catch (error) {
      await this.teardown();
      this.state = "failed";
      this.deps.report(this.failureMessage(error));
    }
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.state = "stopped";
  }

  /** Acquire a server-issued grant and register the same id with the Broker's held root handle. */
  async grantWorkspace(
    artifactDir: string[],
  ): Promise<{ grantId: string; rootIdentityHash: string } | undefined> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      this.state !== "running" ||
      artifactDir.length > 64 ||
      !artifactDir.every(
        (segment) =>
          typeof segment === "string" &&
          segment.length > 0 &&
          segment.length <= 128 &&
          !segment.includes("/") &&
          !segment.includes("\\") &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\0"),
      )
    ) {
      throw new BrokerPipeError("shape");
    }
    const selectedPath = await this.deps.selectWorkspaceDirectory();
    this.checkEpoch();
    if (!selectedPath) return undefined;
    const prepared = await this.call("chooseWorkspace", {
      selected_path: selectedPath,
    });
    const facts = workspaceFacts(prepared.data);
    this.checkEpoch();
    const approved = await this.deps.confirmWorkspaceRoot(facts);
    this.checkEpoch();
    if (!approved) {
      await this.call("confirmWorkspaceRoot", {
        confirmation_token: facts.confirmationToken,
        grant_id: randomUUID(),
        artifact_dir: artifactDir,
        approved: false,
      });
      return undefined;
    }
    const registered = await this.deps.api.request<{
      grant_id: string;
      root_ref: string;
      grant_revision: number | string;
      state: string;
      replayed: boolean;
    }>("registerWorkspaceGrant", {
      body: {
        device_id: facts.deviceId,
        session_id: facts.sessionId,
        client_request_id: randomUUID(),
        grant: {
          root_identity_hash: facts.rootIdentityHash.slice("sha256:".length),
          allowed_tools: [
            "workspace.list",
            "workspace.read",
            "workspace.search",
            "artifact.write",
          ],
          matched_rule_index: 0,
          user_selected_ttl_seconds: 28800,
        },
      },
    });
    this.checkEpoch();
    if (
      typeof registered.grant_id !== "string" ||
      !uuid.test(registered.grant_id) ||
      typeof registered.root_ref !== "string" ||
      !uuid.test(registered.root_ref) ||
      !/^(0|[1-9][0-9]*)$/.test(String(registered.grant_revision)) ||
      registered.state !== "active" ||
      typeof registered.replayed !== "boolean"
    ) {
      throw new BrokerPipeError("shape");
    }
    const confirmed = await this.call("confirmWorkspaceRoot", {
      confirmation_token: facts.confirmationToken,
      grant_id: registered.grant_id,
      artifact_dir: artifactDir,
      approved: true,
    });
    this.checkEpoch();
    const data = confirmed.data ?? {};
    if (
      Object.keys(data).sort().join(",") !== "grant_id,root_identity_hash" ||
      data.grant_id !== registered.grant_id ||
      data.root_identity_hash !== facts.rootIdentityHash
    ) {
      throw new BrokerPipeError("shape");
    }
    this.localGrants.set(registered.grant_id, {
      deviceId: facts.deviceId,
      sessionId: facts.sessionId,
      revision: String(registered.grant_revision),
    });
    return {
      grantId: registered.grant_id,
      rootIdentityHash: facts.rootIdentityHash,
    };
  }

  async submitLocalTask(
    input: LocalTaskSubmission,
  ): Promise<LocalTaskSubmissionResult> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const request = /^[^\s\x00-\x1f\x7f]{8,128}$/;
    if (
      this.state !== "running" ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "clientRequestId,inputBytes,inputHash,inputRef,outputFormat,permissionMode,selectedGrantIds,templateId,templateVersion,title" ||
      typeof input.clientRequestId !== "string" ||
      !request.test(input.clientRequestId) ||
      typeof input.inputRef !== "string" ||
      !uuid.test(input.inputRef) ||
      typeof input.inputHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.inputHash) ||
      !Number.isSafeInteger(input.inputBytes) ||
      input.inputBytes < 1 ||
      input.inputBytes > 60 * 1024 ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.trim() !== input.title ||
      Array.from(input.title).length > 80 ||
      typeof input.templateId !== "string" ||
      input.templateId.length === 0 ||
      input.templateId.length > 128 ||
      !Number.isSafeInteger(input.templateVersion) ||
      input.templateVersion < 1 ||
      !["ask_each", "auto_readonly"].includes(input.permissionMode) ||
      !["text/plain", "text/markdown"].includes(input.outputFormat) ||
      !Array.isArray(input.selectedGrantIds) ||
      input.selectedGrantIds.length < 1 ||
      input.selectedGrantIds.length > 4 ||
      new Set(input.selectedGrantIds).size !== input.selectedGrantIds.length ||
      !input.selectedGrantIds.every(
        (id) =>
          typeof id === "string" && uuid.test(id) && this.localGrants.has(id),
      )
    ) {
      throw new BrokerPipeError("shape");
    }
    const grants = input.selectedGrantIds.map((id) =>
      this.localGrants.get(id)!,
    );
    const deviceId = grants[0].deviceId;
    const sessionId = grants[0].sessionId;
    if (
      !grants.every(
        (grant) => grant.deviceId === deviceId && grant.sessionId === sessionId,
      )
    ) {
      throw new BrokerPipeError("shape");
    }
    const profile = this.readBundleProfile();
    const targetSelection = {
      kind: "local",
      profile_id: profile.profile_id,
      profile_revision: String(profile.profile_revision),
      profile_hash: profile.profile_hash,
      device_id: deviceId,
      session_id: sessionId,
      workspace_grants: input.selectedGrantIds.map((id, index) => ({
        grant_id: id,
        grant_revision: grants[index].revision,
      })),
      runtime_digest: profile.runtime_digest,
      tool_manifest_hash: profile.tool_manifest_hash,
      model_version: profile.model_version,
    };
    this.checkEpoch();
    const preview = await this.deps.api.request<{
      preview_hash: string;
      target_selection_hash: string;
      artifact_classification_floor: "local_only" | "remote_excerpt_allowed";
      available_destinations: string[];
    }>("createLocalTaskPreview", {
      body: {
        client_request_id: randomUUID(),
        input_ref: input.inputRef,
        input_hash: input.inputHash.slice("sha256:".length),
        input_bytes: input.inputBytes,
        target_selection: targetSelection,
        template_id: input.templateId,
        template_version: input.templateVersion,
        permission_mode: input.permissionMode,
        output_format: input.outputFormat,
      },
    });
    this.checkEpoch();
    if (
      typeof preview.preview_hash !== "string" ||
      !/^[A-Za-z0-9._:-]{1,4096}$/.test(preview.preview_hash) ||
      typeof preview.target_selection_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(preview.target_selection_hash) ||
      !["local_only", "remote_excerpt_allowed"].includes(
        preview.artifact_classification_floor,
      ) ||
      !Array.isArray(preview.available_destinations) ||
      preview.available_destinations.length > 3 ||
      !preview.available_destinations.every(
        (value) =>
          typeof value === "string" &&
          ["device_local", "org_private", "org_remote"].includes(value),
      ) ||
      new Set(preview.available_destinations).size !==
        preview.available_destinations.length
    ) {
      throw new BrokerPipeError("shape");
    }
    const confirmation = await this.confirmLocalSubmission({
      clientRequestId: input.clientRequestId,
      inputRef: input.inputRef,
      inputHash: input.inputHash,
      previewHash: preview.preview_hash,
      targetSelectionHash: preview.target_selection_hash,
      selectedGrantIds: input.selectedGrantIds,
      grantRevisions: grants.map((grant) => grant.revision),
      profileId: profile.profile_id,
      profileRevision: profile.profile_revision,
      profileHash: profile.profile_hash,
      artifactClassificationFloor: preview.artifact_classification_floor,
      availableDestinations: preview.available_destinations,
    });
    this.checkEpoch();
    if (confirmation.status !== "ready") {
      throw new BrokerPipeError("shape");
    }
    const proof = confirmation.localIntent;
    const localIntent = {
      v: proof.v,
      org_id: proof.orgId,
      subject_id: proof.subjectId,
      auth_plane: proof.authPlane,
      auth_epoch: proof.authEpoch,
      device_id: proof.deviceId,
      session_id: proof.sessionId,
      request_id: proof.requestId,
      input_hash: proof.inputHash,
      preview_hash: proof.previewHash,
      target_selection_hash: proof.targetSelectionHash,
      selected_grant_ids: proof.selectedGrantIds,
      grant_revisions: proof.grantRevisions,
      profile_id: proof.profileId,
      profile_revision: proof.profileRevision,
      profile_hash: proof.profileHash,
      nonce: proof.nonce,
      expires_at: proof.expiresAt,
      signature: proof.signature,
    };
    const result = await this.deps.api.request<{
      task_id: string;
      run_id: string;
      revision: number;
      binding_revision: number;
      task_state: string;
      display_state: string;
      input_ref: string;
    }>("submitLocalTask", {
      body: {
        client_request_id: input.clientRequestId,
        input_ref: input.inputRef,
        input_hash: input.inputHash.slice("sha256:".length),
        input_bytes: input.inputBytes,
        preview_hash: preview.preview_hash,
        target_selection_hash: preview.target_selection_hash,
        title: input.title,
        target_selection: targetSelection,
        local_intent: localIntent,
      },
    });
    this.checkEpoch();
    if (
      !uuid.test(result.task_id) ||
      !uuid.test(result.run_id) ||
      !Number.isSafeInteger(result.revision) ||
      !Number.isSafeInteger(result.binding_revision) ||
      result.task_state !== "open" ||
      result.display_state !== "queued" ||
      result.input_ref !== input.inputRef
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      taskId: result.task_id,
      runId: result.run_id,
      revision: result.revision,
      bindingRevision: result.binding_revision,
      taskState: result.task_state,
      displayState: result.display_state,
      inputRef: result.input_ref,
    };
  }

  async confirmLocalSubmission(
    input: LocalSubmissionInput,
  ): Promise<LocalSubmissionResult> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const digest = /^[0-9a-f]{64}$/;
    const uint = /^(0|[1-9][0-9]*)$/;
    const request = /^[^\s\x00-\x1f\x7f]{8,128}$/;
    if (
      this.state !== "running" ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "artifactClassificationFloor,availableDestinations,clientRequestId,grantRevisions,inputHash,inputRef,previewHash,profileHash,profileId,profileRevision,selectedGrantIds,targetSelectionHash" ||
      typeof input.clientRequestId !== "string" ||
      !request.test(input.clientRequestId) ||
      typeof input.inputRef !== "string" ||
      !uuid.test(input.inputRef) ||
      typeof input.inputHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.inputHash) ||
      typeof input.previewHash !== "string" ||
      !/^[A-Za-z0-9._:-]{1,4096}$/.test(input.previewHash) ||
      typeof input.targetSelectionHash !== "string" ||
      !digest.test(input.targetSelectionHash) ||
      !Array.isArray(input.selectedGrantIds) ||
      input.selectedGrantIds.length < 1 ||
      input.selectedGrantIds.length > 4 ||
      !input.selectedGrantIds.every(
        (value) => typeof value === "string" && uuid.test(value),
      ) ||
      new Set(input.selectedGrantIds).size !== input.selectedGrantIds.length ||
      !Array.isArray(input.grantRevisions) ||
      input.grantRevisions.length !== input.selectedGrantIds.length ||
      !input.grantRevisions.every(
        (value) => typeof value === "string" && uint.test(value),
      ) ||
      typeof input.profileId !== "string" ||
      input.profileId.length === 0 ||
      input.profileId.length > 128 ||
      /[\x00-\x1f\x7f]/.test(input.profileId) ||
      !Number.isSafeInteger(input.profileRevision) ||
      input.profileRevision < 0 ||
      typeof input.profileHash !== "string" ||
      !digest.test(input.profileHash) ||
      !["local_only", "remote_excerpt_allowed"].includes(
        input.artifactClassificationFloor,
      ) ||
      !Array.isArray(input.availableDestinations) ||
      input.availableDestinations.length > 3 ||
      !input.availableDestinations.every(
        (value) =>
          typeof value === "string" &&
          ["device_local", "org_private", "org_remote"].includes(value),
      ) ||
      new Set(input.availableDestinations).size !==
        input.availableDestinations.length
    ) {
      throw new BrokerPipeError("shape");
    }
    const authEpoch = previewAuthEpoch(input.previewHash);
    if (!uint.test(authEpoch)) throw new BrokerPipeError("shape");
    const facts: LocalSubmissionConfirmation = { ...input, authEpoch };
    this.checkEpoch();
    const approved = await this.deps.confirmLocalSubmission(facts);
    this.checkEpoch();
    const reply = await this.call("confirmLocalSubmission", {
      approved,
      client_request_id: input.clientRequestId,
      input_ref: input.inputRef,
      input_hash: input.inputHash.slice("sha256:".length),
      preview_hash: input.previewHash,
      target_selection_hash: input.targetSelectionHash,
      selected_grant_ids: input.selectedGrantIds,
      grant_revisions: input.grantRevisions,
      profile_id: input.profileId,
      profile_revision: String(input.profileRevision),
      profile_hash: input.profileHash,
      auth_epoch: authEpoch,
    });
    this.checkEpoch();
    const data = reply.data;
    if (data === undefined) return { status: "canceled" };
    if (Object.keys(data).length === 1 && data.status === "unavailable") {
      return { status: "unavailable" };
    }
    if (
      Object.keys(data).sort().join(",") !== "local_intent,status" ||
      data.status !== "ready"
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      status: "ready",
      localIntent: parseLocalIntentProof(data.local_intent, input, authEpoch),
    };
  }

  async listWorkspaceGrants(): Promise<WorkspaceGrantSummary[]> {
    if (this.state !== "running") throw new BrokerPipeError("shape");
    this.checkEpoch();
    const reply = await this.call("listWorkspaceGrants");
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !== "grants,status" ||
      data.status !== "available" ||
      !Array.isArray(data.grants) ||
      data.grants.length > 128
    ) {
      throw new BrokerPipeError("shape");
    }
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const seen = new Set<string>();
    return data.grants
      .filter(
        (grant) =>
          grant &&
          typeof grant === "object" &&
          !Array.isArray(grant) &&
          typeof grant.grant_id === "string" &&
          this.localGrants.has(grant.grant_id),
      )
      .map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new BrokerPipeError("shape");
        const grant = value as Record<string, unknown>;
        if (
          Object.keys(grant).sort().join(",") !==
            "artifact_dir,grant_id,root_identity_hash" ||
          typeof grant.grant_id !== "string" ||
          !uuid.test(grant.grant_id) ||
          seen.has(grant.grant_id) ||
          typeof grant.root_identity_hash !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(grant.root_identity_hash) ||
          !Array.isArray(grant.artifact_dir) ||
          grant.artifact_dir.length > 64 ||
          !grant.artifact_dir.every(
            (segment) =>
              typeof segment === "string" &&
              segment.length > 0 &&
              segment.length <= 128 &&
              !segment.includes("/") &&
              !segment.includes("\\") &&
              segment !== "." &&
              segment !== ".." &&
              !segment.includes("\0"),
          )
        ) {
          throw new BrokerPipeError("shape");
        }
        seen.add(grant.grant_id);
        return {
          grantId: grant.grant_id,
          rootIdentityHash: grant.root_identity_hash,
          artifactDir: [...grant.artifact_dir] as string[],
        };
      });
  }

  async rebindRunWorkspace(
    runId: string,
    oldGrantId: string,
    newGrantId: string,
  ): Promise<WorkspaceRebindResult> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      this.state !== "running" ||
      !uuid.test(runId) ||
      !uuid.test(oldGrantId) ||
      !uuid.test(newGrantId) ||
      oldGrantId === newGrantId
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const reply = await this.call("rebindRunWorkspace", {
      run_id: runId,
      old_grant_id: oldGrantId,
      new_grant_id: newGrantId,
      auth_epoch: this.hostEpoch,
    });
    this.checkEpoch();
    const proof = reply.data ?? {};
    if (
      Object.keys(proof).sort().join(",") !==
        "auth_epoch,auth_plane,expires_at,new_grant_id,nonce,old_grant_id,root_identity_hash,run_id,session_id,signature" ||
      proof.old_grant_id !== oldGrantId ||
      proof.new_grant_id !== newGrantId ||
      proof.run_id !== runId ||
      proof.auth_plane !== "bearer" ||
      proof.auth_epoch !== this.hostEpoch ||
      typeof proof.root_identity_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(proof.root_identity_hash) ||
      typeof proof.session_id !== "string" ||
      !uuid.test(proof.session_id) ||
      typeof proof.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(proof.nonce) ||
      typeof proof.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(proof.signature) ||
      typeof proof.expires_at !== "string"
    ) {
      throw new BrokerPipeError("shape");
    }
    const expiry = Date.parse(proof.expires_at);
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 4 * 60_000 + 5_000
    ) {
      throw new BrokerPipeError("shape");
    }
    const approved = await this.deps.confirmWorkspaceRebind({
      runId,
      oldGrantId,
      newGrantId,
      rootIdentityHash: proof.root_identity_hash,
    });
    this.checkEpoch();
    if (!approved) throw new BrokerPipeError("cancelled");
    const requestId = randomUUID();
    const rebound = await this.deps.api.request<Record<string, unknown>>(
      "rebindRunWorkspace",
      {
        id: runId,
        body: {
          client_request_id: requestId,
          old_grant_id: oldGrantId,
          new_grant_id: newGrantId,
          grant_succession_proof: proof,
        },
      },
    );
    if (
      Object.keys(rebound).sort().join(",") !==
        "binding_revision,checkpoint_hash,checkpoint_seq,expected_checkpoint_hash,expected_checkpoint_seq,invalidated_readonly_grants,new_grant_id,offer_expiry,old_grant_id,replayed,run_id,state" ||
      rebound.run_id !== runId ||
      rebound.old_grant_id !== oldGrantId ||
      rebound.new_grant_id !== newGrantId ||
      rebound.state !== "active" ||
      !Number.isSafeInteger(rebound.binding_revision) ||
      Number(rebound.binding_revision) < 2 ||
      !Number.isSafeInteger(rebound.invalidated_readonly_grants) ||
      Number(rebound.invalidated_readonly_grants) < 0 ||
      typeof rebound.replayed !== "boolean" ||
      typeof rebound.offer_expiry !== "string" ||
      !Number.isFinite(Date.parse(rebound.offer_expiry))
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      runId,
      oldGrantId,
      newGrantId,
      bindingRevision: Number(rebound.binding_revision),
      state: "active",
      invalidatedReadonlyGrants: Number(rebound.invalidated_readonly_grants),
      replayed: rebound.replayed,
    };
  }

  /** The §5.4 model identity confirmation flow (批2 主签单选乙). probeLocalModel returns the listener
   * identity facts + token; the main process shows process name/path/signer/account; the decision
   * rides confirmLocalModel back with the org profile's listener_requirement. Cancel sends
   * approved:false (no binding). Returns the binding_hash, or undefined when the user cancelled. */
  async configureLocalModel(
    profileId: string,
    port: number,
    requirement: ListenerRequirement,
  ): Promise<{ profileId: string; bindingHash: string } | undefined> {
    const prepared = await this.call("probeLocalModel", { port: String(port) });
    const facts = modelFacts(prepared.data);
    this.checkEpoch();
    const approved = await this.deps.confirmLocalModel(facts);
    this.checkEpoch();
    const confirmed = await this.call("confirmLocalModel", {
      confirmation_token: facts.confirmationToken,
      profile_id: profileId,
      port: String(port),
      listener_requirement: {
        allowed_signers: requirement.allowedSigners,
        allow_user_pinned_hash: requirement.allowUserPinnedHash,
        allowed_service_sids: requirement.allowedServiceSids,
      },
      approved,
    });
    if (!approved) return undefined;
    const bindingHash = String(confirmed.data?.binding_hash ?? "");
    if (!bindingHash) throw new BrokerPipeError("shape");
    return { profileId, bindingHash };
  }

  async stageLocalInput(text: string): Promise<StagedLocalInput> {
    if (
      this.state !== "running" ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.includes("\x00") ||
      Buffer.byteLength(text, "utf8") > 60 * 1024
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const reply = await this.call("stageLocalInput", { text });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !==
      "byte_count,content_hash,local_input_ref"
    ) {
      throw new BrokerPipeError("shape");
    }
    const localInputRef = data.local_input_ref;
    const contentHash = data.content_hash;
    const byteCount = data.byte_count;
    if (
      typeof localInputRef !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        localInputRef,
      ) ||
      typeof contentHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(contentHash) ||
      typeof byteCount !== "string" ||
      !/^[1-9][0-9]*$/.test(byteCount) ||
      Number(byteCount) !== Buffer.byteLength(text, "utf8")
    ) {
      throw new BrokerPipeError("shape");
    }
    return { localInputRef, contentHash, byteCount: Number(byteCount) };
  }

  async openLocalContent(
    kind: LocalContentKind,
    id: string,
  ): Promise<LocalContentResult> {
    if (
      this.state !== "running" ||
      ![
        "approval",
        "run_transcript",
        "artifact_version",
        "artifact_edit",
      ].includes(kind) ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 512 ||
      id.includes("\x00")
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const reply = await this.call("openLocalContent", { kind, id });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).length === 1 &&
      data.status === "not_on_this_device"
    ) {
      return { status: "not_on_this_device" };
    }
    if (
      Object.keys(data).sort().join(",") !==
        "byte_count,content_hash,format,status,text" ||
      data.status !== "available" ||
      (data.format !== "text/plain" && data.format !== "text/markdown") ||
      typeof data.text !== "string" ||
      new TextEncoder().encode(data.text).length > 1024 * 1024 ||
      typeof data.content_hash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(data.content_hash) ||
      typeof data.byte_count !== "string" ||
      !/^[1-9][0-9]*$/.test(data.byte_count) ||
      Number(data.byte_count) !== Buffer.byteLength(data.text, "utf8")
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      status: "available",
      format: data.format,
      text: data.text,
      contentHash: data.content_hash,
      byteCount: Number(data.byte_count),
    };
  }

  async acceptLocalArtifactVersion(
    context: LocalArtifactAcceptanceContext,
  ): Promise<LocalArtifactAcceptance> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      this.state !== "running" ||
      !context ||
      !uuid.test(context.taskId) ||
      !uuid.test(context.artifactId) ||
      !uuid.test(context.versionId) ||
      typeof context.contentHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(context.contentHash) ||
      !Number.isSafeInteger(context.revision) ||
      context.revision < 0
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const requestId = randomUUID();
    const contentHash = context.contentHash.slice("sha256:".length);
    const reply = await this.call("prepareLocalAcceptance", {
      task_id: context.taskId,
      artifact_id: context.artifactId,
      version_id: context.versionId,
      content_hash: contentHash,
      request_id: requestId,
      auth_epoch: this.hostEpoch,
    });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !==
        "device_id,possession_proof,session_id,signature,status" ||
      data.status !== "ready" ||
      typeof data.device_id !== "string" ||
      !uuid.test(data.device_id) ||
      typeof data.session_id !== "string" ||
      !uuid.test(data.session_id) ||
      typeof data.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(data.signature) ||
      !data.possession_proof ||
      typeof data.possession_proof !== "object" ||
      Array.isArray(data.possession_proof)
    ) {
      throw new BrokerPipeError("shape");
    }
    const proof = data.possession_proof as Record<string, unknown>;
    const keys = Object.keys(proof).sort().join(",");
    if (
      keys !==
        "artifact_id,auth_epoch,auth_plane,content_hash,device_id,expires_at,nonce,org_id,purpose,request_id,session_id,subject_id,task_id,v,version_id" ||
      proof.v !== 1 ||
      typeof proof.org_id !== "string" ||
      proof.org_id.length === 0 ||
      proof.subject_id !== this.subject ||
      proof.auth_plane !== "bearer" ||
      proof.auth_epoch !== this.hostEpoch ||
      proof.device_id !== data.device_id ||
      proof.session_id !== data.session_id ||
      proof.task_id !== context.taskId ||
      proof.artifact_id !== context.artifactId ||
      proof.version_id !== context.versionId ||
      proof.content_hash !== contentHash ||
      proof.purpose !== "accept" ||
      proof.request_id !== requestId ||
      typeof proof.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(proof.nonce) ||
      typeof proof.expires_at !== "string"
    ) {
      throw new BrokerPipeError("shape");
    }
    const expiry = Date.parse(proof.expires_at);
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 35_000
    ) {
      throw new BrokerPipeError("shape");
    }
    const accepted = await this.deps.api.request<Record<string, unknown>>(
      "createLocalAcceptance",
      {
        id: context.taskId,
        signature: data.signature,
        body: {
          client_request_id: requestId,
          revision: context.revision,
          device_id: data.device_id,
          session_id: data.session_id,
          artifact_id: context.artifactId,
          possession_proof: proof,
        },
      },
    );
    if (
      Object.keys(accepted).sort().join(",") !==
        "acceptance_id,artifact_id,replayed,revision,task_id,version_no" ||
      typeof accepted.acceptance_id !== "string" ||
      !uuid.test(accepted.acceptance_id) ||
      accepted.task_id !== context.taskId ||
      accepted.artifact_id !== context.artifactId ||
      !Number.isSafeInteger(accepted.version_no) ||
      Number(accepted.version_no) < 1 ||
      !Number.isSafeInteger(accepted.revision) ||
      Number(accepted.revision) !== context.revision + 1 ||
      typeof accepted.replayed !== "boolean"
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      acceptanceId: accepted.acceptance_id,
      taskId: context.taskId,
      artifactId: context.artifactId,
      versionNo: Number(accepted.version_no),
      revision: Number(accepted.revision),
      replayed: accepted.replayed,
    };
  }

  async listPendingLocalApprovals(): Promise<PendingLocalApproval[]> {
    if (this.state !== "running") throw new BrokerPipeError("shape");
    const approvals: PendingLocalApproval[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const data = await this.deps.api.request<Record<string, unknown>>(
        "listApprovals",
        {
          query: {
            status: "pending",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        },
      );
      if (
        !Array.isArray(data.approvals) ||
        (data.next_cursor !== null && typeof data.next_cursor !== "string")
      ) {
        throw new BrokerPipeError("shape");
      }
      for (const value of data.approvals) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new BrokerPipeError("shape");
        const row = value as Record<string, unknown>;
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (
          typeof row.id !== "string" ||
          !uuid.test(row.id) ||
          seen.has(row.id) ||
          typeof row.task_id !== "string" ||
          !uuid.test(row.task_id) ||
          typeof row.run_id !== "string" ||
          !uuid.test(row.run_id) ||
          typeof row.operation_id !== "string" ||
          !uuid.test(row.operation_id) ||
          typeof row.action_kind !== "string" ||
          row.action_kind.length === 0 ||
          row.action_kind.length > 128 ||
          typeof row.risk !== "string" ||
          row.risk.length === 0 ||
          row.risk.length > 64 ||
          typeof row.expires_at !== "string" ||
          !Number.isFinite(Date.parse(row.expires_at)) ||
          row.status !== "pending"
        )
          throw new BrokerPipeError("shape");
        seen.add(row.id);
        approvals.push({
          approvalId: row.id,
          taskId: row.task_id,
          runId: row.run_id,
          operationId: row.operation_id,
          actionKind: row.action_kind,
          risk: row.risk,
          expiresAt: row.expires_at,
        });
      }
      const next = data.next_cursor as string | null;
      if (!next) return approvals;
      if (next.length > 2048 || seen.size > 10000 || cursors.has(next))
        throw new BrokerPipeError("shape");
      cursors.add(next);
      cursor = next;
    }
    throw new BrokerPipeError("shape");
  }

  async getLocalApproval(approvalId: string): Promise<LocalApprovalDetail> {
    if (
      this.state !== "running" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        approvalId,
      )
    ) {
      throw new BrokerPipeError("shape");
    }
    const data = await this.deps.api.request<Record<string, unknown>>(
      "getApproval",
      { id: approvalId },
    );
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      data.id !== approvalId ||
      typeof data.operation_id !== "string" ||
      !uuid.test(data.operation_id) ||
      typeof data.params_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.params_hash) ||
      typeof data.revision !== "number" ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      typeof data.policy_epoch !== "number" ||
      !Number.isSafeInteger(data.policy_epoch) ||
      data.policy_epoch < 0 ||
      typeof data.access_epoch !== "number" ||
      !Number.isSafeInteger(data.access_epoch) ||
      data.access_epoch < 0 ||
      typeof data.device_id !== "string" ||
      !uuid.test(data.device_id) ||
      typeof data.action_kind !== "string" ||
      data.status !== "pending"
    ) {
      throw new BrokerPipeError("shape");
    }
    const readonlyKind = [
      "workspace.list",
      "workspace.read",
      "workspace.search",
    ].includes(data.action_kind);
    let readonlyScope: LocalApprovalReadonlyScope | null = null;
    if (readonlyKind) {
      const scope = data.readonly_scope;
      if (
        !scope ||
        typeof scope !== "object" ||
        Array.isArray(scope) ||
        Object.keys(scope).sort().join(",") !==
          "grant_id,grant_revision,resource_selector_hash,tool_set"
      ) {
        throw new BrokerPipeError("shape");
      }
      const value = scope as Record<string, unknown>;
      if (
        !Array.isArray(value.tool_set) ||
        value.tool_set.length !== 1 ||
        value.tool_set[0] !== data.action_kind ||
        typeof value.resource_selector_hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.resource_selector_hash) ||
        typeof value.grant_id !== "string" ||
        !uuid.test(value.grant_id) ||
        typeof value.grant_revision !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(value.grant_revision)
      ) {
        throw new BrokerPipeError("shape");
      }
      readonlyScope = {
        toolSet: [data.action_kind],
        resourceSelectorHash: value.resource_selector_hash,
        grantId: value.grant_id,
        grantRevision: value.grant_revision,
      };
    } else if (data.readonly_scope !== null) {
      throw new BrokerPipeError("shape");
    }
    const destinationFacts = data.destination_facts;
    if (
      !destinationFacts ||
      typeof destinationFacts !== "object" ||
      Array.isArray(destinationFacts) ||
      Object.keys(destinationFacts).sort().join(",") !==
        "available_destinations,current_action_taints,local_only_taint"
    ) {
      throw new BrokerPipeError("shape");
    }
    const destinationValue = destinationFacts as Record<string, unknown>;
    if (
      typeof destinationValue.local_only_taint !== "boolean" ||
      typeof destinationValue.current_action_taints !== "boolean" ||
      !Array.isArray(destinationValue.available_destinations) ||
      destinationValue.available_destinations.length > 3 ||
      !destinationValue.available_destinations.every(
        (value) =>
          typeof value === "string" &&
          ["device_local", "org_private", "org_remote"].includes(value),
      ) ||
      new Set(destinationValue.available_destinations).size !==
        destinationValue.available_destinations.length
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      approvalId,
      operationId: data.operation_id,
      paramsHash: data.params_hash,
      expectedRevision: data.revision,
      policyEpoch: data.policy_epoch,
      accessEpoch: data.access_epoch,
      deviceId: data.device_id,
      actionKind: data.action_kind,
      status: data.status,
      readonlyScope,
      destinationFacts: {
        localOnlyTaint: destinationValue.local_only_taint,
        currentActionTaints: destinationValue.current_action_taints,
        availableDestinations:
          destinationValue.available_destinations as string[],
      },
    };
  }

  async decideLocalApproval(
    detail: LocalApprovalDetail,
    decision: "approved" | "rejected",
    requestId: string,
    rememberReadonly = false,
  ): Promise<LocalApprovalDecisionResult> {
    if (
      this.state !== "running" ||
      detail.status !== "pending" ||
      (rememberReadonly &&
        (decision !== "approved" || !detail.readonlyScope)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    ) {
      throw new BrokerPipeError("shape");
    }
    const readonlyScope =
      rememberReadonly && detail.readonlyScope
        ? {
            tool_set: detail.readonlyScope.toolSet,
            resource_selector_hash: detail.readonlyScope.resourceSelectorHash,
            grant_id: detail.readonlyScope.grantId,
            grant_revision: detail.readonlyScope.grantRevision,
          }
        : null;
    const readonlyExpiresAt = rememberReadonly
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : null;
    const reply = await this.call("prepareLocalApprovalDecision", {
      approval_id: detail.approvalId,
      operation_id: detail.operationId,
      params_hash: detail.paramsHash,
      expected_revision: String(detail.expectedRevision),
      decision,
      remember_readonly: rememberReadonly,
      readonly_scope: readonlyScope,
      readonly_expires_at: readonlyExpiresAt,
      policy_epoch: String(detail.policyEpoch),
      access_epoch: String(detail.accessEpoch),
      auth_epoch: this.hostEpoch,
    });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !== "approval_decision_proof,status" ||
      data.status !== "ready" ||
      !data.approval_decision_proof ||
      typeof data.approval_decision_proof !== "object" ||
      Array.isArray(data.approval_decision_proof)
    ) {
      throw new BrokerPipeError("shape");
    }
    const proof = data.approval_decision_proof as Record<string, unknown>;
    const proofKeys = [
      "v",
      "org_id",
      "subject_id",
      "auth_plane",
      "auth_epoch",
      "device_id",
      "session_id",
      "approval_id",
      "operation_id",
      "params_hash",
      "expected_revision",
      "decision",
      "remember_readonly",
      "readonly_scope",
      "readonly_expires_at",
      "policy_epoch",
      "access_epoch",
      "nonce",
      "expires_at",
      "signature",
    ];
    const proofScope = proof.readonly_scope;
    const proofScopeValue =
      proofScope && typeof proofScope === "object" && !Array.isArray(proofScope)
        ? (proofScope as Record<string, unknown>)
        : undefined;
    const proofScopeMatches = rememberReadonly
      ? !!proofScopeValue &&
        Object.keys(proofScopeValue).sort().join(",") ===
          "grant_id,grant_revision,resource_selector_hash,tool_set" &&
        Array.isArray(proofScopeValue.tool_set) &&
        proofScopeValue.tool_set.length === 1 &&
        proofScopeValue.tool_set[0] === detail.actionKind &&
        proofScopeValue.resource_selector_hash ===
          detail.readonlyScope?.resourceSelectorHash &&
        proofScopeValue.grant_id === detail.readonlyScope?.grantId &&
        proofScopeValue.grant_revision === detail.readonlyScope?.grantRevision
      : proofScope === null;
    if (
      Object.keys(proof).sort().join(",") !== proofKeys.sort().join(",") ||
      proof.v !== 1 ||
      proof.auth_plane !== "bearer" ||
      proof.auth_epoch !== this.hostEpoch ||
      proof.device_id !== detail.deviceId ||
      typeof proof.session_id !== "string" ||
      proof.approval_id !== detail.approvalId ||
      proof.operation_id !== detail.operationId ||
      proof.params_hash !== detail.paramsHash ||
      proof.expected_revision !== String(detail.expectedRevision) ||
      proof.decision !== decision ||
      proof.remember_readonly !== rememberReadonly ||
      !proofScopeMatches ||
      proof.readonly_expires_at !== readonlyExpiresAt ||
      proof.policy_epoch !== String(detail.policyEpoch) ||
      proof.access_epoch !== String(detail.accessEpoch) ||
      typeof proof.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(proof.nonce) ||
      typeof proof.expires_at !== "string" ||
      typeof proof.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)
    ) {
      throw new BrokerPipeError("shape");
    }
    const decided = await this.deps.api.request<Record<string, unknown>>(
      "decideApproval",
      {
        id: detail.approvalId,
        body: { client_request_id: requestId, decision: proof },
      },
    );
    if (
      decided.approval_id !== detail.approvalId ||
      decided.operation_id !== detail.operationId ||
      decided.decision !== decision ||
      typeof decided.approval_revision !== "number" ||
      !Number.isSafeInteger(decided.approval_revision) ||
      typeof decided.run_id !== "string" ||
      typeof decided.replayed !== "boolean" ||
      (decided.readonly_grant_id !== null &&
        typeof decided.readonly_grant_id !== "string")
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      approvalId: detail.approvalId,
      operationId: detail.operationId,
      decision,
      approvalRevision: decided.approval_revision,
      readonlyGrantId: decided.readonly_grant_id as string | null,
      runId: decided.run_id,
      replayed: decided.replayed,
    };
  }

  async editLocalArtifact(
    context: LocalArtifactEditContext,
  ): Promise<LocalContentResult> {
    this.validateEditContext(context);
    return this.openLocalContent("artifact_version", context.baseVersionId);
  }

  async listLocalArtifactDrafts(
    taskId: string,
    artifactId: string,
  ): Promise<LocalArtifactDraft[]> {
    if (this.state !== "running") throw new BrokerPipeError("shape");
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!uuid.test(taskId) || !uuid.test(artifactId))
      throw new BrokerPipeError("shape");
    this.checkEpoch();
    const reply = await this.call("listLocalArtifactDrafts", {
      task_id: taskId,
      artifact_id: artifactId,
    });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !== "items,status" ||
      data.status !== "available" ||
      !Array.isArray(data.items) ||
      data.items.length > 128
    )
      throw new BrokerPipeError("shape");
    return data.items.map((item) => this.parseLocalDraft(item));
  }

  async openLocalArtifactDraft(
    taskId: string,
    artifactId: string,
    versionId: string,
  ): Promise<
    | { status: "not_on_this_device" }
    | {
        status: "available";
        draft: LocalArtifactDraft;
        format: "text/plain" | "text/markdown";
        text: string;
      }
  > {
    const drafts = await this.listLocalArtifactDrafts(taskId, artifactId);
    const draft = drafts.find((item) => item.versionId === versionId);
    if (!draft) return { status: "not_on_this_device" };
    const content = await this.openLocalContent("artifact_edit", versionId);
    if (content.status !== "available") return { status: "not_on_this_device" };
    return {
      status: "available",
      draft,
      format: content.format,
      text: content.text,
    };
  }

  private parseLocalDraft(value: unknown): LocalArtifactDraft {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BrokerPipeError("shape");
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).sort().join(",") !==
        "artifact_id,base_byte_count,base_hash,base_version_id,base_version_no,byte_count,content_hash,created_at,format,publish_state,request_id,task_id,version_id" ||
      typeof data.request_id !== "string" ||
      typeof data.version_id !== "string" ||
      typeof data.artifact_id !== "string" ||
      typeof data.task_id !== "string" ||
      typeof data.base_version_id !== "string" ||
      typeof data.base_version_no !== "string" ||
      !/^[1-9][0-9]*$/.test(data.base_version_no) ||
      typeof data.base_hash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(data.base_hash) ||
      (data.format !== "text/plain" && data.format !== "text/markdown") ||
      typeof data.content_hash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(data.content_hash) ||
      typeof data.byte_count !== "string" ||
      !/^[1-9][0-9]*$/.test(data.byte_count) ||
      typeof data.base_byte_count !== "string" ||
      !/^[0-9]+$/.test(data.base_byte_count) ||
      (data.publish_state !== "pending_confirm" &&
        data.publish_state !== "pending_publish" &&
        data.publish_state !== "expired") ||
      typeof data.created_at !== "string" ||
      !/^[1-9][0-9]*$/.test(data.created_at)
    )
      throw new BrokerPipeError("shape");
    return {
      requestId: data.request_id,
      versionId: data.version_id,
      artifactId: data.artifact_id,
      taskId: data.task_id,
      baseVersionId: data.base_version_id,
      baseVersionNo: Number(data.base_version_no),
      baseHash: data.base_hash,
      format: data.format,
      contentHash: data.content_hash,
      byteCount: Number(data.byte_count),
      baseByteCount: Number(data.base_byte_count),
      publishState: data.publish_state,
      createdAt: Number(data.created_at),
    };
  }

  async prepareLocalArtifactEdit(input: {
    context: LocalArtifactEditContext;
    format: "text/plain" | "text/markdown";
    body: string;
  }): Promise<LocalArtifactEditDraft> {
    if (this.state !== "running") throw new BrokerPipeError("shape");
    this.validateEditContext(input.context);
    if (
      (input.format !== "text/plain" && input.format !== "text/markdown") ||
      typeof input.body !== "string" ||
      input.body.length === 0 ||
      input.body.includes("\x00") ||
      Buffer.byteLength(input.body, "utf8") > 1024 * 1024
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const contentHash = `sha256:${createHash("sha256").update(input.body, "utf8").digest("hex")}`;
    const requestId = randomUUID();
    const versionId = randomUUID();
    const reply = await this.call("prepareLocalArtifactEdit", {
      client_request_id: requestId,
      version_id: versionId,
      artifact_id: input.context.artifactId,
      task_id: input.context.taskId,
      base_version_no: String(input.context.baseVersionNo),
      base_version_id: input.context.baseVersionId,
      base_hash: input.context.baseHash,
      auth_epoch: this.hostEpoch,
      format: input.format,
      content_hash: contentHash,
      byte_count: String(Buffer.byteLength(input.body, "utf8")),
      body: input.body,
    });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !==
        "base_byte_count,byte_count,content_hash,request_id,status,version_id" ||
      data.status !== "pending_confirm" ||
      data.request_id !== requestId ||
      data.version_id !== versionId ||
      data.content_hash !== contentHash ||
      typeof data.byte_count !== "string" ||
      typeof data.base_byte_count !== "string" ||
      !/^[0-9]+$/.test(data.base_byte_count) ||
      Number(data.byte_count) !== Buffer.byteLength(input.body, "utf8")
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      requestId,
      versionId,
      contentHash,
      byteCount: Number(data.byte_count),
      baseByteCount: Number(data.base_byte_count),
    };
  }

  async confirmLocalArtifactEdit(
    requestId: string,
    sealedHash: string,
  ): Promise<PublishedLocalArtifact> {
    if (
      this.state !== "running" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(sealedHash)
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const reply = await this.call("decideLocalArtifactEdit", {
      draft_request_id: requestId,
      sealed_hash: sealedHash,
      action: "confirm",
    });
    this.checkEpoch();
    const data = reply.data ?? {};
    if (
      Object.keys(data).sort().join(",") !==
        "artifact_id,byte_count,content_hash,device_id,local_ref,request_id,session_id,signature,status,user_version_proof,version_id" ||
      (data.status !== "pending_publish" && data.status !== "published") ||
      data.request_id !== requestId ||
      data.content_hash !== sealedHash ||
      typeof data.version_id !== "string" ||
      typeof data.artifact_id !== "string" ||
      typeof data.device_id !== "string" ||
      typeof data.session_id !== "string" ||
      typeof data.local_ref !== "string" ||
      typeof data.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(data.signature) ||
      typeof data.byte_count !== "string" ||
      !/^[1-9][0-9]*$/.test(data.byte_count) ||
      !data.user_version_proof ||
      typeof data.user_version_proof !== "object" ||
      Array.isArray(data.user_version_proof)
    ) {
      throw new BrokerPipeError("shape");
    }
    const proof = data.user_version_proof as Record<string, unknown>;
    const proofKeys = [
      "v",
      "org_id",
      "subject_id",
      "auth_plane",
      "auth_epoch",
      "device_id",
      "session_id",
      "task_id",
      "artifact_id",
      "base_version_no",
      "base_hash",
      "version_id",
      "format",
      "content_hash",
      "bytes",
      "classification",
      "clipboard_derived",
      "clipboard_source_version_ids",
      "client_request_id",
      "nonce",
      "expires_at",
    ];
    if (
      Object.keys(proof).sort().join(",") !== proofKeys.sort().join(",") ||
      proof.v !== 1 ||
      proof.auth_plane !== "bearer" ||
      proof.auth_epoch !== this.hostEpoch ||
      proof.device_id !== data.device_id ||
      proof.session_id !== data.session_id ||
      proof.artifact_id !== data.artifact_id ||
      proof.version_id !== data.version_id ||
      proof.client_request_id !== requestId ||
      proof.content_hash !== sealedHash.slice("sha256:".length) ||
      proof.bytes !== Number(data.byte_count) ||
      proof.classification !== "local_only" ||
      proof.clipboard_derived !== false ||
      !Array.isArray(proof.clipboard_source_version_ids) ||
      proof.clipboard_source_version_ids.length !== 0 ||
      typeof proof.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(proof.nonce) ||
      typeof proof.expires_at !== "string"
    ) {
      throw new BrokerPipeError("shape");
    }
    const publication: LocalArtifactPublication = {
      requestId,
      versionId: data.version_id,
      artifactId: data.artifact_id,
      deviceId: data.device_id,
      sessionId: data.session_id,
      localRef: data.local_ref,
      contentHash: sealedHash,
      byteCount: Number(data.byte_count),
      proof,
      signature: data.signature,
    };
    const created = await this.deps.api.request<{
      version_id: string;
      version_no: number;
      publish_ack: string;
      replayed: boolean;
    }>("createLocalArtifactVersion", {
      id: publication.artifactId,
      signature: publication.signature,
      body: {
        kind: "local",
        client_request_id: publication.requestId,
        device_id: publication.deviceId,
        session_id: publication.sessionId,
        local_ref: publication.localRef,
        user_version_proof: publication.proof,
      },
    });
    if (
      created.version_id !== publication.versionId ||
      !Number.isSafeInteger(created.version_no) ||
      created.version_no < 2 ||
      typeof created.publish_ack !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(created.publish_ack) ||
      typeof created.replayed !== "boolean"
    ) {
      throw new BrokerPipeError("shape");
    }
    const completed = await this.call("completeLocalArtifactEdit", {
      draft_request_id: requestId,
      sealed_hash: sealedHash,
      publish_ack: created.publish_ack,
    });
    if (
      Object.keys(completed.data ?? {}).join(",") !== "status" ||
      completed.data?.status !== "published"
    ) {
      throw new BrokerPipeError("shape");
    }
    return {
      versionId: created.version_id,
      versionNo: created.version_no,
      publishAck: created.publish_ack,
      replayed: created.replayed,
    };
  }

  async decideLocalArtifactEdit(
    requestId: string,
    sealedHash: string,
    action: "discard" | "cancel",
  ): Promise<"pending_confirm" | "discarded" | "not_on_this_device"> {
    if (
      this.state !== "running" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(sealedHash) ||
      (action !== "discard" && action !== "cancel")
    ) {
      throw new BrokerPipeError("shape");
    }
    this.checkEpoch();
    const reply = await this.call("decideLocalArtifactEdit", {
      draft_request_id: requestId,
      sealed_hash: sealedHash,
      action,
    });
    const data = reply.data ?? {};
    if (
      Object.keys(data).length === 1 &&
      data.status === "not_on_this_device"
    ) {
      return "not_on_this_device";
    }
    if (
      Object.keys(data).sort().join(",") !==
        "content_hash,request_id,status,version_id" ||
      data.request_id !== requestId ||
      data.content_hash !== sealedHash ||
      (data.status !== "pending_confirm" && data.status !== "discarded")
    ) {
      throw new BrokerPipeError("shape");
    }
    return data.status;
  }

  private validateEditContext(context: LocalArtifactEditContext): void {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (
      !context ||
      !uuid.test(context.artifactId) ||
      !uuid.test(context.taskId) ||
      !uuid.test(context.baseVersionId) ||
      !Number.isSafeInteger(context.baseVersionNo) ||
      context.baseVersionNo < 1 ||
      typeof context.baseHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(context.baseHash)
    ) {
      throw new BrokerPipeError("shape");
    }
  }

  private async teardown() {
    this.localGrants.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const broker = this.broker;
    this.broker = undefined;
    if (broker) {
      try {
        broker.pipe.close();
      } catch {
        /* already gone */
      }
      await broker.stop().catch(() => undefined);
    }
  }

  private buildConfig(): BrokerConfigFile {
    const profile = this.readBundleProfile();
    return {
      pipe_name: `\\\\.\\pipe\\work-device-${randomUUID()}`,
      shell_pid: process.pid,
      endpoint: this.deps.work.gatewayOrigin,
      server_name: this.deps.work.serverName,
      ca_pem_path: this.deps.work.caPemPath,
      container: this.container,
      provider: PROVIDER,
      boot_id: bootId(),
      agent_instance_id: randomUUID(),
      // The Broker owns the journal epoch (device_meta); the shell only provides a stable base
      // directory under its per-user config dir. The Broker forms <journal_dir>/<device_id>.db
      // once the certificate reveals the device id, so a restart recovers the same epoch.
      journal_dir: path.join(this.deps.configDir, "journal"),
      profile_id: profile.profile_id,
      tool_manifest_hash: profile.tool_manifest_hash,
      runtime_digest: profile.runtime_digest,
      last_receipt_seq: 0,
      connect_timeout_ms: 10000,
      reconnect_base_ms: 1000,
      reconnect_max_ms: 30000,
    };
  }

  /** Read the shipped dev fixture profile (execution-face §6.5). The bundle is staged next to the
   * Broker executable as `work-device-bundle/` (the layout main.rs spawns from); its profile carries
   * the two hashes computed from the signed bundle bytes. A missing/invalid profile is a hard failure
   * — the shell never falls back to a placeholder digest the Broker would refuse at spawn. */
  private readBundleProfile(): {
    profile_id: string;
    profile_revision: number;
    profile_hash: string;
    tool_manifest_hash: string;
    runtime_digest: string;
    model_version: string;
  } {
    const profilePath = path.join(
      this.deps.resourceRoot,
      "work-device-bundle",
      "dev-fixture-profile.json",
    );
    let raw: string;
    try {
      raw = readFileSync(profilePath, "utf8");
    } catch {
      throw new Error("work_device_bundle_profile_missing");
    }
    let parsed: {
      profile_id?: unknown;
      config_revision?: unknown;
      model_route?: { config_revision?: unknown; model?: unknown };
      tool_manifest_hash?: unknown;
      runtime_digest?: unknown;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("work_device_bundle_profile_invalid");
    }
    const hex = (v: unknown): v is string =>
      typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const profileRevision = parsed.model_route?.config_revision;
    if (
      typeof parsed.profile_id !== "string" ||
      !parsed.profile_id ||
      !Number.isSafeInteger(profileRevision) ||
      (profileRevision as number) < 1 ||
      typeof parsed.model_route?.model !== "string" ||
      !parsed.model_route.model ||
      parsed.model_route.model.length > 128 ||
      !hex(parsed.tool_manifest_hash) ||
      !hex(parsed.runtime_digest)
    ) {
      throw new Error("work_device_bundle_profile_invalid");
    }
    return {
      profile_id: parsed.profile_id,
      profile_revision: profileRevision as number,
      profile_hash: createHash("sha256").update(raw).digest("hex"),
      tool_manifest_hash: parsed.tool_manifest_hash,
      runtime_digest: parsed.runtime_digest,
      model_version: parsed.model_route.model,
    };
  }

  private async pair(): Promise<boolean> {
    const defaultName = `${os.hostname().slice(0, 100)}`;
    // §2.1 step 2: the user explicitly confirms the device name BEFORE any pairing request.
    // A cancelled dialog leaves zero rows behind — the gesture is the authorization.
    const name = await this.deps.askDeviceName(defaultName);
    this.checkEpoch();
    if (!name || !name.trim()) return false;
    const identity = await this.call("getDeviceIdentity");
    const jwk = identity.data?.public_key_jwk;
    if (!jwk || typeof jwk !== "object") throw new BrokerPipeError("shape");
    const pairing = await this.deps.api.request<{
      pairing_id: string;
      challenge: string;
      device_id: string;
    }>("pair", {
      body: {
        client_request_id: randomUUID(),
        device_name: name.trim().slice(0, 120),
        platform: "windows-x64",
        public_key_jwk: jwk,
      },
    });
    this.checkEpoch();
    const signed = await this.call("signDevicePairing", {
      pairing_id: pairing.pairing_id,
      challenge: pairing.challenge,
      org_id: this.orgId,
      subject_id: this.subject,
    });
    const confirmed = await this.deps.api.request<{
      device_id: string;
      certificate_pem: string;
      cert_serial: string;
      cert_not_after: string;
    }>("confirmPairing", {
      id: pairing.pairing_id,
      body: {
        client_request_id: randomUUID(),
        challenge: pairing.challenge,
        signature: String(signed.data?.signature ?? ""),
      },
    });
    this.checkEpoch();
    await this.deliver(confirmed.device_id, confirmed.certificate_pem);
    this.record = {
      ...this.deps.binding,
      subject: this.subject,
      orgId: this.orgId,
      deviceId: confirmed.device_id,
      container: this.container,
      certificatePem: confirmed.certificate_pem,
      certSerial: confirmed.cert_serial,
      certNotAfter: confirmed.cert_not_after,
    };
    this.deps.store.save(this.record);
    return true;
  }

  private async renew(): Promise<void> {
    if (!this.record) throw new BrokerPipeError("no_pairing");
    const challenge = await this.deps.api.request<{
      pairing_id: string;
      challenge: string;
    }>("requestRenewal", {
      id: this.record.deviceId,
      body: { client_request_id: randomUUID() },
    });
    this.checkEpoch();
    const signed = await this.call("signDeviceCertificateRenewal", {
      pairing_id: challenge.pairing_id,
      challenge: challenge.challenge,
      org_id: this.orgId,
      subject_id: this.subject,
    });
    const confirmed = await this.deps.api.request<{
      device_id: string;
      certificate_pem: string;
      cert_serial: string;
      cert_not_after: string;
    }>("confirmRenewal", {
      id: challenge.pairing_id,
      body: {
        client_request_id: randomUUID(),
        challenge: challenge.challenge,
        signature: String(signed.data?.signature ?? ""),
      },
    });
    this.checkEpoch();
    await this.deliver(confirmed.device_id, confirmed.certificate_pem);
    this.record = {
      ...this.record,
      certificatePem: confirmed.certificate_pem,
      certSerial: confirmed.cert_serial,
      certNotAfter: confirmed.cert_not_after,
    };
    this.deps.store.save(this.record);
  }

  private async mintAndDeliver(): Promise<void> {
    if (!this.record) return;
    const minted = await this.deps.api.request<{
      ticket: string;
      session_ticket_id: string;
    }>("mintTicket", {
      id: this.record.deviceId,
      body: {
        client_request_id: randomUUID(),
        public_key_thumbprint: this.thumbprint,
      },
    });
    this.checkEpoch();
    await this.call("deliverDeviceSessionTicket", {
      ticket: minted.ticket,
      device_id: this.record.deviceId,
      session_ticket_id: minted.session_ticket_id,
    });
  }

  private async poll(): Promise<void> {
    if (this.polling || this.state !== "running" || !this.broker) return;
    this.polling = true;
    try {
      const status = await this.call("getDeviceCertificateStatus");
      this.checkEpoch();
      const data = status.data ?? {};
      if (data.renewal_window_open === true) await this.renew();
      else if (data.awaiting_ticket === true) await this.mintAndDeliver();
    } catch (error) {
      if (this.state !== "running") return;
      if (
        error instanceof WorkApiError &&
        (error.code === "unauthorized" || error.code === "work_account_changed")
      ) {
        await this.stop();
        return;
      }
      if (error instanceof WorkApiError && error.code === "device_revoked") {
        this.deps.store.clear();
        this.record = undefined;
        await this.stop();
        this.deps.report("本机设备已被撤销，请重新配对。");
        return;
      }
      if (
        error instanceof BrokerPipeError &&
        ["pipe_closed", "pipe_io", "pipe_unavailable"].includes(error.code)
      ) {
        // The Broker process is gone; polling a dead pipe forever would hide it.
        await this.stop();
        this.deps.report("本机设备进程已停止，请重启客户端后重试。");
        return;
      }
      // Transient transport/window races wait for the next poll; no retry loop bypasses a refusal.
    } finally {
      this.polling = false;
    }
  }

  private async deliver(
    deviceId: string,
    certificatePem: string,
  ): Promise<void> {
    await this.call("deliverDeviceCertificate", {
      device_id: deviceId,
      certificate_pem: certificatePem,
    });
  }

  private async redeliver(
    deviceId: string,
    certificatePem: string,
    orgId: string,
    subjectId: string,
  ): Promise<void> {
    await this.call("redeliverDeviceCertificate", {
      device_id: deviceId,
      certificate_pem: certificatePem,
      org_id: orgId,
      subject_id: subjectId,
    });
  }

  private async call(
    method: Parameters<BrokerPipe["call"]>[0],
    fields: Record<string, unknown> = {},
  ): Promise<BrokerReply> {
    if (!this.broker) throw new BrokerPipeError("pipe_closed");
    return this.broker.pipe.call(method, fields);
  }

  private checkEpoch() {
    if (!this.deps.auth.signedIn || this.deps.auth.epoch !== this.epoch)
      throw new WorkApiError("work_account_changed");
  }

  private failureMessage(error: unknown): string {
    if (error instanceof WorkApiError) {
      switch (error.code) {
        case "local_policy_not_configured":
        case "local_policy_incomplete":
          return "组织尚未配置本机执行策略，无法配对设备。";
        case "device_revoked":
          return "本机设备已被撤销，请重新配对。";
        case "work_auth_unavailable":
        case "unauthorized":
          return "登录已失效，请重新登录后再试。";
        case "work_account_changed":
          return "账号已切换，设备驱动已停止。";
      }
    }
    return "本机设备驱动启动失败，请重启客户端后重试。";
  }
}

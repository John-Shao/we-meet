/** Main-process-only Work device REST face (control-design §1.1 plane (b), device-design §2.1).
 * Fixed endpoints, never a generic preload proxy. The shell's native Bearer token is attached
 * here and nowhere else; the renderer forwarding path (renderer.ts/forward.ts) never sees it. */
export type WorkAction =
  | "identity"
  | "listDevices"
  | "pair"
  | "confirmPairing"
  | "mintTicket"
  | "requestRenewal"
  | "confirmRenewal"
  | "revoke"
  | "registerWorkspaceGrant"
  | "listWorkspaceGrants"
  | "createLocalArtifactVersion"
  | "createLocalAcceptance"
  | "rebindRunWorkspace"
  | "listApprovals"
  | "getApproval"
  | "decideApproval"
  | "createLocalTaskPreview"
  | "submitLocalTask"
  | "getExecutionProfile"
  | "createDeviceModelBinding"
  | "refreshModelProbePreview"
  | "submitConfigurationProbe"
  | "recordModelProbe";
export interface WorkAuth {
  readonly epoch: number;
  readonly signedIn: boolean;
  readonly subject?: string;
  access(): Promise<string | undefined>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPathValue = (kind: string, value: string | undefined): boolean => {
  if (kind === "profileId")
    return value !== undefined && value.length > 0 && value.length <= 128 && value.trim() === value;
  if (kind === "revision") return value !== undefined && /^[1-9][0-9]*$/.test(value);
  return uuid.test(value ?? "");
};
const endpoints: Record<
  WorkAction,
  {
    method: "GET" | "POST";
    path: string;
    id?:
      | "pairingId"
      | "deviceId"
      | "artifactId"
      | "approvalId"
      | "taskId"
      | "runId"
      | "profileId"
      | "revision"
      | "bindingId";
    id2?: "revision" | "bindingId";
  }
> = {
  identity: { method: "GET", path: "/work/v2/identity" },
  listDevices: { method: "GET", path: "/work/v2/devices" },
  pair: { method: "POST", path: "/work/v2/devices/pairings" },
  confirmPairing: {
    method: "POST",
    path: "/work/v2/devices/pairings/{pairingId}/confirm",
    id: "pairingId",
  },
  mintTicket: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/session-tickets",
    id: "deviceId",
  },
  requestRenewal: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/certificate-renewals",
    id: "deviceId",
  },
  confirmRenewal: {
    method: "POST",
    path: "/work/v2/devices/certificate-renewals/{pairingId}/confirm",
    id: "pairingId",
  },
  revoke: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/revoke",
    id: "deviceId",
  },
  registerWorkspaceGrant: { method: "POST", path: "/work/v2/workspace-grants" },
  listWorkspaceGrants: { method: "GET", path: "/work/v2/workspace-grants" },
  createLocalArtifactVersion: {
    method: "POST",
    path: "/work/v2/artifacts/{artifactId}/versions",
    id: "artifactId",
  },
  createLocalAcceptance: {
    method: "POST",
    path: "/work/v2/tasks/{taskId}/acceptances",
    id: "taskId",
  },
  rebindRunWorkspace: {
    method: "POST",
    path: "/work/v2/runs/{runId}/workspace-rebinds",
    id: "runId",
  },
  listApprovals: { method: "GET", path: "/work/v2/approvals" },
  getApproval: {
    method: "GET",
    path: "/work/v2/approvals/{approvalId}",
    id: "approvalId",
  },
  decideApproval: {
    method: "POST",
    path: "/work/v2/approvals/{approvalId}/decisions",
    id: "approvalId",
  },
  createLocalTaskPreview: {
    method: "POST",
    path: "/work/v2/local-task-previews",
  },
  submitLocalTask: { method: "POST", path: "/work/v2/tasks" },
  getExecutionProfile: {
    method: "GET",
    path: "/work/v2/execution-profiles/{profileId}/revisions/{revision}",
    id: "profileId",
    id2: "revision",
  },
  createDeviceModelBinding: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/model-bindings",
    id: "deviceId",
  },
  refreshModelProbePreview: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-previews",
    id: "deviceId",
    id2: "bindingId",
  },
  submitConfigurationProbe: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-runs",
    id: "deviceId",
    id2: "bindingId",
  },
  recordModelProbe: {
    method: "POST",
    path: "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probes",
    id: "deviceId",
    id2: "bindingId",
  },
};
/** The closed public codes the device face can raise (error-codes.json). Anything else is a
 * transport failure, never a code the driver branches on. */
const codes = new Set([
  "unauthorized",
  "csrf_invalid",
  "invalid_request",
  "not_found",
  "forbidden",
  "idempotency_conflict",
  "idempotency_key_conflict",
  "device_revoked",
  "local_policy_not_configured",
  "local_policy_incomplete",
  "classification_floor_required",
  "classification_unknown",
  "invalid_pagination",
  "service_degraded",
  "content_on_original_device",
  "version_conflict",
  "output_unsupported",
  "approval_not_pending",
  "approval_stale_or_expired",
  "approval_nonce_reused",
  "run_not_active",
  "task_not_found",
  "task_not_acceptable",
  "run_not_quiescent",
  "artifact_not_published",
  "local_proof_expired",
  "preview_stale",
  "work_seat_required",
  "workspace_identity_changed",
  "run_not_found",
]);
export class WorkApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "WorkApiError";
  }
}

/** One deadline includes credentials, headers and the entire response stream. */
async function beforeDeadline<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      aborted,
    ]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class WorkApi {
  private readonly origin: string;
  constructor(
    serviceOrigin: string,
    private readonly auth: WorkAuth,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(serviceOrigin);
    if (
      url.origin !== serviceOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    ) {
      throw new WorkApiError("invalid_service_origin");
    }
    this.origin = url.origin;
  }
  async request<T extends Record<string, unknown>>(
    action: WorkAction,
    options: {
      id?: string;
      id2?: string;
      body?: Record<string, unknown>;
      signature?: string;
      query?: { status?: "pending"; cursor?: string; limit?: 100 };
    } = {},
  ): Promise<T> {
    const route = Object.hasOwn(endpoints, action)
      ? endpoints[action]
      : undefined;
    if (
      !route ||
      (route.id ? !validPathValue(route.id, options.id) : options.id !== undefined) ||
      (route.id2 ? !validPathValue(route.id2, options.id2) : options.id2 !== undefined) ||
      (route.method === "GET" && options.body !== undefined) ||
      (options.query !== undefined && action !== "listApprovals") ||
      (options.query &&
        ((options.query.status !== undefined &&
          options.query.status !== "pending") ||
          (options.query.limit !== undefined && options.query.limit !== 100) ||
          (options.query.cursor !== undefined &&
            (typeof options.query.cursor !== "string" ||
              options.query.cursor.length > 2048 ||
              options.query.cursor.includes("\0"))))) ||
      ((action === "createLocalArtifactVersion" ||
        action === "createLocalAcceptance" ||
        action === "createDeviceModelBinding" ||
        action === "recordModelProbe") &&
        options.signature === undefined) ||
      (options.signature !== undefined &&
        ((action !== "createLocalArtifactVersion" &&
          action !== "createLocalAcceptance" &&
          action !== "createDeviceModelBinding" &&
          action !== "recordModelProbe") ||
          !/^[A-Za-z0-9_-]{86}$/.test(options.signature)))
    )
      throw new WorkApiError("invalid_work_request");
    const body =
      route.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined;
    if (body && Buffer.byteLength(body, "utf8") > 16384)
      throw new WorkApiError("invalid_work_request");
    const epoch = this.auth.epoch;
    this.checkEpoch(epoch);
    const deadline = AbortSignal.timeout(8000);
    let token: string | undefined;
    try {
      token = await beforeDeadline(deadline, () => {
        this.checkEpoch(epoch);
        return this.auth.access();
      });
    } catch {
      this.checkEpoch(epoch);
      throw new WorkApiError(
        deadline.aborted ? "work_request_failed" : "work_auth_unavailable",
      );
    }
    this.checkEpoch(epoch);
    if (!token) throw new WorkApiError("work_auth_unavailable");
    const query = options.query
      ? `?${new URLSearchParams({ status: "pending", limit: "100", ...(options.query.cursor ? { cursor: options.query.cursor } : {}) })}`
      : "";
    let path = route.id
      ? route.path.replace(`{${route.id}}`, options.id!)
      : route.path;
    if (route.id2) path = path.replace(`{${route.id2}}`, options.id2!);
    const url = this.origin + path + query;
    try {
      const response = await beforeDeadline(deadline, () => {
        this.checkEpoch(epoch);
        return this.fetcher(url, {
          method: route.method,
          redirect: "error",
          signal: deadline,
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Work-Client": "desktop",
            "Content-Type": "application/json",
            ...(options.signature
              ? { "X-Device-Signature": options.signature }
              : {}),
          },
          body,
        });
      });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { value, done } = await beforeDeadline(deadline, () =>
            reader.read(),
          );
          if (done) break;
          size += value.length;
          // The largest honest response is a certificate chain PEM plus metadata; 256KiB is
          // far above it and far below the screen-frame cap the remote-control face needs.
          if (size > 262144) {
            await beforeDeadline(deadline, () => reader.cancel());
            throw new WorkApiError("work_response_oversize");
          }
          chunks.push(value);
        }
      }
      this.checkEpoch(epoch);
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as T;
      if (!response.ok)
        throw new WorkApiError(
          typeof data?.code === "string" && codes.has(data.code)
            ? data.code
            : "work_request_failed",
        );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new WorkApiError("work_response_invalid");
      return data;
    } catch (error) {
      this.checkEpoch(epoch);
      if (error instanceof WorkApiError) throw error;
      throw new WorkApiError("work_request_failed");
    }
  }
  private checkEpoch(epoch: number) {
    if (!this.auth.signedIn || this.auth.epoch !== epoch)
      throw new WorkApiError("work_account_changed");
  }
}

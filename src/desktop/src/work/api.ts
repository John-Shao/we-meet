/** Main-process-only Work device REST face (control-design §1.1 plane (b), device-design §2.1).
 * Fixed endpoints, never a generic preload proxy. The shell's native Bearer token is attached
 * here and nowhere else; the renderer forwarding path (renderer.ts/forward.ts) never sees it. */
export type WorkAction = "identity" | "listDevices" | "pair" | "confirmPairing" | "mintTicket" |
  "requestRenewal" | "confirmRenewal" | "revoke";
export interface WorkAuth { readonly epoch: number; readonly signedIn: boolean; readonly subject?: string; access(): Promise<string | undefined> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const endpoints: Record<WorkAction, { method: "GET" | "POST"; path: string; id?: "pairingId" | "deviceId" }> = {
  identity: { method: "GET", path: "/work/v2/identity" },
  listDevices: { method: "GET", path: "/work/v2/devices" },
  pair: { method: "POST", path: "/work/v2/devices/pairings" },
  confirmPairing: { method: "POST", path: "/work/v2/devices/pairings/{pairingId}/confirm", id: "pairingId" },
  mintTicket: { method: "POST", path: "/work/v2/devices/{deviceId}/session-tickets", id: "deviceId" },
  requestRenewal: { method: "POST", path: "/work/v2/devices/{deviceId}/certificate-renewals", id: "deviceId" },
  confirmRenewal: { method: "POST", path: "/work/v2/devices/certificate-renewals/{pairingId}/confirm", id: "pairingId" },
  revoke: { method: "POST", path: "/work/v2/devices/{deviceId}/revoke", id: "deviceId" },
};
/** The closed public codes the device face can raise (error-codes.json). Anything else is a
 * transport failure, never a code the driver branches on. */
const codes = new Set(["unauthorized", "csrf_invalid", "invalid_request", "not_found", "forbidden",
  "idempotency_conflict", "idempotency_key_conflict", "device_revoked", "local_policy_not_configured",
  "local_policy_incomplete", "invalid_pagination", "service_degraded"]);
export class WorkApiError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "WorkApiError"; }
}

/** One deadline includes credentials, headers and the entire response stream. */
async function beforeDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }), aborted]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", onAbort); }
}

export class WorkApi {
  private readonly origin: string;
  constructor(serviceOrigin: string, private readonly auth: WorkAuth,
    private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(serviceOrigin);
    if (url.origin !== serviceOrigin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new WorkApiError("invalid_service_origin");
    }
    this.origin = url.origin;
  }
  async request<T extends Record<string, unknown>>(action: WorkAction, options: { id?: string; body?: Record<string, unknown> } = {}): Promise<T> {
    const route = Object.hasOwn(endpoints, action) ? endpoints[action] : undefined;
    if (!route || (route.id ? !uuid.test(options.id ?? "") : options.id !== undefined) ||
      (route.method === "GET" && options.body !== undefined)) throw new WorkApiError("invalid_work_request");
    const body = route.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined;
    if (body && Buffer.byteLength(body, "utf8") > 16384) throw new WorkApiError("invalid_work_request");
    const epoch = this.auth.epoch;
    this.checkEpoch(epoch);
    const deadline = AbortSignal.timeout(8000);
    let token: string | undefined;
    try { token = await beforeDeadline(deadline, () => { this.checkEpoch(epoch); return this.auth.access(); }); }
    catch {
      this.checkEpoch(epoch);
      throw new WorkApiError(deadline.aborted ? "work_request_failed" : "work_auth_unavailable");
    }
    this.checkEpoch(epoch);
    if (!token) throw new WorkApiError("work_auth_unavailable");
    const url = this.origin + (route.id ? route.path.replace(`{${route.id}}`, options.id!) : route.path);
    try {
      const response = await beforeDeadline(deadline, () => {
        this.checkEpoch(epoch);
        return this.fetcher(url, { method: route.method, redirect: "error", signal: deadline,
          headers: { Authorization: `Bearer ${token}`, "X-Work-Client": "desktop", "Content-Type": "application/json" }, body });
      });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { value, done } = await beforeDeadline(deadline, () => reader.read());
          if (done) break;
          size += value.length;
          // The largest honest response is a certificate chain PEM plus metadata; 256KiB is
          // far above it and far below the screen-frame cap the remote-control face needs.
          if (size > 262144) { await beforeDeadline(deadline, () => reader.cancel()); throw new WorkApiError("work_response_oversize"); }
          chunks.push(value);
        }
      }
      this.checkEpoch(epoch);
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as T;
      if (!response.ok) throw new WorkApiError(typeof data?.code === "string" && codes.has(data.code) ? data.code : "work_request_failed");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new WorkApiError("work_response_invalid");
      return data;
    } catch (error) {
      this.checkEpoch(epoch);
      if (error instanceof WorkApiError) throw error;
      throw new WorkApiError("work_request_failed");
    }
  }
  private checkEpoch(epoch: number) {
    if (!this.auth.signedIn || this.auth.epoch !== epoch) throw new WorkApiError("work_account_changed");
  }
}
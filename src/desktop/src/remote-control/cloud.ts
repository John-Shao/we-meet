/** Main-process-only fixed HTTP endpoints. Never exposed as a generic preload proxy. */
export type RemoteAction = "capabilities" | "publishPresence" | "listRequests" | "request" | "session" |
  "challenge" | "prepare" | "approve" | "lease" | "pause" | "resume" | "end" | "reject" | "cancel";
export interface RemoteAuth { readonly epoch: number; readonly signedIn: boolean; access(): Promise<string | undefined> }
export type CloudResult<T> = { data: T; serverTime: number; startedAt: number; receivedAt: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const endpoints: Record<RemoteAction, { method: "GET" | "POST"; suffix: string; session?: true }> = {
  capabilities: { method: "GET", suffix: "capabilities/" },
  publishPresence: { method: "POST", suffix: "capabilities/" },
  listRequests: { method: "GET", suffix: "requests/" }, request: { method: "POST", suffix: "requests/" },
  session: { method: "GET", suffix: "", session: true },
  challenge: { method: "POST", suffix: "authorization-challenge/", session: true },
  prepare: { method: "POST", suffix: "prepare/", session: true },
  approve: { method: "POST", suffix: "approve/", session: true },
  lease: { method: "POST", suffix: "lease/", session: true },
  pause: { method: "POST", suffix: "pause/", session: true },
  resume: { method: "POST", suffix: "resume/", session: true },
  end: { method: "POST", suffix: "end/", session: true },
  reject: { method: "POST", suffix: "reject/", session: true },
  cancel: { method: "POST", suffix: "cancel/", session: true },
};
const codes = new Set(["human_account_required", "remote_control_disabled", "remote_control_not_allowed", "organization_access_denied",
  "presence_unavailable", "participant_unavailable", "connection_changed", "screen_share_unavailable", "screen_share_not_allowed",
  "capability_unavailable", "unsupported", "busy", "state_conflict", "stale_challenge", "invalid_challenge", "invalid_proof",
  "idempotency_conflict", "challenge_conflict", "immutable_binding", "request_rate_limited", "authorization_expired", "not_found",
  "action_not_allowed", "signing_unavailable"]);
export class RemoteCloudError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "RemoteCloudError"; }
}

export class RemoteControlCloud {
  private readonly origin: string;
  constructor(serviceOrigin: string, private readonly auth: RemoteAuth,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = () => performance.now()) {
    const url = new URL(serviceOrigin);
    if (url.origin !== serviceOrigin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new RemoteCloudError("invalid_service_origin");
    }
    this.origin = url.origin;
  }
  async request<T extends Record<string, unknown>>(action: RemoteAction, roomId: string, options: { sessionId?: string; body?: Record<string, unknown> } = {}): Promise<CloudResult<T>> {
    const route = Object.hasOwn(endpoints, action) ? endpoints[action] : undefined;
    if (!route || !uuid.test(roomId) || (route.session ? !uuid.test(options.sessionId ?? "") : options.sessionId !== undefined) ||
      (route.method === "GET" && options.body !== undefined)) throw new RemoteCloudError("invalid_remote_request");
    const body = route.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined;
    if (body && Buffer.byteLength(body, "utf8") > 16384) throw new RemoteCloudError("invalid_remote_request");
    const epoch = this.auth.epoch;
    this.checkEpoch(epoch);
    let token: string | undefined;
    try { token = await this.auth.access(); } catch { throw new RemoteCloudError("remote_auth_unavailable"); }
    this.checkEpoch(epoch);
    if (!token) throw new RemoteCloudError("remote_auth_unavailable");
    const startedAt = this.now();
    const url = `${this.origin}/api/v1.0/rooms/${roomId}/remote-control/${route.session ? options.sessionId + "/" : ""}${route.suffix}`;
    try {
      const response = await this.fetcher(url, { method: route.method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2_100_000) { await reader.cancel(); throw new RemoteCloudError("remote_response_oversize"); }
          chunks.push(value);
        }
      }
      this.checkEpoch(epoch);
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as T;
      if (!response.ok) throw new RemoteCloudError(typeof data?.code === "string" && codes.has(data.code) ? data.code : "remote_request_failed");
      if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isSafeInteger(data.serverTime) || (data.serverTime as number) <= 0) {
        throw new RemoteCloudError("remote_response_invalid");
      }
      return { data, serverTime: data.serverTime as number, startedAt, receivedAt: this.now() };
    } catch (error) {
      this.checkEpoch(epoch);
      if (error instanceof RemoteCloudError) throw error;
      throw new RemoteCloudError("remote_request_failed");
    }
  }
  private checkEpoch(epoch: number) {
    if (!this.auth.signedIn || this.auth.epoch !== epoch) throw new RemoteCloudError("remote_account_changed");
  }
}

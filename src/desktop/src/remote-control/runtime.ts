import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type RemoteAuth, type RemoteControlCloud } from "./cloud";
import { RemoteInputHelper, type NativeEvent } from "./native-helper";
import type { NativeDescriptor } from "./native-resources";
import { CaptureBindingStore, type SourceBinding } from "./source-binding";
import { TargetAuthorization, type TargetContext } from "./target-authorization";
import { TargetTransport, type OutgoingRemoteMessage } from "./target-transport";
import { INPUT_TOPIC, SIGNAL_TOPIC } from "./signals";
import { type RemoteCapabilities, type RemoteCaptureReference, type RemoteDesktopEvent,
  type RemoteRelayMessage, type RemoteRoomReference, type RemoteTargetStatus, type RemoteStopReason } from "./bridge";

type Context = TargetContext & { contextId: string };
type Native = Pick<RemoteInputHelper, "start" | "stop" | "shutdown" | "on" | "off" | "showConsent" | "closeGate" | "pause" | "renew" | "arm" | "input" | "suspendCapture">;
type Dependencies = {
  auth: RemoteAuth & { readonly subject?: string }; cloud: Pick<RemoteControlCloud, "request">; resourceRoot: string;
  nativeDescriptor?: NativeDescriptor | null;
  probe?: typeof RemoteInputHelper.probe; helper?: () => Native; now?: () => number;
};
type Running = { helper: Native; auth?: TargetAuthorization; transport?: TargetTransport; retiring: boolean };
type Json = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown, keys?: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (keys && Object.keys(value).sort().join(",") !== keys)) throw new Error("invalid_remote_request");
  return value as Json;
}
function id(value: unknown) { if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid_remote_request"); return value; }
function code(error: unknown) { return error instanceof Error && /^[a-z_]{1,60}$/.test(error.message) ? error.message : "remote_unavailable"; }
const publicCodes = new Set(["invalid_remote_request", "invalid_remote_context", "remote_context_changed", "remote_account_changed",
  "remote_busy", "native_unavailable", "capture_binding_mismatch", "screen_share_unavailable", "connection_changed",
  "authorization_expired", "request_binding_mismatch", "remote_control_disabled", "local_consent_required", "cleanup_unconfirmed"]);
export function publicRemoteError(error: unknown) {
  return error instanceof Error && publicCodes.has(error.message) ? error.message : "remote_unavailable";
}

/** One owner for a window's capture, login, native worker and guarded IPC relay.
 * A cleanup failure is sticky across room changes and new authorization objects.
 */
export class RemoteDesktopRuntime extends EventEmitter {
  readonly captures = new CaptureBindingStore();
  private context?: Context;
  private generation = 0;
  private captureGeneration = 0;
  private joining = false;
  private refreshing = false;
  private blocked = false;
  private supported = false;
  private lastPageSeen = 0;
  private running?: Running;
  private cleanup: Promise<void> = Promise.resolve();
  private intent?: { sessionId: string; deadline: number };
  private selecting = false;
  private usedTracks = new Set<string>();
  private status: RemoteTargetStatus = { phase: "idle", inputOpen: false, cleanupBlocked: false };
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private pendingSends = new Map<string, { contextId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly deps: Dependencies) {
    super(); this.now = deps.now ?? (() => performance.now());
    this.timer = setInterval(() => {
      const c = this.context;
      if (c && (!this.matches(c) || this.now() - this.lastPageSeen > 12000)) void this.close("connection_changed");
      if (this.intent && !this.running && this.now() >= this.intent.deadline) {
        this.intent = undefined; this.publish({ phase: "ended", inputOpen: false, cleanupBlocked: this.blocked, reason: "authorization_expired" });
      }
    }, 250); this.timer.unref();
  }

  async capabilities(value: RemoteRoomReference): Promise<RemoteCapabilities> {
    const args = object(value, "participantSid,roomId,roomSid"); id(args.roomId);
    if (typeof args.roomSid !== "string" || !/^RM_[A-Za-z0-9_-]{1,100}$/.test(args.roomSid) ||
        typeof args.participantSid !== "string" || !/^PA_[A-Za-z0-9_-]{1,100}$/.test(args.participantSid) ||
        !this.deps.auth.signedIn || !this.deps.auth.subject) throw new Error("invalid_remote_context");
    if (this.joining || this.refreshing) throw new Error("remote_busy");
    let c = this.context;
    if (!c || !this.matches(c) || c.roomId !== args.roomId || c.roomSid !== args.roomSid || c.participantSid !== args.participantSid) {
      this.joining = true;
      try {
        const closing = this.close("connection_changed"), generation = this.generation;
        const epoch = this.deps.auth.epoch, identity = this.deps.auth.subject;
        await closing;
        if (generation !== this.generation || epoch !== this.deps.auth.epoch || !this.deps.auth.signedIn) throw new Error("remote_account_changed");
        c = { ...value, identity, authEpoch: epoch, contextId: randomUUID(), deviceSessionId: randomUUID() };
        this.context = c; this.lastPageSeen = this.now();
      } finally { this.joining = false; }
    }
    this.refreshing = true;
    try {
      const response = await this.deps.cloud.request("capabilities", c.roomId); this.check(c);
      if (response.data.enabled !== true) { await this.close("remote_control_disabled"); return this.snapshot(false); }
      this.checkSelf(c, response.data);
      const probe = await this.probeCapture().catch(() => ({ ready: false, displays: [] }));
      this.check(c); this.supported = probe.ready && probe.displays.length > 0 && !this.blocked;
      await this.deps.cloud.request("publishPresence", c.roomId, { body: {
        roomSid: c.roomSid, participantSid: c.participantSid, deviceSessionId: c.deviceSessionId,
        canControl: true, canBeControlled: this.supported, protocolVersions: [1], platform: process.platform === "win32" ? "win32" : "pc-web", helperVersion: "1",
      } });
      this.check(c); this.lastPageSeen = this.now(); return this.snapshot(true);
    } catch (error) {
      if (this.context === c) void this.close(code(error));
      throw error;
    } finally { this.refreshing = false; }
  }

  async showRequest(value: { contextId: string; sessionId: string }) {
    const args = object(value, "contextId,sessionId"), c = this.requireContext(args.contextId); id(args.sessionId);
    if (!this.supported || this.blocked) throw new Error("native_unavailable");
    if (this.running || this.selecting || (this.intent && this.intent.sessionId !== args.sessionId)) throw new Error("remote_busy");
    this.selecting = true;
    try {
      const response = await this.deps.cloud.request("session", c.roomId, { sessionId: value.sessionId }); this.check(c);
      const row = response.data, request = object(row.request);
      if (row.id !== value.sessionId || row.state !== "PENDING" || request.roomId !== c.roomId || request.roomSid !== c.roomSid ||
          request.targetIdentity !== c.identity || request.targetSid !== c.participantSid || request.targetDeviceSessionId !== c.deviceSessionId) throw new Error("request_binding_mismatch");
      const remaining = (Number(row.deadline) - response.serverTime) * 1000 - (this.now() - response.startedAt) - 1000;
      if (!Number.isSafeInteger(row.deadline) || remaining <= 0 || remaining > 30000) throw new Error("authorization_expired");
      this.intent = { sessionId: value.sessionId, deadline: this.now() + remaining };
      const capture = this.captures.active(c.authEpoch);
      if (capture) this.startTarget(c, value.sessionId, capture.binding, capture.trackSid);
      return { needsScreen: !capture };
    } finally { this.selecting = false; }
  }

  /** Called only by Electron's user-gesture display-media handler. */
  beginCapture() {
    this.stopTarget("capture_changed"); this.captures.invalidate(); ++this.captureGeneration;
    const context = this.context, generation = this.captureGeneration;
    return { context, generation, fullScreenOnly: !!this.intent, baselineVerified: false };
  }
  captureCurrent(ticket: ReturnType<RemoteDesktopRuntime["beginCapture"]>) {
    return ticket.generation === this.captureGeneration && ticket.context === this.context && (!ticket.context || this.matches(ticket.context));
  }
  async captureBaseline(ticket: ReturnType<RemoteDesktopRuntime["beginCapture"]>) {
    const c = ticket.context;
    if (!c || !this.captureCurrent(ticket)) throw new Error("capture_binding_mismatch");
    const response = await this.deps.cloud.request("capabilities", c.roomId); this.check(c);
    const self = this.checkSelf(c, response.data);
    if (!this.captureCurrent(ticket) || !Array.isArray(self.screenTrackSids) || self.screenTrackSids.length > 64) throw new Error("capture_binding_mismatch");
    for (const sid of self.screenTrackSids) {
      if (typeof sid !== "string" || !/^TR_[A-Za-z0-9_-]{1,120}$/.test(sid)) throw new Error("capture_binding_mismatch");
      this.usedTracks.add(sid);
    }
    ticket.baselineVerified = true;
  }
  selectedCapture(ticket: ReturnType<RemoteDesktopRuntime["beginCapture"]>, source: SourceBinding) {
    if (!this.captureCurrent(ticket) || !ticket.context || !ticket.baselineVerified) throw new Error("capture_binding_mismatch");
    this.captures.selected(source, ticket.context.authEpoch); this.publish(this.status);
  }
  async probeCapture() { return (this.deps.probe ?? RemoteInputHelper.probe)(this.deps.resourceRoot, this.deps.nativeDescriptor); }

  async bindPublishedTrack(value: { contextId: string; shareInstanceId: string; trackSid: string }) {
    const args = object(value, "contextId,shareInstanceId,trackSid"), c = this.requireContext(args.contextId); id(args.shareInstanceId);
    if (typeof args.trackSid !== "string" || !/^TR_[A-Za-z0-9_-]{1,120}$/.test(args.trackSid)) throw new Error("capture_binding_mismatch");
    const active = this.captures.active(c.authEpoch), source = active?.binding ?? this.captures.pending(c.authEpoch);
    if (!source || source.shareInstanceId !== args.shareInstanceId || (active && active.trackSid !== args.trackSid) ||
        (!active && (this.usedTracks.has(args.trackSid) || this.usedTracks.size >= 64))) throw new Error("capture_binding_mismatch");
    const response = await this.deps.cloud.request("capabilities", c.roomId); this.check(c);
    const self = this.checkSelf(c, response.data);
    if (!Array.isArray(self.screenTrackSids) || self.screenTrackSids.length !== 1 || self.screenTrackSids[0] !== args.trackSid ||
        (this.captures.active(c.authEpoch)?.binding ?? this.captures.pending(c.authEpoch)) !== source) throw new Error("screen_share_unavailable");
    this.captures.published(value.shareInstanceId, value.trackSid, c.authEpoch); this.usedTracks.add(value.trackSid);
    this.publish(this.status);
    if (this.intent && !this.running) this.startTarget(c, this.intent.sessionId, source, value.trackSid);
  }

  forwardSignedMessage(value: RemoteRelayMessage): Promise<void> {
    const args = object(value), c = this.requireContext(args.contextId);
    if (args.kind === "sent") {
      object(value, "contextId,kind,messageId,ok"); id(args.messageId);
      if (typeof args.ok !== "boolean") throw new Error("invalid_remote_request");
      const pending = this.pendingSends.get(args.messageId as string);
      if (pending && pending.contextId === c.contextId) {
        this.pendingSends.delete(args.messageId as string); clearTimeout(pending.timer);
        if (args.ok) pending.resolve(); else pending.reject(new Error("remote_send_failed"));
      }
      return Promise.resolve();
    }
    object(value, "contextId,kind,participantIdentity,participantSid,payload,topic");
    if (value.kind !== "received" || ![SIGNAL_TOPIC, INPUT_TOPIC].includes(value.topic) ||
        typeof value.participantIdentity !== "string" || value.participantIdentity.length > 256 ||
        typeof value.participantSid !== "string" || !/^PA_[A-Za-z0-9_-]{1,100}$/.test(value.participantSid) ||
        !(value.payload instanceof Uint8Array) || value.payload.length > 8192) throw new Error("invalid_remote_request");
    return this.running?.transport?.receive(value) ?? Promise.resolve();
  }

  async stop(value: { contextId: string; reason: RemoteStopReason }) {
    const args = object(value, "contextId,reason"); this.requireContext(args.contextId);
    if (!["local_stop", "share_stopped", "meeting_left", "connection_changed", "video_unavailable"].includes(String(args.reason))) throw new Error("invalid_remote_request");
    if (["meeting_left", "connection_changed"].includes(value.reason)) return this.close(value.reason);
    if (value.reason === "video_unavailable") { this.running?.auth?.pause(); return; }
    if (value.reason !== "share_stopped") this.intent = undefined;
    this.stopTarget(value.reason);
    if (value.reason === "share_stopped") { this.captures.invalidate(); ++this.captureGeneration; }
    this.publish(this.status); await this.cleanup;
  }

  /** Closes the local gate synchronously, then waits for independent cleanup. */
  close(reason = "context_closed"): Promise<void> {
    this.intent = undefined; this.stopTarget(reason);
    this.context = undefined; ++this.generation; ++this.captureGeneration;
    this.captures.invalidate(); this.usedTracks.clear(); this.supported = false;
    this.publish({ phase: this.blocked ? "blocked" : "idle", inputOpen: false, cleanupBlocked: this.blocked, reason });
    return this.cleanup;
  }
  async dispose() { clearInterval(this.timer); await this.close(); this.removeAllListeners(); }

  private startTarget(c: Context, sessionId: string, source: SourceBinding, trackSid: string) {
    if (this.running || this.blocked || !this.intent || this.now() >= this.intent.deadline) throw new Error("remote_busy");
    const entry: Running = { helper: this.deps.helper?.() ?? new RemoteInputHelper(this.deps.nativeDescriptor), retiring: false };
    this.running = entry; this.intent = undefined;
    entry.helper.on("state", (event: NativeEvent) => {
      if (["closed", "guardianClosed", "terminated"].includes(event.event) && event.cleanup !== 1) {
        this.blocked = true;
        if (entry.auth) entry.auth.block(); else this.stopTarget("cleanup_unconfirmed");
      }
    });
    this.publish({ phase: "preparing", sessionId, inputOpen: false, cleanupBlocked: false });
    void (async () => {
      await this.cleanup; this.check(c);
      if (entry.retiring || this.running !== entry || this.blocked) throw new Error("authorization_cancelled");
      await entry.helper.start(this.deps.resourceRoot); this.check(c);
      if (entry.retiring || this.running !== entry) throw new Error("authorization_cancelled");
      const authorization = new TargetAuthorization({ auth: this.deps.auth, cloud: this.deps.cloud,
        helper: entry.helper, captures: this.captures, context: c, now: this.now });
      entry.auth = authorization;
      authorization.on("state", (status: RemoteTargetStatus) => {
        if (entry.retiring) return;
        this.blocked ||= status.cleanupBlocked;
        this.publish(status);
        if (["ended", "blocked"].includes(status.phase)) this.stopTarget(status.reason || "native_closed");
      });
      await authorization.start(sessionId, source.shareInstanceId, trackSid); this.check(c);
      if (entry.retiring || this.running !== entry) throw new Error("authorization_cancelled");
      const transport = new TargetTransport(authorization, entry.helper, message => this.send(c, message), this.now);
      entry.transport = transport; await transport.start();
    })().catch(error => { if (this.running === entry) this.stopTarget(code(error)); });
  }

  private stopTarget(reason: string) {
    const entry = this.running;
    if (!entry || entry.retiring) return;
    entry.retiring = true; this.running = undefined;
    entry.auth?.stop(reason); entry.transport?.dispose(); entry.auth?.dispose(); entry.helper.stop();
    for (const [messageId, pending] of this.pendingSends) {
      clearTimeout(pending.timer); this.pendingSends.delete(messageId); pending.reject(new Error("authorization_cancelled"));
    }
    this.publish({ ...this.status, phase: "ending", inputOpen: false, cleanupBlocked: this.blocked, reason });
    const previous = this.cleanup;
    this.cleanup = (async () => {
      const cleanup = await entry.helper.shutdown().catch(() => -1); await previous;
      if (cleanup !== 1) this.blocked = true;
      this.publish({ ...this.status, phase: this.blocked ? "blocked" : "ended", inputOpen: false,
        cleanupBlocked: this.blocked, reason: this.blocked ? "cleanup_unconfirmed" : reason });
    })();
  }

  private send(c: Context, message: OutgoingRemoteMessage) {
    this.check(c);
    if (this.pendingSends.size >= 64) return Promise.reject(new Error("remote_queue_full"));
    return new Promise<void>((resolve, reject) => {
      const messageId = randomUUID();
      const timer = setTimeout(() => { this.pendingSends.delete(messageId); reject(new Error("remote_send_timeout")); }, 250);
      this.pendingSends.set(messageId, { contextId: c.contextId, resolve, reject, timer });
      this.emit("state", { type: "send", contextId: c.contextId, messageId, ...message } satisfies RemoteDesktopEvent);
    });
  }
  private checkSelf(c: Context, data: Json) {
    const self = object(data.self);
    if (data.enabled !== true || data.roomSid !== c.roomSid || self.identity !== c.identity || self.participantSid !== c.participantSid) throw new Error("connection_changed");
    return self;
  }
  private requireContext(value: unknown) { id(value); const c = this.context; if (!c || c.contextId !== value) throw new Error("remote_context_changed"); this.check(c); return c; }
  private matches(c: Context) { return this.deps.auth.signedIn && this.deps.auth.epoch === c.authEpoch && this.deps.auth.subject === c.identity; }
  private check(c: Context) { if (this.context !== c || !this.matches(c)) throw new Error("remote_context_changed"); }
  private capture(): RemoteCaptureReference | undefined {
    if (!this.context) return;
    const active = this.captures.active(this.context.authEpoch), source = active?.binding ?? this.captures.pending(this.context.authEpoch);
    if (source) return { shareInstanceId: source.shareInstanceId, width: source.native.width, height: source.native.height, ...(active ? { trackSid: active.trackSid } : {}) };
  }
  private snapshot(enabled: boolean): RemoteCapabilities { return { enabled, contextId: this.context?.contextId, canBeControlled: this.supported && !this.blocked, capture: this.capture(), status: { ...this.status } }; }
  private publish(status: RemoteTargetStatus) { this.status = { ...status, cleanupBlocked: this.blocked || status.cleanupBlocked }; this.emit("state", { type: "state", contextId: this.context?.contextId, status: this.status, capture: this.capture() } satisfies RemoteDesktopEvent); }
}

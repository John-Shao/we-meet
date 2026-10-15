/** Human controller authorization, suitable for PC browsers and Electron Renderer. */
import { canonical, publicKeyBytes, sessionKey, verifyLease, type PublicKey, type SigningKey } from "./authorization";
import { ControllerTransport, type ControllerInput, type ControllerStatus } from "./controller-transport";
import { bytesFromUuid } from "./wire";
import { SIGNAL_TOPIC, type SignalBinding } from "./signals";

type Json = Record<string, unknown>;
type Row = { id: string; requestId: string; requestDigest: string; request: Json; binding: Json;
  state: string; stateVersion: number; epoch: number; deadline: number; lease?: string };
type Result = { data: Json; serverTime: number; startedAt: number; receivedAt: number };
export type ControllerContext = { roomId: string; roomSid: string; identity: string; participantSid: string; userId: string };
export type ControllerPeer = { identity: string; participantSid: string; userId: string; name: string };
export type ControllerSessionStatus = { phase: "requesting" | "pending" | "preparing" | "active" | "paused" | "ended";
  target: ControllerPeer; sessionId?: string; trackSid?: string; input?: ControllerStatus; reason?: string; deliveredText: number;
  textOutcome: "idle" | "pending" | "applied" | "unconfirmed" };
type Dependencies = {
  context: ControllerContext; target: ControllerPeer; signingKey: SigningKey;
  request: (action: "requests" | "session" | "cancel" | "end", options: { sessionId?: string; body?: Json }) => Promise<Result>;
  send: ConstructorParameters<typeof ControllerTransport>[0]["send"];
  isCurrent: () => boolean; onState: (state: ControllerSessionStatus) => void; now?: () => number; automaticTimer?: boolean;
};
const same = (left: unknown, right: unknown) => new TextDecoder().decode(canonical(left)) === new TextDecoder().decode(canonical(right));
function record(value: unknown): Json { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_session"); return value as Json; }
const terminal = new Set(["ENDED", "FAILED", "EXPIRED", "CANCELLED", "REJECTED"]);

export class ControllerSession {
  private readonly now: () => number;
  private readonly requestId = crypto.randomUUID();
  private key?: Awaited<ReturnType<typeof sessionKey>>;
  private row?: Row;
  private binding?: Json;
  private transport?: ControllerTransport;
  private phase: ControllerSessionStatus["phase"] = "requesting";
  private inputState?: ControllerStatus;
  private deadline = 0;
  private maximumDeadline = 0;
  private nextPoll = 0;
  private lastPoll = 0;
  private polling = false;
  private stopped = false;
  private reason?: string;
  private deliveredText = 0;
  private pendingText = false;
  private textOutcome: ControllerSessionStatus["textOutcome"] = "idle";
  private health = { pageActive: false, captureFocused: false, videoReady: false };
  private buffered: { payload: Uint8Array; time: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? (() => performance.now());
    bytesFromUuid(deps.context.roomId); bytesFromUuid(deps.context.userId); bytesFromUuid(deps.target.userId);
    const trusted = deps.signingKey;
    if (!trusted || Object.keys(trusted).sort().join(",") !== "alg,crv,kid,kty,x,y" || trusted.alg !== "ES256") throw new Error("invalid_signing_key");
    publicKeyBytes({ kty: trusted.kty, crv: trusted.crv, x: trusted.x, y: trusted.y });
    if (deps.context.identity === deps.target.identity || deps.context.userId === deps.target.userId ||
        !/^RM_[A-Za-z0-9_-]{1,100}$/.test(deps.context.roomSid) ||
        ![deps.context.participantSid, deps.target.participantSid].every(sid => /^PA_[A-Za-z0-9_-]{1,100}$/.test(sid))) throw new Error("invalid_controller_context");
  }
  status(): ControllerSessionStatus {
    return { phase: this.phase, target: { ...this.deps.target }, sessionId: this.row?.id,
      trackSid: this.binding?.trackSid as string | undefined, input: this.inputState, reason: this.reason, deliveredText: this.deliveredText, textOutcome: this.textOutcome };
  }
  async start() {
    if (this.key || this.stopped) throw new Error("invalid_controller_state");
    this.deadline = this.now() + 30000; this.maximumDeadline = this.now() + 1800000;
    if (this.deps.automaticTimer !== false) this.timer = setInterval(() => this.tick(), 100);
    this.publish();
    try {
      const key = await sessionKey(); this.check(); this.key = key;
      const result = await this.deps.request("requests", { body: { requestId: this.requestId,
        roomSid: this.deps.context.roomSid, controllerSid: this.deps.context.participantSid,
        targetSid: this.deps.target.participantSid, targetUserId: this.deps.target.userId, controllerPublicKey: key.publicKey } });
      if (this.stopped) {
        // The user may cancel before POST returns. Revoke the exact late receipt
        // only while still in the original login/meeting context.
        const row = result.data;
        if (this.deps.isCurrent() && row.requestId === this.requestId && typeof row.id === "string") {
          bytesFromUuid(row.id);
          void this.deps.request("end", { sessionId: row.id, body: { stateVersion: row.stateVersion } }).catch(() => undefined);
        }
        return;
      }
      await this.apply(result); this.nextPoll = this.now() + 1000;
    } catch (error) { this.stop(this.error(error)); }
  }
  setHealth(health: typeof this.health) { this.health = { ...health }; this.transport?.setHealth(health); }
  capture() { this.check(); if (!this.transport) throw new Error("capture_unavailable"); this.transport.capture(); }
  input(event: ControllerInput) { return !this.stopped && this.deps.isCurrent() && (this.transport?.input(event) ?? false); }
  suspend() { this.transport?.suspend(); }
  text(text: string) {
    this.check(); if (!this.transport) throw new Error("capture_unavailable");
    const previous = this.textOutcome;
    this.pendingText = true; this.textOutcome = "pending";
    try { this.transport.submitText(text); }
    catch (error) { this.pendingText = false; this.textOutcome = previous; throw error; }
    this.publish();
  }
  shortcut(events: ControllerInput[]) { this.check(); if (!this.transport) throw new Error("capture_unavailable"); this.transport.shortcut(events); }
  wake() { this.nextPoll = this.now(); }
  receive(message: { topic: string; participantIdentity: string; participantSid: string; payload: Uint8Array }) {
    if (this.stopped || !this.deps.isCurrent() || message.topic !== SIGNAL_TOPIC || message.participantIdentity !== this.deps.target.identity ||
        message.participantSid !== this.deps.target.participantSid || message.payload.length > 8192) return;
    if (this.transport) void this.transport.receive(message);
    else {
      if (this.buffered.length >= 8) this.buffered.shift();
      this.buffered.push({ payload: message.payload.slice(), time: this.now() }); this.wake();
    }
  }

  private async apply(response: Result) {
    this.check();
    const row = JSON.parse(JSON.stringify(record(response.data))) as Row;
    bytesFromUuid(row.id); bytesFromUuid(row.requestId); record(row.request); record(row.binding);
    if (row.requestId !== this.requestId || !Number.isSafeInteger(row.stateVersion) || row.stateVersion < 1 ||
        !Number.isSafeInteger(row.epoch) || row.epoch < 1 || !Number.isSafeInteger(row.deadline) ||
        (this.row && (row.id !== this.row.id || row.stateVersion < this.row.stateVersion || row.epoch < this.row.epoch || !same(row.request, this.row.request)))) throw new Error("session_binding_mismatch");
    if (!this.row) await this.validateRequest(row);
    this.check();
    if (terminal.has(row.state)) { this.row = row; this.stop(`remote_${row.state.toLowerCase()}`, false); return; }
    if (!["PENDING", "PREPARING", "ACTIVE", "PAUSED"].includes(row.state)) throw new Error("invalid_session");
    if (this.row && ((row.state === "PENDING" && this.row.state !== "PENDING") ||
        (row.state === "PREPARING" && ["ACTIVE", "PAUSED"].includes(this.row.state)))) throw new Error("state_conflict");
    if (row.state !== "PENDING") this.validateBinding(row);
    const max = row.state === "PENDING" ? 30000 : row.state === "PREPARING" ? 60000 : 15000;
    const remaining = (row.deadline - response.serverTime) * 1000 - (this.now() - response.startedAt) - 1000;
    if (!Number.isSafeInteger(response.serverTime) || response.startedAt > this.now() || remaining <= 0 || remaining > max) throw new Error("authorization_expired");
    if (["ACTIVE", "PAUSED"].includes(row.state)) {
      if (row.state === "PAUSED") this.transport?.pause();
      // A newly paused row may briefly precede B's next PAUSED signed proof.
      // It closes immediately, but this unsigned read cannot extend the old lease.
      if (!row.lease) {
        if (row.state !== "PAUSED") throw new Error("invalid_lease");
        this.phase = "paused"; this.publish(); return;
      }
      const verified = await verifyLease(row.lease, this.deps.signingKey, {
        binding: this.binding!, epoch: row.epoch, state: row.state as "ACTIVE" | "PAUSED", maximumDeadline: this.maximumDeadline,
      }, { serverTime: response.serverTime, startedAt: response.startedAt, now: this.now() });
      this.check();
      if (verified.stateVersion !== row.stateVersion) throw new Error("state_conflict");
      const deadline = Math.min(this.now() + remaining, verified.deadline);
      this.deadline = this.row?.stateVersion === row.stateVersion ? Math.min(this.deadline, deadline) : deadline;
      if (!this.transport) {
        const transport = new ControllerTransport({ binding: this.binding as SignalBinding, targetKey: this.binding!.targetPublicKey as PublicKey,
          privateKey: this.key!.privateKey, send: this.deps.send, now: this.now, automaticTimer: this.deps.automaticTimer,
          onState: state => { if (!this.stopped) { this.inputState = state; this.publish(); } },
          onEnd: reason => this.stop(reason), onEpoch: () => this.wake(),
          onOneShot: applied => {
            if (this.pendingText) { if (applied) this.deliveredText++; this.textOutcome = applied ? "applied" : "unconfirmed"; }
            this.pendingText = false; this.publish();
          } });
        this.transport = transport; transport.setHealth(this.health);
        transport.lease(row.epoch, row.state as "ACTIVE" | "PAUSED", row.stateVersion, this.deadline);
        await transport.start(); this.check();
        for (const item of this.buffered.filter(item => this.now() - item.time < 1000)) {
          await transport.receive({ topic: SIGNAL_TOPIC, participantIdentity: this.deps.target.identity, participantSid: this.deps.target.participantSid, payload: item.payload });
          this.check();
        }
        this.buffered = [];
      } else this.transport.lease(row.epoch, row.state as "ACTIVE" | "PAUSED", row.stateVersion, this.deadline);
    } else this.deadline = this.now() + remaining;
    this.row = row; this.phase = row.state.toLowerCase() as ControllerSessionStatus["phase"]; this.publish();
  }

  private async validateRequest(row: Row) {
    const r = row.request, c = this.deps.context, target = this.deps.target;
    const fields = "controllerIdentity,controllerName,controllerPublicKey,controllerSid,controllerUserId,expiresAt,roomId,roomSid,scope,targetDeviceSessionId,targetIdentity,targetName,targetSid,targetUserId,v";
    if (Object.keys(r).sort().join(",") !== fields || r.v !== 1 || r.roomId !== c.roomId || r.roomSid !== c.roomSid ||
        r.controllerIdentity !== c.identity || r.controllerSid !== c.participantSid || r.controllerUserId !== c.userId ||
        r.targetIdentity !== target.identity || r.targetSid !== target.participantSid || r.targetUserId !== target.userId ||
        !same(r.controllerPublicKey, this.key!.publicKey) || !same(r.scope, ["pointer", "keyboard", "text"]) ||
        !Number.isSafeInteger(r.expiresAt) || typeof r.controllerName !== "string" || typeof r.targetName !== "string") throw new Error("session_binding_mismatch");
    bytesFromUuid(String(r.targetDeviceSessionId));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", canonical(r)));
    if ([...hash].map(byte => byte.toString(16).padStart(2, "0")).join("") !== row.requestDigest) throw new Error("request_digest_mismatch");
  }
  private validateBinding(row: Row) {
    const b = row.binding;
    if (this.binding && !same(b, this.binding)) throw new Error("session_binding_mismatch");
    const { targetPublicKey, shareInstanceId, trackSid, displayBindingHash, sessionId, ...request } = b;
    // targetDeviceSessionId already belongs to the immutable request.
    if (!same(request, row.request) || sessionId !== row.id || typeof trackSid !== "string" || !/^TR_[A-Za-z0-9_-]{1,120}$/.test(trackSid) ||
        typeof displayBindingHash !== "string" || !/^[a-f0-9]{64}$/.test(displayBindingHash)) throw new Error("session_binding_mismatch");
    bytesFromUuid(String(shareInstanceId)); publicKeyBytes(targetPublicKey as PublicKey);
    this.binding = JSON.parse(JSON.stringify(b));
  }
  tick() {
    if (this.stopped) return;
    try { this.check(); } catch (error) { this.stop(this.error(error)); return; }
    if (!this.row || this.polling || this.now() < this.nextPoll || this.now() - this.lastPoll < 500) return;
    this.polling = true; this.lastPoll = this.now(); this.nextPoll = this.now() + (this.transport ? 1500 : 1000);
    void this.deps.request("session", { sessionId: this.row.id }).then(result => this.apply(result))
      .catch(error => this.stop(this.error(error))).finally(() => { this.polling = false; });
  }
  stop(reason = "local_stop", notify = true) {
    if (this.stopped) return;
    this.stopped = true; this.reason = reason; this.phase = "ended"; clearInterval(this.timer);
    const transport = this.transport; this.transport = undefined; transport?.stop(reason);
    this.key = undefined; this.buffered = []; this.publish();
    const row = this.row;
    if (notify && row && this.deps.isCurrent()) {
      const action = ["PENDING", "PREPARING"].includes(row.state) ? "cancel" : "end";
      void this.deps.request(action, { sessionId: row.id, body: { stateVersion: row.stateVersion } }).catch(() => {
        if (action === "cancel" && this.deps.isCurrent()) void this.deps.request("end", { sessionId: row.id, body: { stateVersion: row.stateVersion } }).catch(() => undefined);
      });
    }
  }
  private check() {
    if (this.stopped || !this.deps.isCurrent()) throw new Error("controller_context_changed");
    if (this.deadline && this.now() >= this.deadline) throw new Error("authorization_expired");
    if (this.maximumDeadline && this.now() >= this.maximumDeadline) throw new Error("authorization_expired");
  }
  private error(error: unknown) { return error instanceof Error && /^[a-z_]{1,60}$/.test(error.message) ? error.message : "remote_request_failed"; }
  private publish() { this.deps.onState(this.status()); }
}

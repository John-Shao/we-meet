/** Main-process target authorization. Never export this object through preload.
 * The transport must separately validate A's signed video/focus handshake before
 * using inputGrant(). An ACTIVE HTTP response alone never sends Arm or READY.
 */
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AUDIENCE, canonical, publicKeyBytes, sessionKey, signProof, type PublicKey } from "./authorization";
import { SigningTrust } from "./signing-trust";
import { type CloudResult, type RemoteControlCloud, type RemoteAuth } from "./cloud";
import { type NativeEvent, type RemoteInputHelper } from "./native-helper";
import { type CaptureBindingStore, type SourceBinding } from "./source-binding";
import { bytesFromUuid } from "./wire";
import { signalPayload, signSignal, type SignalBinding, type TargetSignal } from "./signals";

type Json = Record<string, unknown>;
type Purpose = "prepare" | "approve" | "resume" | "lease";
type Phase = "idle" | "preparing" | "confirming" | "active" | "pausing" | "paused" | "ended" | "blocked";
type Session = {
  id: string; requestId: string; requestDigest: string; request: Json; binding: Json;
  state: string; stateVersion: number; epoch: number; signingGeneration: number; deadline: number;
};
export type TargetContext = Readonly<{
  roomId: string; roomSid: string; participantSid: string; identity: string;
  deviceSessionId: string; authEpoch: number;
}>;
type Dependencies = {
  cloud: Pick<RemoteControlCloud, "request">;
  auth: RemoteAuth & { readonly subject?: string };
  helper: Pick<RemoteInputHelper, "on" | "off" | "showConsent" | "closeGate" | "pause" | "renew">;
  captures: CaptureBindingStore;
  context: TargetContext;
  now?: () => number;
};
const scope = ["pointer", "keyboard", "text"];
const terminal = new Set(["REJECTED", "CANCELLED", "EXPIRED", "FAILED", "ENDED"]);
const same = (a: unknown, b: unknown) => Buffer.from(canonical(a)).equals(Buffer.from(canonical(b)));
const integer = (n: unknown, min = 1): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= 0x7fffffff;
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remote_response_invalid");
  return value as Json;
}
function session(value: unknown): Session {
  const row = record(value);
  bytesFromUuid(String(row.id)); bytesFromUuid(String(row.requestId));
  if (!integer(row.stateVersion) || !integer(row.epoch) || !integer(row.deadline) ||
    typeof row.state !== "string" || !/^[a-f0-9]{64}$/.test(String(row.requestDigest))) throw new Error("remote_response_invalid");
  record(row.request); record(row.binding);
  // Keep private immutable snapshots; callers/HTTP fixtures cannot mutate a grant.
  return JSON.parse(JSON.stringify(row)) as Session;
}

export class TargetAuthorization extends EventEmitter {
  private readonly now: () => number;
  private readonly context: TargetContext;
  private phase: Phase = "idle";
  private serial = 0;
  private row?: Session;
  private source?: SourceBinding;
  private trackSid = "";
  private binding?: Json;
  private key?: Awaited<ReturnType<typeof sessionKey>>;
  private trust?: SigningTrust;
  private deadline = 0;
  private maximumDeadline = 0;
  private approvedEpoch = 0;
  private everApproved = false;
  private inputOpen = false;
  private busy = false;
  private polling = false;
  private nextPoll = 0;
  private nextLease = 0;
  private pauseReleased = false;
  private pauseCloudDone = false;
  private pauseReleaseDeadline = 0;
  private cleanupBlocked = false;
  private timer?: ReturnType<typeof setInterval>;
  private consent?: { id: string; epoch: number; deadline: number; resolve: () => void; reject: (error: Error) => void };
  private readonly nativeListener = (event: NativeEvent) => this.nativeEvent(event);

  constructor(private readonly deps: Dependencies) {
    super(); this.now = deps.now ?? (() => performance.now());
    this.context = Object.freeze({ ...deps.context });
    bytesFromUuid(this.context.roomId); bytesFromUuid(this.context.deviceSessionId);
    if (!/^RM_[A-Za-z0-9_-]{1,100}$/.test(this.context.roomSid) ||
      !/^PA_[A-Za-z0-9_-]{1,100}$/.test(this.context.participantSid) || !this.context.identity ||
      !integer(this.context.authEpoch, 0)) throw new Error("invalid_remote_context");
    deps.helper.on("state", this.nativeListener);
  }

  status() {
    return { phase: this.phase, sessionId: this.row?.id, epoch: this.row?.epoch,
      stateVersion: this.row?.stateVersion, inputOpen: this.inputOpen, cleanupBlocked: this.cleanupBlocked };
  }

  /** Source comes from CaptureBindingStore. The caller supplies references only. */
  async start(sessionId: string, shareInstanceId: string, trackSid: string): Promise<void> {
    if (this.phase !== "idle" || this.cleanupBlocked) throw new Error("remote_busy");
    bytesFromUuid(sessionId); bytesFromUuid(shareInstanceId);
    if (!/^TR_[A-Za-z0-9_-]{1,120}$/.test(trackSid)) throw new Error("capture_binding_mismatch");
    const active = this.deps.captures.active(this.context.authEpoch);
    this.source = active?.binding ?? this.deps.captures.pending(this.context.authEpoch);
    if (!this.source || this.source.shareInstanceId !== shareInstanceId || (active && active.trackSid !== trackSid)) {
      throw new Error("capture_binding_mismatch");
    }
    this.trackSid = trackSid; this.busy = true;
    const serial = ++this.serial;
    this.timer = setInterval(() => this.tick(), 100); this.timer.unref();
    this.setPhase("preparing");
    try {
      this.check(serial);
      const [capability, response] = await Promise.all([
        this.call("capabilities", serial), this.call("session", serial, undefined, sessionId),
      ]);
      this.check(serial);
      const row = session(response.data);
      if (row.id !== sessionId || row.state !== "PENDING" || row.epoch !== 1 || Object.keys(row.binding).length) throw new Error("state_conflict");
      this.validateRequest(row);
      this.row = row;
      this.deadline = this.remoteDeadline(Math.min(row.deadline, row.request.expiresAt as number), response, 30000);
      if (capability.data.enabled !== true || capability.data.roomSid !== this.context.roomSid) throw new Error("remote_control_disabled");
      this.trust = new SigningTrust(capability.data.keyRing);
      this.trust.update(response.data.keyRing, row.signingGeneration);
      const key = await sessionKey(); this.check(serial); this.key = key;
      this.binding = { ...row.request, targetPublicKey: this.key.publicKey,
        shareInstanceId, trackSid, displayBindingHash: this.source.displayBindingHash,
        targetDeviceSessionId: this.context.deviceSessionId, sessionId };
      await this.prove("prepare", serial);
      // The prepare challenge and result verified the actual LiveKit screen track.
      this.deps.captures.published(shareInstanceId, trackSid, this.context.authEpoch);
      await this.confirm(serial, this.row!.epoch);
      await this.prove("approve", serial);
      this.setPhase("active");
    } catch (error) {
      if (serial === this.serial) this.stop(this.errorCode(error));
      throw error;
    } finally { if (serial === this.serial) this.busy = false; }
  }

  /** Main-only synchronous read for the signed transport handshake. This does not
   * arm the helper, sign READY, or accept readiness asserted by an IPC boolean. */
  inputGrant() {
    this.check(this.serial);
    if (this.phase !== "active" || !this.everApproved || this.approvedEpoch !== this.row?.epoch || !this.binding) {
      throw new Error("local_consent_required");
    }
    const remainingMs = Math.floor(Math.min(this.deadline, this.maximumDeadline) - this.now());
    if (remainingMs < 1 || remainingMs > 15000) throw new Error("lease_expired");
    return { binding: JSON.parse(JSON.stringify(this.binding)) as Json, epoch: this.row.epoch,
      remainingMs, source: this.source!, controllerPublicKey: publicKeyBytes(this.row.request.controllerPublicKey as PublicKey) };
  }

  /** Main-only transport metadata. PAUSED and local pausing may send health
   * signals, but inputGrant() remains unavailable until fresh native consent. */
  transportState() {
    this.check(this.serial);
    if (!this.everApproved || !this.key || !this.binding || !this.row || !["ACTIVE", "PAUSED"].includes(this.row.state)) throw new Error("local_consent_required");
    return { binding: JSON.parse(JSON.stringify(this.binding)) as SignalBinding & { controllerPublicKey: PublicKey },
      epoch: this.row.epoch, state: this.phase === "active" ? "ACTIVE" as const : "PAUSED" as const };
  }

  /** No Renderer signing entry point. Transport revisions discard stale drafts.
   * A PAUSED renewal/resume proof may change the authorization operation serial
   * while a health response is being signed; that alone must not kill the link. */
  async targetSignal(type: TargetSignal, body: Record<string, unknown>, generation: string | null, seq: number) {
    const state = this.transportState(), key = this.key!;
    const result = await signSignal(signalPayload(state.binding, "target", state.epoch, generation, seq, type, body), key.privateKey);
    this.check(this.serial);
    if (this.key !== key) throw new Error("authorization_cancelled");
    return result;
  }

  block(reason = "cleanup_unconfirmed") { this.cleanupBlocked = true; this.stop(reason); }

  /** Immediate local closure precedes all asynchronous network work. */
  stop(reason = "local_stop", notify = true) {
    if (this.phase === "ended" || this.phase === "blocked") return;
    const previous = this.row;
    ++this.serial; this.busy = false; this.inputOpen = false; this.approvedEpoch = 0;
    this.rejectConsent(reason); this.key = undefined; this.deadline = 0;
    clearInterval(this.timer);
    this.phase = this.cleanupBlocked ? "blocked" : "ended";
    this.deps.helper.closeGate();
    this.setPhase(this.phase, reason);
    if (notify && previous && this.authMatches()) {
      const action = reason === "consent_denied" && ["PENDING", "PREPARING"].includes(previous.state) ? "reject" : "end";
      void this.deps.cloud.request(action, this.context.roomId, {
        sessionId: previous.id, body: { stateVersion: previous.stateVersion },
      }).catch(() => undefined); // The closed local gate never depends on this response.
    }
  }

  dispose() { this.stop("context_closed"); this.deps.helper.off("state", this.nativeListener); }

  /** Called by trusted lifecycle/video monitoring, never a remote resume API. */
  pause() { this.beginPause(false); }

  private validateRequest(row: Session) {
    const r = row.request, c = this.context;
    const fields = "controllerIdentity,controllerName,controllerPublicKey,controllerSid,controllerUserId,expiresAt,roomId,roomSid,scope,targetDeviceSessionId,targetIdentity,targetName,targetSid,targetUserId,v";
    if (Object.keys(r).sort().join(",") !== fields || r.v !== 1 || r.roomId !== c.roomId || r.roomSid !== c.roomSid ||
      r.targetIdentity !== c.identity || r.targetSid !== c.participantSid || r.targetDeviceSessionId !== c.deviceSessionId ||
      typeof r.controllerIdentity !== "string" || !r.controllerIdentity || r.controllerIdentity === c.identity ||
      typeof r.controllerSid !== "string" || !/^PA_[A-Za-z0-9_-]{1,100}$/.test(r.controllerSid) || r.controllerSid === c.participantSid ||
      !same(r.scope, scope) || !integer(r.expiresAt) || typeof r.controllerName !== "string" || !r.controllerName.trim() ||
      r.controllerName.length > 159 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(r.controllerName) ||
      typeof r.targetName !== "string" || createHash("sha256").update(canonical(r)).digest("hex") !== row.requestDigest) {
      throw new Error("request_binding_mismatch");
    }
    bytesFromUuid(String(r.controllerUserId)); bytesFromUuid(String(r.targetUserId));
    if (r.controllerUserId === r.targetUserId) throw new Error("request_binding_mismatch");
    publicKeyBytes(r.controllerPublicKey as PublicKey);
  }

  private matchRow(row: Session) {
    if (!this.row || row.id !== this.row.id || row.requestId !== this.row.requestId || row.requestDigest !== this.row.requestDigest ||
      !same(row.request, this.row.request) || !same(row.binding, this.binding)) throw new Error("authorization_binding_mismatch");
  }

  private async prove(purpose: Purpose, serial: number) {
    this.check(serial);
    const previous = this.row!, binding = this.binding!, key = this.key!;
    const expectedEpoch = previous.epoch + (purpose === "resume" ? 1 : 0);
    if ((purpose === "approve" || purpose === "resume") && this.approvedEpoch !== expectedEpoch) throw new Error("local_consent_required");
    if (purpose === "lease" && !this.everApproved) throw new Error("local_consent_required");
    const body: Json = { purpose, stateVersion: previous.stateVersion };
    if (purpose === "prepare") body.binding = {
      targetPublicKey: key.publicKey, shareInstanceId: binding.shareInstanceId, trackSid: binding.trackSid,
      displayBindingHash: binding.displayBindingHash, targetDeviceSessionId: this.context.deviceSessionId,
    };
    const challenge = await this.call("challenge", serial, body);
    const proof = record(challenge.data.proof);
    bytesFromUuid(String(proof.challengeId));
    if (!integer(proof.expiresAt) || proof.expiresAt > previous.deadline) throw new Error("challenge_expired");
    const proofDeadline = this.remoteDeadline(proof.expiresAt as number, challenge, 15000);
    if (!same(proof, { v: 1, audience: AUDIENCE, scope, purpose, challengeId: proof.challengeId,
      requestId: previous.requestId, sessionId: previous.id, requestDigest: previous.requestDigest,
      stateVersion: previous.stateVersion, epoch: expectedEpoch, expiresAt: proof.expiresAt, binding })) {
      throw new Error("challenge_binding_mismatch");
    }
    const signature = await signProof(proof, key.privateKey);
    this.check(serial);
    if (this.now() >= proofDeadline) throw new Error("challenge_expired");
    const response = await this.call(purpose, serial, { challengeId: proof.challengeId, signature });
    const row = session(response.data.session); this.matchRow(row);
    const expectedState = purpose === "prepare" ? "PREPARING" : purpose === "lease" ? previous.state : "ACTIVE";
    if (row.state !== expectedState || row.epoch !== expectedEpoch || row.stateVersion !== previous.stateVersion + 1) throw new Error("state_conflict");
    this.trust!.update(response.data.keyRing, row.signingGeneration);
    let deadline = this.remoteDeadline(row.deadline, response, purpose === "prepare" ? 60000 : 15000);
    if (purpose !== "prepare") {
      const maximumDeadline = this.maximumDeadline || this.now() + 1800000;
      const verified = await this.trust!.verify(String(response.data.lease), {
        binding, epoch: expectedEpoch, state: expectedState as "ACTIVE" | "PAUSED", maximumDeadline,
      }, { serverTime: response.serverTime, startedAt: response.startedAt, now: this.now() });
      this.check(serial);
      if (verified.stateVersion !== row.stateVersion) throw new Error("state_conflict");
      deadline = Math.min(deadline, verified.deadline);
      if (deadline <= this.now()) throw new Error("lease_expired");
      this.maximumDeadline = maximumDeadline; this.everApproved = true; this.nextLease = this.now() + 5000;
    }
    this.row = row; this.deadline = deadline;
    if (purpose === "lease" && this.inputOpen) this.deps.helper.renew(Math.floor(deadline - this.now()));
    this.emit("lease", { state: row.state, epoch: row.epoch, stateVersion: row.stateVersion, deadline });
  }

  private confirm(serial: number, epoch: number): Promise<void> {
    this.check(serial);
    const deadline = Math.min(this.deadline, this.now() + 60000);
    const id = randomUUID();
    this.setPhase("confirming"); this.nextPoll = this.now() + 2000;
    return new Promise<void>((resolve, reject) => {
      this.consent = { id: id.replace(/-/g, ""), epoch, deadline, resolve, reject };
      try {
        this.deps.helper.showConsent(id, { sessionId: this.row!.id, shareInstanceId: this.source!.shareInstanceId,
          inputGeneration: randomUUID(), epoch }, this.source!.native,
        publicKeyBytes(this.row!.request.controllerPublicKey as PublicKey), String(this.row!.request.controllerName), Math.floor(deadline - this.now()));
      } catch (error) { this.rejectConsent(this.errorCode(error)); }
    });
  }

  private nativeEvent(event: NativeEvent) {
    if (["closed", "guardianClosed", "terminated"].includes(event.event) && event.cleanup !== 1) {
      this.cleanupBlocked = true;
      if (this.phase === "ended") this.setPhase("blocked", "cleanup_unconfirmed");
    }
    if (["idle", "ended", "blocked"].includes(this.phase)) return;
    if (this.cleanupBlocked) { this.stop("cleanup_unconfirmed"); return; }
    if (event.event === "consentAllowed") {
      const consent = this.consent;
      if (!consent || event.consentId !== consent.id) return;
      try {
        this.check(this.serial);
        if (this.now() >= consent.deadline) throw new Error("consent_expired");
        this.approvedEpoch = consent.epoch; this.consent = undefined; consent.resolve();
      } catch (error) { this.stop(this.errorCode(error)); }
    } else if (event.event === "closed") {
      this.inputOpen = false;
      if (event.reason === "capture_suspended" && ["active", "pausing", "paused"].includes(this.phase)) return;
      if (["parent_pause", "local_takeover"].includes(event.reason || "") && this.phase === "pausing") {
        // A local takeover can race our queued Pause command. Wait for that
        // command's own acknowledgement before offering another native resume.
        if (event.reason === "parent_pause") { this.pauseReleased = true; this.finishPause(); }
        return;
      }
      if (event.reason === "local_takeover") this.beginPause(true);
      else this.stop(event.reason || "native_closed");
    } else if (event.event === "armed") {
      try { this.inputGrant(); this.inputOpen = true; } catch { this.stop("unauthorized_arm"); }
    } else if (event.event === "resumeRequested") {
      if (this.phase === "paused" && !this.busy) void this.resumeFromNative();
    } else if (["failed", "fatal", "terminated", "guardianClosed"].includes(event.event)) this.stop("native_unavailable");
  }

  private beginPause(alreadyClosed: boolean) {
    if (this.phase !== "active") { if (this.phase !== "pausing" && this.phase !== "paused") this.stop("pause_without_authorization"); return; }
    const serial = ++this.serial;
    this.approvedEpoch = 0; this.inputOpen = false; this.busy = true;
    this.pauseReleased = alreadyClosed; this.pauseCloudDone = false; this.pauseReleaseDeadline = this.now() + 1500;
    this.phase = "pausing";
    if (!alreadyClosed) this.deps.helper.pause();
    this.setPhase("pausing");
    void (async () => {
      // Read current version after invalidating any in-flight renewal. It may
      // already have committed on the server even though its local result is stale.
      for (let attempt = 0; attempt < 2; ++attempt) {
        const current = await this.call("session", serial);
        const row = session(current.data); this.matchRow(row);
        if (!["ACTIVE", "PAUSED"].includes(row.state) || row.epoch !== this.row!.epoch || row.stateVersion < this.row!.stateVersion) throw new Error("state_conflict");
        this.row = row;
        const deadline = this.remoteDeadline(row.deadline, current, 15000);
        this.deadline = Math.min(this.deadline, deadline); // A read never extends a lease.
        try {
          const response = await this.call("pause", serial, { stateVersion: row.stateVersion });
          const paused = session(response.data); this.matchRow(paused);
          if (paused.state !== "PAUSED" || paused.epoch !== row.epoch || paused.stateVersion !== row.stateVersion + (row.state === "ACTIVE" ? 1 : 0)) throw new Error("state_conflict");
          this.row = paused; this.pauseCloudDone = true; this.finishPause(); return;
        } catch (error) { if (attempt || this.errorCode(error) !== "state_conflict") throw error; }
      }
    })().catch(error => { if (serial === this.serial) this.stop(this.errorCode(error)); })
      .finally(() => { if (serial === this.serial) this.busy = false; });
  }

  private finishPause() {
    if (this.phase === "pausing" && this.pauseReleased && this.pauseCloudDone) {
      this.setPhase("paused"); this.nextLease = this.now();
    }
  }

  private async resumeFromNative() {
    const serial = ++this.serial; this.busy = true;
    try {
      // Refresh the PAUSED lease first to give the native dialog its full budget.
      await this.prove("lease", serial);
      await this.confirm(serial, this.row!.epoch + 1);
      await this.prove("resume", serial);
      this.setPhase("active");
    } catch (error) { if (serial === this.serial) this.stop(this.errorCode(error)); }
    finally { if (serial === this.serial) this.busy = false; }
  }

  private tick() {
    if (["idle", "ended", "blocked"].includes(this.phase)) return;
    try { this.check(this.serial); } catch (error) { this.stop(this.errorCode(error)); return; }
    if (this.phase === "pausing" && !this.pauseReleased && this.now() >= this.pauseReleaseDeadline) {
      this.cleanupBlocked = true; this.stop("cleanup_unconfirmed"); return;
    }
    const serial = this.serial;
    if (this.phase === "confirming" && this.consent && !this.polling && this.now() >= this.nextPoll) {
      const consent = this.consent;
      this.polling = true; this.nextPoll = this.now() + 2000;
      void this.call("session", serial).then(response => {
        const row = session(response.data); this.matchRow(row);
        if (!terminal.has(row.state)) this.trust!.update(response.data.keyRing, row.signingGeneration);
        // The native decision can resolve while this read is in flight. Our
        // approve/resume may already have committed remotely, before its signed
        // response is verified locally. Only that proof may advance the grant;
        // an obsolete dialog poll must not reject our own transition. Still
        // honor terminal responses, binding checks and signing-key revocation.
        if (this.consent !== consent && !terminal.has(row.state)) return;
        if (row.stateVersion < this.row!.stateVersion) return; // Older concurrent read.
        if (row.stateVersion !== this.row!.stateVersion || row.state !== this.row!.state || row.epoch !== this.row!.epoch || terminal.has(row.state)) this.stop("authorization_changed");
      }).catch(error => { if (serial === this.serial) this.stop(this.errorCode(error)); }).finally(() => { this.polling = false; });
    }
    if (!this.busy && ["active", "paused"].includes(this.phase) && this.now() >= this.nextLease) {
      this.busy = true;
      void this.prove("lease", serial).catch(error => { if (serial === this.serial) this.stop(this.errorCode(error)); })
        .finally(() => { if (serial === this.serial) this.busy = false; });
    }
  }

  private authMatches() {
    return this.deps.auth.signedIn && this.deps.auth.epoch === this.context.authEpoch && this.deps.auth.subject === this.context.identity;
  }

  private check(serial: number) {
    if (serial !== this.serial || ["ended", "blocked"].includes(this.phase)) throw new Error("authorization_cancelled");
    if (!this.authMatches()) throw new Error("remote_account_changed");
    if (this.deadline && this.now() >= this.deadline) throw new Error("authorization_expired");
    if (this.maximumDeadline && this.now() >= this.maximumDeadline) throw new Error("authorization_expired");
    const active = this.deps.captures.active(this.context.authEpoch);
    const source = active?.binding ?? this.deps.captures.pending(this.context.authEpoch);
    if (!source || source !== this.source || (active && active.trackSid !== this.trackSid)) throw new Error("capture_binding_mismatch");
  }

  private async call(action: Parameters<RemoteControlCloud["request"]>[0], serial: number, body?: Json, sessionId = this.row?.id): Promise<CloudResult<Json>> {
    this.check(serial);
    const response = await this.deps.cloud.request<Json>(action, this.context.roomId, {
      ...(action === "capabilities" ? {} : { sessionId }), ...(body === undefined ? {} : { body }),
    });
    this.check(serial); return response;
  }

  private remoteDeadline(expires: number, response: CloudResult<Json>, maximumMs: number) {
    const now = this.now(), remaining = (expires - response.serverTime) * 1000 - (now - response.startedAt) - 1000;
    if (!integer(expires) || !integer(response.serverTime) || !Number.isFinite(response.startedAt) || response.startedAt > now ||
      expires - response.serverTime > maximumMs / 1000 || remaining <= 0) throw new Error("authorization_expired");
    return now + remaining;
  }

  private rejectConsent(reason: string) {
    const consent = this.consent; this.consent = undefined;
    consent?.reject(new Error(reason));
  }
  private errorCode(error: unknown) { return error instanceof Error && /^[a-z_]{1,60}$/.test(error.message) ? error.message : "remote_authorization_failed"; }
  private setPhase(phase: Phase, reason?: string) { this.phase = phase; this.emit("state", { ...this.status(), reason }); }
}

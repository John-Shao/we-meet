/** Trusted main-side LiveKit data receiver. SDK metadata alone is untrusted
 * after a Renderer hop; controller signatures and native verification bind it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type TargetAuthorization } from "./target-authorization";
import { type NativeEvent, type RemoteInputHelper } from "./native-helper";
import { INPUT_BYTES, INPUT_MAGIC, bytesFromUuid } from "./wire";
import { INPUT_TOPIC, SIGNAL_TOPIC, SignalSequence, importSignalKey, verifySignal,
  type SignalBinding, type SignalPayload, type TargetSignal } from "./signals";

export type ReceivedRemoteMessage = { topic: string; participantIdentity: string; participantSid: string; payload: Uint8Array };
export type OutgoingRemoteMessage = { topic: typeof SIGNAL_TOPIC; destinationIdentity: string; payload: Uint8Array };
type Authorization = Pick<TargetAuthorization, "on" | "off" | "status" | "inputGrant" | "transportState" | "targetSignal" | "stop" | "pause" | "block">;
type Native = Pick<RemoteInputHelper, "on" | "off" | "arm" | "input" | "suspendCapture">;
type InputState = "waiting" | "arming" | "open" | "closing" | "suspended" | "paused";

export class TargetTransport {
  private readonly now: () => number;
  private binding?: SignalBinding;
  private key?: CryptoKey;
  private epoch = 0;
  private sequence = new SignalSequence();
  private sent = 0;
  private generation: string | null = null;
  private inputState: InputState = "waiting";
  private nativeChallenge?: { nonce: string; deadline: number };
  private nonces = new Map<string, { deadline: number; resume: boolean }>();
  private lastPeer = 0;
  private nextChallenge = 0;
  private closeDeadline = 0;
  private suspendSeq = 0;
  private revision = 0;
  private stopped = false;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private incomingCount = 0;
  private outgoingCount = 0;
  private incomingWaits = new Set<{ at: number; epoch: number }>();
  private outgoingWaits = new Set<{ at: number; revision: number }>();
  private rateWindow = 0;
  private signalsInWindow = 0;
  private inputsInWindow = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly nativeListener = (event: NativeEvent) => {
    try { this.nativeEvent(event); } catch { this.fail("native_event_failed"); }
  };
  private readonly stateListener = () => this.authorizationChanged();

  constructor(private readonly auth: Authorization, private readonly helper: Native,
    private readonly send: (message: OutgoingRemoteMessage) => Promise<void>, now = () => performance.now()) { this.now = now; }

  async start() {
    if (this.key || this.stopped) throw new Error("transport_busy");
    const state = this.auth.transportState();
    this.binding = state.binding; this.epoch = state.epoch;
    const key = await importSignalKey(state.binding.controllerPublicKey);
    if (this.stopped || this.auth.transportState().epoch !== this.epoch) throw new Error("authorization_cancelled");
    this.key = key; this.lastPeer = this.now();
    this.helper.on("state", this.nativeListener); this.auth.on("state", this.stateListener);
    this.timer = setInterval(() => this.tick(), 50); this.timer.unref();
    this.issueChallenge();
  }

  /** The caller must also validate IPC sender, main-frame origin and room context. */
  receive(message: ReceivedRemoteMessage): Promise<void> {
    if (this.stopped || !this.binding || !this.key) return Promise.resolve();
    if (![SIGNAL_TOPIC, INPUT_TOPIC].includes(message.topic) || message.participantIdentity !== this.binding.controllerIdentity ||
      message.participantSid !== this.binding.controllerSid) return Promise.resolve();
    if (!(message.payload instanceof Uint8Array) || message.payload.length > (message.topic === INPUT_TOPIC ? INPUT_BYTES : 8192)) {
      this.fail("invalid_remote_packet"); return Promise.resolve();
    }
    if (this.now() - this.rateWindow >= 1000) { this.rateWindow = this.now(); this.signalsInWindow = this.inputsInWindow = 0; }
    if (message.topic === INPUT_TOPIC ? ++this.inputsInWindow > 128 : ++this.signalsInWindow > 20) {
      this.fail("remote_rate_limit"); return Promise.resolve();
    }
    if (++this.incomingCount > 128) { this.fail("remote_queue_full"); return Promise.resolve(); }
    const queuedAt = this.now(), epoch = this.epoch, packet = message.payload.slice();
    const waiting = { at: queuedAt, epoch }; this.incomingWaits.add(waiting);
    const work = this.inbound.then(async () => {
      if (this.stopped || epoch !== this.epoch) return;
      if (this.now() - queuedAt > 250) throw new Error("remote_queue_expired");
      if (message.topic === INPUT_TOPIC) { this.input(packet); return; }
      const signal = await verifySignal(packet, this.key!, this.binding!, "controller");
      if (this.stopped || epoch !== this.epoch || signal.epoch < this.epoch) return;
      if (signal.epoch !== this.epoch) throw new Error("signal_epoch_mismatch");
      if (this.now() - queuedAt > 250) throw new Error("remote_queue_expired");
      if (!this.sequence.accept(signal.seq)) return;
      const challenge = this.nonces.get(signal.body.challenge as string);
      if (!challenge || challenge.deadline <= this.now()) throw new Error("expired_signal");
      this.lastPeer = this.now(); this.handle(signal);
    }).catch(error => this.fail(error instanceof Error ? error.message : "invalid_remote_packet"))
      .finally(() => { this.incomingCount--; this.incomingWaits.delete(waiting); });
    this.inbound = work; return work;
  }

  dispose() {
    if (this.stopped) return;
    this.auth.stop("transport_closed"); this.detach();
  }

  private handle(signal: SignalPayload) {
    if (signal.type === "END") { this.fail("controller_end"); return; }
    if (signal.body.videoReady === false) { this.auth.pause(); return; }
    const state = this.auth.transportState();
    if (signal.type === "HEARTBEAT") {
      this.enqueue("HEARTBEAT_ACK", { heartbeatSeq: signal.seq });
      if (signal.body.captureReady === false && ["open", "arming"].includes(this.inputState)) this.suspend(signal.seq);
      return;
    }
    if (state.state !== "ACTIVE") return; // A cannot resume a B-owned business pause.
    if (signal.type === "INPUT_SUSPEND") {
      this.suspend(signal.seq); return;
    }
    if (signal.type === "HELLO" && this.inputState === "waiting") { this.arm(); return; }
    if (signal.type === "INPUT_RESUME" && this.inputState === "suspended") {
      const nonce = signal.body.resumeChallenge as string, challenge = this.nonces.get(nonce);
      if (!challenge?.resume || challenge.deadline <= this.now()) throw new Error("expired_resume_challenge");
      challenge.resume = false; this.arm();
    }
  }

  private input(packet: Uint8Array) {
    if (packet.byteLength !== INPUT_BYTES) throw new Error("invalid_input_size");
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (view.getUint32(0, true) !== INPUT_MAGIC || view.getUint32(4, true) !== 1) throw new Error("invalid_input_protocol");
    if (this.inputState !== "open" || !this.generation) return; // In-flight old input after closure.
    const equal = (offset: number, id: string) => bytesFromUuid(id).every((byte, i) => packet[offset + i] === byte);
    if (view.getUint32(56, true) !== this.epoch || !equal(40, this.generation)) return;
    if (!equal(8, this.binding!.sessionId) || !equal(24, this.binding!.shareInstanceId)) throw new Error("input_binding_mismatch");
    this.auth.inputGrant(); // Recheck login, local consent, capture and lease now.
    this.helper.input(packet); // CNG verifies every byte and contiguous input seq.
  }

  private arm() {
    const grant = this.auth.inputGrant();
    if (grant.epoch !== this.epoch) throw new Error("signal_epoch_mismatch");
    this.revision++; this.generation = randomUUID(); this.inputState = "arming"; this.nativeChallenge = undefined;
    for (const value of this.nonces.values()) value.resume = false;
    this.helper.arm({ sessionId: this.binding!.sessionId, shareInstanceId: this.binding!.shareInstanceId,
      inputGeneration: this.generation, epoch: this.epoch }, grant.source.native, grant.remainingMs, grant.controllerPublicKey);
    this.closeDeadline = this.now() + 1500;
  }

  private suspend(requestSeq: number) {
    if (["paused", "closing"].includes(this.inputState)) return;
    this.revision++; this.suspendSeq = requestSeq; this.nativeChallenge = undefined;
    for (const value of this.nonces.values()) value.resume = false;
    if (this.inputState === "waiting" || this.inputState === "suspended") {
      this.inputState = "suspended"; this.generation = null; this.suspendAck(); return;
    }
    this.inputState = "closing"; this.closeDeadline = this.now() + 1500;
    this.helper.suspendCapture();
  }

  private nativeEvent(event: NativeEvent) {
    if (this.stopped) return;
    if (event.event === "challenge" && ["arming", "open"].includes(this.inputState)) {
      if (!/^[0-9a-f]{32}$/.test(event.nonce || "") || !Number.isInteger(event.ttlMs) || event.ttlMs! < 1 || event.ttlMs! > 3000) { this.fail("invalid_native_challenge"); return; }
      this.nativeChallenge = { nonce: event.nonce!, deadline: this.now() + event.ttlMs! };
      if (this.inputState === "open") this.issueChallenge();
    } else if (event.event === "armed" && this.inputState === "arming") {
      const grant = this.auth.inputGrant();
      if (!this.nativeChallenge || this.nativeChallenge.deadline <= this.now()) { this.fail("native_challenge_missing"); return; }
      this.inputState = "open";
      this.enqueue("READY", { inputChallenge: this.nativeChallenge.nonce,
        ttlMs: Math.floor(this.nativeChallenge.deadline - this.now()), width: grant.source.native.width, height: grant.source.native.height });
    } else if (event.event === "inputAck" && this.inputState === "open") {
      this.enqueue("INPUT_ACK", { lastAppliedInputSeq: event.seq });
    } else if (event.event === "closed" && event.reason === "capture_suspended" && this.inputState === "closing") {
      if (event.cleanup !== 1) { this.auth.block(); return; }
      this.generation = null; this.inputState = "suspended"; this.suspendAck();
    }
  }

  private suspendAck() {
    const challenge = this.newNonce(true);
    this.enqueue("SUSPEND_ACK", { requestSeq: this.suspendSeq, resumeChallenge: challenge, ttlMs: 3000 });
  }

  private authorizationChanged() {
    const status = this.auth.status();
    if (["ended", "blocked"].includes(status.phase)) { this.detach(); return; }
    try {
      const state = this.auth.transportState();
      if (state.epoch !== this.epoch) {
        this.revision++; this.epoch = state.epoch; this.sequence = new SignalSequence(); this.sent = 0;
        this.generation = null; this.nativeChallenge = undefined; this.nonces.clear(); this.lastPeer = this.now();
        this.inputState = "waiting"; this.issueChallenge();
      } else if (state.state === "PAUSED" && this.inputState !== "paused") {
        this.revision++; this.generation = null; this.nativeChallenge = undefined; this.inputState = "paused";
        for (const value of this.nonces.values()) value.resume = false;
        this.enqueue("STATE", { state: "PAUSED" }); this.issueChallenge();
      }
    } catch { this.fail("authorization_unavailable"); }
  }

  private newNonce(resume: boolean) {
    for (const [nonce, value] of this.nonces) if (value.deadline <= this.now()) this.nonces.delete(nonce);
    if (this.nonces.size >= 12) throw new Error("challenge_rate_limit");
    const nonce = randomBytes(16).toString("hex"); this.nonces.set(nonce, { deadline: this.now() + 3000, resume }); return nonce;
  }

  private issueChallenge() {
    if (this.stopped) return;
    const state = this.auth.transportState();
    const resume = this.inputState === "suspended" && state.state === "ACTIVE";
    const challenge = this.newNonce(resume);
    this.enqueue("CHALLENGE", { challenge, ttlMs: 3000, state: state.state, resumeChallenge: resume ? challenge : null,
      inputChallenge: this.inputState === "open" && this.nativeChallenge && this.nativeChallenge.deadline > this.now() ? this.nativeChallenge.nonce : null });
    this.nextChallenge = this.now() + 1000;
  }

  private enqueue(type: TargetSignal, body: Record<string, unknown>) {
    if (this.stopped) return;
    if (++this.outgoingCount > 128) { this.fail("remote_queue_full"); return; }
    const revision = this.revision, queuedAt = this.now(), generation = this.generation;
    const waiting = { at: queuedAt, revision }; this.outgoingWaits.add(waiting);
    this.outbound = this.outbound.then(async () => {
      if (this.stopped || revision !== this.revision) return;
      if (this.now() - queuedAt > 250) throw new Error("remote_queue_expired");
      const seq = this.sent + 1;
      const payload = await this.auth.targetSignal(type, body, generation, seq);
      if (this.stopped || revision !== this.revision) return; // No seq was committed/sent.
      if (this.now() - queuedAt > 250) throw new Error("remote_queue_expired");
      this.sent = seq;
      await this.send({ topic: SIGNAL_TOPIC, destinationIdentity: this.binding!.controllerIdentity, payload });
      if (this.now() - queuedAt > 250) throw new Error("remote_queue_expired");
    }).catch(error => {
      if (!this.stopped && revision === this.revision) this.fail(error instanceof Error ? error.message : "remote_send_failed");
    }).finally(() => { this.outgoingCount--; this.outgoingWaits.delete(waiting); });
  }

  private tick() {
    if (this.stopped) return;
    try {
      this.auth.transportState();
      if ([...this.incomingWaits].some(item => item.epoch === this.epoch && this.now() - item.at > 250) ||
        [...this.outgoingWaits].some(item => item.revision === this.revision && this.now() - item.at > 250)) {
        this.fail("remote_queue_expired"); return;
      }
      if (this.now() - this.lastPeer >= 3000) { this.fail("controller_timeout"); return; }
      if (["closing", "arming"].includes(this.inputState) && this.now() >= this.closeDeadline) { this.auth.block("native_ack_timeout"); return; }
      if (this.now() >= this.nextChallenge) this.issueChallenge();
    } catch { this.fail("authorization_unavailable"); }
  }

  private fail(reason: string) { this.auth.stop(/^[a-z_]{1,60}$/.test(reason) ? reason : "invalid_remote_packet"); this.detach(); }
  private detach() {
    this.stopped = true; this.revision++; this.generation = null; this.nonces.clear(); clearInterval(this.timer);
    this.helper.off("state", this.nativeListener); this.auth.off("state", this.stateListener);
  }
}

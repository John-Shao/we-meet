/** Browser controller. A verified lease and B's native READY are both required. */
import { importSignalKey, signalPayload, signSignal, verifySignal, SignalSequence, SIGNAL_TOPIC, INPUT_TOPIC,
  type SignalBinding, type ControllerSignal, type SignalPayload } from "./signals";
import { type PublicKey } from "./authorization";
import { Kind, signInput, type InputEvent } from "./wire";

export type ControllerInput = Pick<InputEvent, "kind" | "action" | "code" | "extended" | "repeat" | "x" | "y" | "delta" | "text">;
export type ControllerPhase = "waiting" | "arming" | "open" | "suspending" | "suspended" | "paused" | "ended";
export type ControllerStatus = { phase: ControllerPhase; epoch: number; inputGeneration?: string; width?: number; height?: number; reason?: string; oneShot: boolean };
type Health = { pageActive: boolean; captureFocused: boolean; videoReady: boolean };
type PeerMessage = { topic: string; participantIdentity: string; participantSid: string; payload: Uint8Array };
type Dependencies = {
  binding: SignalBinding; targetKey: PublicKey; privateKey: CryptoKey;
  send: (message: { topic: string; destinationIdentity: string; payload: Uint8Array }) => Promise<void>;
  onState: (status: ControllerStatus) => void; onEnd: (reason: string) => void;
  onEpoch?: () => void; onOneShot?: (applied: boolean) => void; now?: () => number; automaticTimer?: boolean;
};

export class ControllerTransport {
  private readonly now: () => number;
  private key?: CryptoKey;
  private phase: ControllerPhase = "waiting";
  private epoch = 0;
  private stateVersion = 0;
  private deadline = 0;
  private businessPaused = false;
  private generation: string | null = null;
  private dimensions?: { width: number; height: number };
  private sequence = new SignalSequence();
  private bootstrapped = false;
  private signalSeq = 0;
  private inputSeq = 0;
  private heartbeatSeq = 0;
  private challenge?: { value: string; deadline: number };
  private inputChallenge?: { value: string; deadline: number };
  private resumeChallenge?: { value: string; deadline: number };
  private health: Health = { pageActive: false, captureFocused: false, videoReady: false };
  private videoEstablished = false;
  private mode?: { type: "continuous" } | { type: "once"; events: ControllerInput[]; lastSeq?: number };
  private suspendSeq = 0;
  private handshakeDeadline = 0;
  private lastPeer = 0;
  private nextHeartbeat = 0;
  private heartbeatPending = new Map<number, number>();
  private pendingInputs = new Map<number, number>();
  private inputRevision = 0;
  private revision = 0;
  private outbound: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();
  private waiting = new Set<{ time: number; revision: number }>();
  private rateAt = 0;
  private inputCount = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: Dependencies) { this.now = deps.now ?? (() => performance.now()); }
  status(): ControllerStatus { return { phase: this.phase, epoch: this.epoch, inputGeneration: this.generation ?? undefined, ...this.dimensions, oneShot: this.mode?.type === "once" }; }
  async start() {
    if (this.key || this.phase === "ended" || !this.epoch) throw new Error("invalid_controller_state");
    const key = await importSignalKey(this.deps.targetKey);
    if (this.status().phase === "ended") return;
    this.key = key; this.lastPeer = this.now();
    if (this.deps.automaticTimer !== false) this.timer = setInterval(() => this.tick(), 50);
    this.publish();
  }

  /** Only the session's trusted HTTP + signed-lease verifier may call this. */
  lease(epoch: number, state: "ACTIVE" | "PAUSED", stateVersion: number, deadline: number) {
    if (this.phase === "ended") return;
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch || !Number.isSafeInteger(stateVersion) || stateVersion < this.stateVersion ||
        !Number.isFinite(deadline) || deadline <= this.now() || deadline - this.now() > 15000) throw new Error("invalid_controller_lease");
    const changed = epoch !== this.epoch;
    if (changed) {
      if (this.epoch && epoch !== this.epoch + 1) throw new Error("signal_epoch_mismatch");
      this.invalidate(); ++this.revision; this.epoch = epoch; this.stateVersion = 0;
      this.sequence = new SignalSequence(); this.bootstrapped = false; this.signalSeq = 0;
      this.challenge = undefined; this.resumeChallenge = undefined; this.heartbeatPending.clear();
      this.businessPaused = state === "PAUSED"; this.phase = this.businessPaused ? "paused" : "waiting";
      this.lastPeer = this.now(); this.nextHeartbeat = 0;
    }
    this.deadline = stateVersion === this.stateVersion ? Math.min(this.deadline, deadline) : deadline;
    this.stateVersion = stateVersion;
    if (state === "PAUSED") this.pause();
    this.publish();
  }

  setHealth(health: Health) {
    this.health = { ...health };
    if (health.videoReady) this.videoEstablished = true;
    if (this.phase === "ended") return;
    if (!health.videoReady && ["open", "arming"].includes(this.phase)) {
      this.pause(); this.nextHeartbeat = 0;
    } else if ((!health.pageActive || (!health.captureFocused && this.mode?.type === "continuous")) && ["open", "arming"].includes(this.phase)) this.suspend();
  }

  capture() { this.request({ type: "continuous" }); }
  submitText(text: string) {
    if (!text || text.length > 256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("invalid_text");
    // encodeInput performs final surrogate and byte validation before signing.
    this.request({ type: "once", events: [{ kind: Kind.Text, text }] });
  }
  shortcut(events: ControllerInput[]) {
    if (!events.length || events.length > 8 || events.some(e => e.kind !== Kind.Key)) throw new Error("invalid_shortcut");
    this.request({ type: "once", events: events.map(event => ({ ...event })) });
  }
  private request(mode: NonNullable<ControllerTransport["mode"]>) {
    if (!["waiting", "suspended"].includes(this.phase) || this.businessPaused || this.deadline <= this.now() ||
        !this.health.videoReady || !this.health.pageActive || (mode.type === "continuous" && !this.health.captureFocused)) throw new Error("capture_unavailable");
    const challenge = this.fresh(this.challenge), resume = this.phase === "suspended" ? this.fresh(this.resumeChallenge) : undefined;
    this.mode = mode; this.phase = "arming"; this.handshakeDeadline = this.now() + 1500;
    this.signal(resume ? "INPUT_RESUME" : "HELLO", { challenge, captureReady: true, videoReady: true,
      ...(resume ? { resumeChallenge: resume } : {}) }, null);
    this.resumeChallenge = undefined; this.publish();
  }

  input(event: ControllerInput): boolean {
    if (this.phase !== "open" || this.mode?.type !== "continuous" || !this.health.pageActive ||
        !this.health.captureFocused || !this.health.videoReady || this.businessPaused || this.deadline <= this.now()) return false;
    this.enqueueInput({ ...event }); return true;
  }
  suspend() {
    if (this.phase === "ended" || this.phase === "paused" || this.phase === "suspended" || this.phase === "suspending") return;
    if (this.phase === "waiting" && !this.mode) return;
    this.cancelMode(); ++this.inputRevision; this.inputChallenge = undefined;
    this.phase = "suspending"; this.handshakeDeadline = this.now() + 1500;
    try {
      this.signal("INPUT_SUSPEND", { challenge: this.fresh(this.challenge), captureReady: false, videoReady: this.health.videoReady }, this.generation,
        seq => { this.suspendSeq = seq; });
    } catch { this.stop("challenge_expired"); }
    this.publish();
  }

  /** A signed B pause or authenticated HTTP pause only closes; it cannot resume. */
  pause() {
    if (this.phase === "ended") return;
    this.invalidate(); this.businessPaused = true; this.phase = "paused"; this.resumeChallenge = undefined; this.publish();
  }

  receive(message: PeerMessage): Promise<void> {
    const b = this.deps.binding;
    if (this.phase === "ended" || !this.key || message.topic !== SIGNAL_TOPIC ||
        message.participantIdentity !== b.targetIdentity || message.participantSid !== b.targetSid) return Promise.resolve();
    if (!(message.payload instanceof Uint8Array) || message.payload.length > 8192 || this.waiting.size >= 128) { this.stop("invalid_remote_packet"); return Promise.resolve(); }
    const receivedAt = this.now(), revision = this.revision, packet = message.payload.slice();
    const token = { time: receivedAt, revision }; this.waiting.add(token);
    const work = this.inbound.then(async () => {
      if (this.phase === "ended" || revision !== this.revision) return;
      if (this.now() - receivedAt > 250) throw new Error("remote_queue_expired");
      const signal = await verifySignal(packet, this.key!, b, "target");
      if (this.status().phase === "ended" || revision !== this.revision) return;
      if (this.now() - receivedAt > 250) throw new Error("remote_queue_expired");
      if (signal.epoch < this.epoch) return;
      if (signal.epoch > this.epoch) { this.pause(); this.deps.onEpoch?.(); return; }
      if (!this.bootstrapped && signal.type !== "CHALLENGE") return;
      if (!this.sequence.accept(signal.seq, !this.bootstrapped && signal.type === "CHALLENGE")) return;
      this.bootstrapped = true; this.handle(signal, receivedAt);
    }).catch(error => this.stop(error instanceof Error ? error.message : "invalid_remote_packet"))
      .finally(() => this.waiting.delete(token));
    this.inbound = work; return work;
  }

  private handle(signal: SignalPayload, receivedAt: number) {
    const b = signal.body;
    if (signal.type === "CHALLENGE") {
      this.challenge = { value: b.challenge as string, deadline: receivedAt + Number(b.ttlMs) };
      if (b.state === "PAUSED") this.pause();
      if (this.phase === "suspended" && b.resumeChallenge && !this.businessPaused) this.resumeChallenge = { value: b.resumeChallenge as string, deadline: receivedAt + Number(b.ttlMs) };
      if (this.phase === "open" && signal.inputGeneration === this.generation && b.inputChallenge) this.inputChallenge = { value: b.inputChallenge as string, deadline: receivedAt + Number(b.ttlMs) };
      return;
    }
    if (signal.type === "STATE") { this.pause(); return; }
    if (signal.type === "HEARTBEAT_ACK") {
      const seq = Number(b.heartbeatSeq), sentAt = this.heartbeatPending.get(seq);
      if (sentAt === undefined) return;
      this.heartbeatPending.delete(seq);
      if (this.now() - sentAt < 3000) this.lastPeer = this.now();
      return;
    }
    if (signal.type === "SUSPEND_ACK") {
      if (this.phase !== "suspending" || b.requestSeq !== this.suspendSeq) return;
      this.invalidate(); this.phase = "suspended";
      this.resumeChallenge = { value: b.resumeChallenge as string, deadline: receivedAt + Number(b.ttlMs) }; this.publish(); return;
    }
    if (signal.type === "READY") {
      if (this.phase !== "arming" || !this.mode || this.businessPaused) return;
      if (this.deadline <= this.now() || this.now() >= this.handshakeDeadline || !this.health.pageActive || !this.health.videoReady) throw new Error("capture_unavailable");
      const width = Number(b.width), height = Number(b.height);
      if (this.dimensions && (this.dimensions.width !== width || this.dimensions.height !== height)) throw new Error("display_changed");
      this.dimensions = { width, height }; this.generation = signal.inputGeneration;
      this.inputSeq = this.heartbeatSeq = 0; this.pendingInputs.clear();
      this.inputChallenge = { value: b.inputChallenge as string, deadline: receivedAt + Number(b.ttlMs) };
      this.phase = "open"; this.nextHeartbeat = 0; this.publish();
      if (this.mode.type === "once") {
        const mode = this.mode;
        mode.events.forEach((event, index) => this.enqueueInput(event,
          index === mode.events.length - 1 ? seq => { mode.lastSeq = seq; } : undefined));
      }
    } else if (signal.type === "INPUT_ACK") {
      if (signal.inputGeneration !== this.generation || !["open", "suspending"].includes(this.phase)) return;
      const seq = Number(b.lastAppliedInputSeq);
      if (seq > this.inputSeq) throw new Error("invalid_input_ack");
      for (const key of this.pendingInputs.keys()) if (key <= seq) this.pendingInputs.delete(key);
      if (this.mode?.type === "once" && this.mode.lastSeq === seq && !this.pendingInputs.size) {
        this.mode = undefined; this.deps.onOneShot?.(true); this.suspend();
      }
    }
  }

  private signal(type: ControllerSignal, body: Record<string, unknown>, generation: string | null, onSent?: (seq: number) => void) {
    this.enqueue(async valid => {
      const seq = this.signalSeq + 1;
      const payload = await signSignal(signalPayload(this.deps.binding, "controller", this.epoch, generation, seq, type, body), this.deps.privateKey);
      if (!valid()) return;
      this.signalSeq = seq; onSent?.(seq);
      await this.deps.send({ topic: SIGNAL_TOPIC, destinationIdentity: this.deps.binding.targetIdentity, payload });
    });
  }
  private enqueueInput(event: ControllerInput, onSent?: (seq: number) => void) {
    const inputRevision = this.inputRevision;
    this.enqueue(async valid => {
      if (inputRevision !== this.inputRevision || this.phase !== "open" || !this.generation) return;
      if (this.now() - this.rateAt >= 1000) { this.rateAt = this.now(); this.inputCount = 0; }
      if (++this.inputCount > 120) throw new Error("remote_rate_limit");
      const heartbeat = event.kind === Kind.Heartbeat, seq = (heartbeat ? this.heartbeatSeq : this.inputSeq) + 1;
      const payload = await signInput({ ...event, sessionId: this.deps.binding.sessionId, shareInstanceId: this.deps.binding.shareInstanceId,
        epoch: this.epoch, inputGeneration: this.generation, challenge: this.fresh(this.inputChallenge), seq }, this.deps.privateKey);
      if (!valid() || inputRevision !== this.inputRevision || this.phase !== "open") return;
      if (heartbeat) this.heartbeatSeq = seq;
      else { this.inputSeq = seq; this.pendingInputs.set(seq, this.now()); }
      onSent?.(seq);
      await this.deps.send({ topic: INPUT_TOPIC, destinationIdentity: this.deps.binding.targetIdentity, payload });
    });
  }
  private enqueue(work: (valid: () => boolean) => Promise<void>) {
    if (this.phase === "ended") return;
    if (this.waiting.size >= 128) { this.stop("remote_queue_full"); return; }
    const token = { time: this.now(), revision: this.revision }; this.waiting.add(token);
    const valid = () => this.phase !== "ended" && token.revision === this.revision;
    this.outbound = this.outbound.then(async () => {
      if (!valid()) return;
      if (this.now() - token.time > 250) throw new Error("remote_queue_expired");
      await work(() => valid() && this.now() - token.time <= 250);
      if (valid() && this.now() - token.time > 250) throw new Error("remote_queue_expired");
    }).catch(error => { if (valid()) this.stop(error instanceof Error ? error.message : "remote_send_failed"); })
      .finally(() => this.waiting.delete(token));
  }

  tick() {
    if (this.phase === "ended" || !this.key) return;
    try {
      if (this.now() >= this.deadline) throw new Error("lease_expired");
      if ([...this.waiting].some(t => t.revision === this.revision && this.now() - t.time > 250)) throw new Error("remote_queue_expired");
      if (this.now() - this.lastPeer >= 3000) throw new Error("target_timeout");
      if (["arming", "suspending"].includes(this.phase) && this.now() >= this.handshakeDeadline) throw new Error("native_ack_timeout");
      if ([...this.pendingInputs.values()].some(time => this.now() - time >= 1000)) throw new Error("input_ack_timeout");
      // During initial subscription, wait for a decoded frame before asserting
      // either readiness or confirmed video loss. B's 3 s watchdog still applies.
      if (this.challenge && this.now() >= this.nextHeartbeat && (this.health.videoReady || this.videoEstablished)) {
        this.nextHeartbeat = this.now() + 1000;
        for (const [seq, time] of this.heartbeatPending) if (this.now() - time >= 3000) this.heartbeatPending.delete(seq);
        this.signal("HEARTBEAT", { challenge: this.fresh(this.challenge), videoReady: this.health.videoReady,
          captureReady: ["open", "arming"].includes(this.phase) && !!this.mode && this.health.pageActive }, this.generation,
        seq => this.heartbeatPending.set(seq, this.now()));
        if (this.phase === "open") this.enqueueInput({ kind: Kind.Heartbeat });
      }
    } catch (error) { this.stop(error instanceof Error ? error.message : "remote_transport_failed"); }
  }

  stop(reason = "local_stop") {
    if (this.phase === "ended") return;
    const challenge = this.challenge, seq = this.signalSeq + 1;
    this.invalidate(); ++this.revision; this.phase = "ended"; clearInterval(this.timer); this.publish(reason);
    // Immediate local closure does not wait on a stalled input publish. An END
    // that cannot be delivered is backed by B's independent heartbeat deadline.
    if (challenge && this.epoch) void signSignal(signalPayload(this.deps.binding, "controller", this.epoch, null, seq, "END", { challenge: challenge.value }), this.deps.privateKey)
      .then(payload => this.deps.send({ topic: SIGNAL_TOPIC, destinationIdentity: this.deps.binding.targetIdentity, payload })).catch(() => undefined);
    this.deps.onEnd(reason);
  }
  private fresh(value?: { value: string; deadline: number }) { if (!value || value.deadline <= this.now()) throw new Error("challenge_expired"); return value.value; }
  private cancelMode() { if (this.mode?.type === "once") this.deps.onOneShot?.(false); this.mode = undefined; }
  private invalidate() { this.cancelMode(); ++this.inputRevision; this.generation = null; this.inputChallenge = undefined; this.pendingInputs.clear(); }
  private publish(reason?: string) { this.deps.onState({ ...this.status(), ...(reason ? { reason } : {}) }); }
}

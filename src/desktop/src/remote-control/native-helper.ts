import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { Command, encodeArm, encodeConsent, INPUT_BYTES, type Binding, type Display, type NativeDisplay } from "./wire";
import { verifyNativeResources, type NativeDescriptor } from "./native-resources";

export type NativeEvent = { event: string; reason?: string; ready?: boolean; cleanup?: number; seq?: number; nonce?: string; ttlMs?: number; displays?: NativeDisplay[]; consentId?: string; pid?: number; guardianPid?: number };
async function verifiedExecutable(resourceRoot: string, descriptor?: NativeDescriptor | null) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("native_unavailable");
  return (await verifyNativeResources(resourceRoot, descriptor, descriptor !== undefined)).executable;
}
/** Internal main-process adapter. Not a preload API; caller must establish native consent. */
export class RemoteInputHelper extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pulse?: ReturnType<typeof setInterval>;
  private challenges?: ReturnType<typeof setInterval>;
  private buffer = "";
  private active = false;
  private closed = false;
  private guardianCleanup: number | undefined;
  private exitCleanup: number | undefined;
  private stopping?: Promise<number>;

  constructor(private readonly descriptor?: NativeDescriptor | null) { super(); }

  static async probe(resourceRoot: string, descriptor?: NativeDescriptor | null): Promise<{ ready: boolean; displays: NativeDisplay[] }> {
    const executable = await verifiedExecutable(resourceRoot, descriptor);
    const { stdout } = await promisify(execFile)(executable, ["--probe"], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    const value = JSON.parse(stdout);
    if (value.event !== "probe" || value.version !== 1 || typeof value.ready !== "boolean" ||
        !Array.isArray(value.displays) || value.displays.length > 64 || value.displays.some((d: NativeDisplay) =>
          !d || ![d.left, d.top, d.width, d.height, d.rotation, d.dpiX, d.dpiY].every(Number.isSafeInteger) ||
          d.width < 1 || d.height < 1 || typeof d.deviceName !== "string" || typeof d.devicePath !== "string")) throw new Error("native_response_invalid");
    return { ready: value.ready, displays: value.displays };
  }

  async start(resourceRoot: string): Promise<void> {
    if (process.platform !== "win32" || process.arch !== "x64" || this.child || this.closed) throw new Error("native_unavailable");
    const executable = await verifiedExecutable(resourceRoot, this.descriptor);
    if (this.closed) throw new Error("native_unavailable");
    this.child = spawn(executable, ["--parent", String(process.pid)], { stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stdin.on("error", () => this.fail("native_pipe_failed"));
    this.child.on("error", () => this.fail("native_spawn_failed"));
    // Do not use `exit` to mark cleanup complete. Guardian keeps stdout alive
    // after worker death and reports the independent ledger cleanup outcome.
    this.child.on("close", () => {
      this.clearTimers(); this.active = false;
      this.exitCleanup = this.guardianCleanup ?? -1;
      this.emit("state", { event: "terminated", cleanup: this.exitCleanup });
    });
    this.pulse = setInterval(() => this.send(Command.ParentAlive), 200);
    this.challenges = setInterval(() => { if (this.active) this.send(Command.Challenge); }, 1000);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error("native_start_timeout")), 4000);
      const listener = (event: NativeEvent) => {
        if (event.event === "hello") done(event.ready ? undefined : new Error("native_controls_unavailable"));
        else if (event.event === "failed" || event.event === "terminated" || event.event === "fatal") done(new Error("native_start_failed"));
      };
      const done = (error?: Error) => { clearTimeout(timeout); this.off("state", listener); if (error) {this.stop();reject(error);} else resolve(); };
      this.on("state", listener);
    });
  }
  arm(binding: Binding, display: Display, leaseMs: number, publicKey: Uint8Array) {
    if (this.active || this.closed) throw new Error("native_busy");
    this.send(Command.Arm, encodeArm(binding, display, leaseMs, publicKey));
  }
  showConsent(id: string, binding: Binding, display: Display, publicKey: Uint8Array, controller: string, timeoutMs: number) {
    if(this.active || this.closed)throw new Error("native_busy");
    this.send(Command.Consent,encodeConsent(id,binding,display,publicKey,controller,timeoutMs));
  }
  input(packet: Uint8Array) {
    if (!this.active || packet.length !== INPUT_BYTES) throw new Error("native_not_active");
    this.send(Command.Input, packet);
  }
  renew(leaseMs: number) {
    if (!this.active || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 15000) throw new Error("invalid_lease");
    const buffer = Buffer.alloc(4);buffer.writeUInt32LE(leaseMs);this.send(Command.Lease, buffer);
  }
  listDisplays() { this.send(Command.Hello); }
  closeGate() { this.active = false;this.send(Command.Close); }
  suspendCapture() { this.active = false;this.send(Command.Suspend); }
  pause() { this.active = false;this.send(Command.Pause); }
  stop() {
    if (this.closed) return;
    this.active = false; this.closed = true; this.clearTimers();
    const stdin=this.child?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded && stdin.writableLength<=4096) {
      const frame=Buffer.alloc(8);frame.writeUInt32LE(Command.Close,4);stdin.write(frame);
    }
    // EOF enables orderly cleanup. If it hangs the guardian's parent heartbeat
    // deadline kills the worker before issuing the conservative release.
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
  }
  /** Wait for guardian stdout to close, never just the worker exit event. */
  shutdown(): Promise<number> {
    this.stop();
    if (this.stopping) return this.stopping;
    if (!this.child) return Promise.resolve(1);
    if (this.exitCleanup !== undefined) return Promise.resolve(this.exitCleanup);
    this.stopping = new Promise(resolve => {
      const finish = (cleanup: number) => { clearTimeout(timer); this.off("state", listener); resolve(cleanup); };
      const listener = (event: NativeEvent) => { if (event.event === "terminated") finish(event.cleanup === 1 ? 1 : -1); };
      const timer = setTimeout(() => finish(-1), 5000);
      this.on("state", listener);
    });
    return this.stopping;
  }
  private clearTimers() { clearInterval(this.pulse);clearInterval(this.challenges); }
  private fail(reason: string) { if (this.closed) return;this.emit("state", {event:"failed",reason});this.stop(); }
  private send(command: number, data: Uint8Array = new Uint8Array()) {
    const stdin = this.child?.stdin;
    if (this.closed || !stdin || stdin.destroyed || stdin.writableEnded) return;
    if (stdin.writableLength > 4096) { this.fail("native_backpressure");return; }
    const frame = Buffer.alloc(8 + data.length);frame.writeUInt32LE(data.length);frame.writeUInt32LE(command,4);frame.set(data,8);
    stdin.write(frame);
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 65536) {this.fail("native_response_oversize");return;}
    let split: number;
    while ((split=this.buffer.indexOf("\n")) >= 0) {
      const line=this.buffer.slice(0,split);this.buffer=this.buffer.slice(split+1);
      try {
        const event=JSON.parse(line) as NativeEvent;
        if (typeof event.event !== "string") throw new Error("invalid_event");
        if (event.event === "armed") this.active = true;
        if (event.event === "closed" || event.event === "fatal") this.active = false;
        if (event.event === "guardianClosed") this.guardianCleanup = event.cleanup;
        this.emit("state", event);
      } catch {this.fail("native_response_invalid");}
    }
  }
}

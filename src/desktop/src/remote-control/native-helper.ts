import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Command, encodeArm, encodeConsent, INPUT_BYTES, type Binding, type Display, type NativeDisplay } from "./wire";

export type NativeEvent = { event: string; reason?: string; ready?: boolean; cleanup?: number; seq?: number; nonce?: string; ttlMs?: number; displays?: NativeDisplay[]; consentId?: string; pid?: number; guardianPid?: number };
/** Internal main-process adapter. Not a preload API; caller must establish native consent. */
export class RemoteInputHelper extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pulse?: ReturnType<typeof setInterval>;
  private challenges?: ReturnType<typeof setInterval>;
  private buffer = "";
  private active = false;
  private closed = false;
  private guardianCleanup: number | undefined;

  async start(resourceRoot: string): Promise<void> {
    if (process.platform !== "win32" || process.arch !== "x64" || this.child || this.closed) throw new Error("native_unavailable");
    const root = path.resolve(resourceRoot);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    if (manifest.protocolVersion !== 1 || manifest.platform !== "win32" || manifest.arch !== "x64" ||
        manifest.file !== "we-meet-remote-input.exe" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error("native_manifest_invalid");
    const executable = path.join(root, manifest.file);
    if (createHash("sha256").update(await readFile(executable)).digest("hex") !== manifest.sha256) throw new Error("native_integrity_failed");
    this.child = spawn(executable, ["--parent", String(process.pid)], { stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stdin.on("error", () => this.fail("native_pipe_failed"));
    this.child.on("error", () => this.fail("native_spawn_failed"));
    // Do not use `exit` to mark cleanup complete. Guardian keeps stdout alive
    // after worker death and reports the independent ledger cleanup outcome.
    this.child.on("close", () => {
      this.clearTimers(); this.active = false;
      this.emit("state", { event: "terminated", cleanup: this.guardianCleanup ?? -1 });
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

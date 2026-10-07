/** Main-process-only client for our local adapter; no dsh SDK in Electron. */
import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_CONTRACT = "work-local/v1";

export interface LocalConfiguration {
  executable: string;
  apiKey: string;
  model: string;
  source?: "bundled";
}

export function readKeyFile(file: string): string {
  if (statSync(file).size > 4096) throw new Error("invalid_key_file");
  const lines = readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const keys = lines.filter((line) => line.startsWith("DEEPSEEK_API_KEY="));
  const key = keys.length === 1 ? keys[0].slice("DEEPSEEK_API_KEY=".length).trim() : "";
  if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error("invalid_key_file");
  return key;
}

export class LocalWorkClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private configuration: LocalConfiguration, private root: string) {}

  private start() {
    if (this.child) return;
    const executable = realpathSync(this.configuration.executable);
    if (!statSync(executable).isFile() || !/^work-agent-local(?:\.exe)?$/i.test(path.basename(executable)))
      throw new Error("invalid_local_adapter");
    mkdirSync(this.root, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"])
      if (process.env[key]) env[key] = process.env[key];
    env.DEEPSEEK_API_KEY = this.configuration.apiKey;
    env.PYTHONIOENCODING = "utf-8";
    const child = spawn(executable, ["--state-dir", this.root, "--model", this.configuration.model], { shell: false, windowsHide: true, cwd: this.root, env });
    this.child = child;
    child.stderr.on("data", () => {}); // No SDK/credential diagnostics enter renderer/logs.
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 4_000_000) { void this.close(); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, boundary);
        this.buffer = this.buffer.subarray(boundary + 1);
        try {
          const response = JSON.parse(line.toString("utf8"));
          if (response.contract !== LOCAL_CONTRACT || typeof response.id !== "string") throw new Error();
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id); clearTimeout(pending.timer);
          if (response.error) pending.reject(new Error(/^[a-z_]{1,60}$/.test(response.error) ? response.error : "local_request_failed"));
          else pending.resolve(response.result);
        } catch { void this.close(); return; }
      }
    });
    const gone = () => {
      if (this.child === child) this.child = undefined;
      this.buffer = Buffer.alloc(0);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("local_transport_unknown")); }
      this.pending.clear();
    };
    child.once("error", gone); child.once("exit", gone);
  }

  request(method: string, params: unknown = {}): Promise<any> {
    this.start();
    if (this.pending.size >= 20) return Promise.reject(new Error("local_busy"));
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ contract: LOCAL_CONTRACT, id, method, params }) + "\n");
    if (bytes.length > 512000) return Promise.reject(new Error("invalid_local_request"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("local_transport_unknown")); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(bytes, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("local_transport_unknown")); } });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // EOF requests cancellation and bounded runtime shutdown in the adapter.
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    const forced = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32" && child.pid)
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else child.kill("SIGKILL");
    }, 12000);
    await exited; clearTimeout(forced);
  }
}

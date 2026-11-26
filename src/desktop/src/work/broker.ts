/** Broker process supervision (M2 ruling 甲2: the RemoteInputHelper house pattern —
 * integrity check, spawn, readiness, exit ledger, shutdown). Two deliberate deviations from
 * that template, both because the Broker's closed surface has no carrier for them:
 *  - Integrity is a SHA-256 pin of the executable against the packaged manifest. The Broker
 *    entry has no --probe mode (its argv is <config.json> or --delete-container), and adding
 *    one would widen the shipped entry for a check the hash already performs.
 *  - There is no stdin heartbeat or guardian ledger: the Broker reads no stdin, and the closed
 *    26-method pipe set has no shutdown message. Liveness is the driver's status poll plus the
 *    child exit event; stop() closes the pipe and terminates the process. The persisted CNG
 *    container survives by design (it is the device identity); uninstall owns --delete-container.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const WORK_DEVICE_FILE = "work-device.exe";
export const WORK_DEVICE_NODE_FILE = "node.exe";
export const WORK_DEVICE_BUNDLE_DIR = "work-device-bundle";
/** The pinned payload descriptor (批2-7: the sidecar runtime + bundle ship beside the Broker).
 * protocolVersion 2 pins the executable, the pinned Node runtime, and the bundle's two digest hashes
 * (runtime_digest = sha256(JCS(signed-file manifest)); tool_manifest_hash = sha256(JCS(tool schemas))).
 * The bundle bytes are re-hashed from disk at verify time, mirroring the Broker's own spawn-time gate
 * (src/device/src/digest.rs verify_bundle), so a drifted/substituted bundle is refused before spawn. */
export interface WorkDeviceDescriptor {
  protocolVersion: 2; platform: "win32"; arch: "x64";
  sha256: string; nodeSha256: string; runtimeDigest: string; toolManifestHash: string;
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function workDeviceDescriptor(value: unknown): WorkDeviceDescriptor {
  const d = value as WorkDeviceDescriptor;
  if (!d || Object.keys(d).sort().join(",") !== "arch,nodeSha256,platform,protocolVersion,runtimeDigest,sha256,toolManifestHash" ||
    d.protocolVersion !== 2 || d.platform !== "win32" || d.arch !== "x64" ||
    !hash(d.sha256) || !hash(d.nodeSha256) || !hash(d.runtimeDigest) || !hash(d.toolManifestHash)) {
    throw new Error("work_device_manifest_invalid");
  }
  return { ...d };
}

// RFC 8785 JCS for the manifest/schema shapes (strings, integers, booleans, arrays, null): sort keys
// recursively, compact JSON, UTF-8 — byte-identical to device-bundle/build-manifest.mjs and the
// device's frame::jcs (the bundle-digest gate cross-checks the two canonicalizers).
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const jcsHash = (value: unknown) => createHash("sha256").update(Buffer.from(canonicalize(value), "utf8")).digest("hex");

/** Re-verify the bundle directory against its pinned digests (mirrors digest.rs verify_bundle):
 * re-hash every signed file from disk (refusing drift/missing/path-escape), recompute
 * sha256(JCS(files)) and sha256(JCS(tool-schemas)), and require both to equal the manifest's stored
 * values AND the descriptor pins. */
async function verifyBundle(bundleDir: string, runtimeDigest: string, toolManifestHash: string): Promise<void> {
  let manifest: { files?: unknown; runtime_digest?: unknown; tool_manifest_hash?: unknown };
  try { manifest = JSON.parse((await readFile(path.join(bundleDir, "bundle-manifest.json"))).toString("utf8")); } catch { throw new Error("work_device_integrity_failed"); }
  if (!manifest || !Array.isArray(manifest.files) || !hash(manifest.runtime_digest) || !hash(manifest.tool_manifest_hash)) throw new Error("work_device_integrity_failed");
  for (const entry of manifest.files) {
    const rel = (entry as { path?: unknown }).path;
    const expected = (entry as { sha256?: unknown }).sha256;
    if (typeof rel !== "string" || typeof expected !== "string" || !hash(expected)) throw new Error("work_device_integrity_failed");
    if (rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === "")) throw new Error("work_device_integrity_failed");
    let bytes;
    try { bytes = await readFile(path.join(bundleDir, rel)); } catch { throw new Error("work_device_integrity_failed"); }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("work_device_integrity_failed");
  }
  if (jcsHash(manifest.files) !== manifest.runtime_digest || manifest.runtime_digest !== runtimeDigest) throw new Error("work_device_integrity_failed");
  let schemas: unknown;
  try { schemas = JSON.parse((await readFile(path.join(bundleDir, "tool-schemas.json"))).toString("utf8")); } catch { throw new Error("work_device_integrity_failed"); }
  if (jcsHash(schemas) !== manifest.tool_manifest_hash || manifest.tool_manifest_hash !== toolManifestHash) throw new Error("work_device_integrity_failed");
}

/** Verify the staged payload: exact inventory, pinned hashes, no symlinks, bundle bytes re-hashed. */
export async function verifyWorkDevice(root: string, expected?: WorkDeviceDescriptor | null): Promise<{ executable: string; descriptor: WorkDeviceDescriptor }> {
  if (expected === null) throw new Error("work_device_manifest_invalid");
  const absolute = path.resolve(root);
  let folder;
  try { folder = await lstat(absolute); } catch { throw new Error("work_device_manifest_invalid"); }
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("work_device_manifest_invalid");
  const manifestPath = path.join(absolute, "manifest.json");
  const executable = path.join(absolute, WORK_DEVICE_FILE);
  const nodeFile = path.join(absolute, WORK_DEVICE_NODE_FILE);
  const bundleDir = path.join(absolute, WORK_DEVICE_BUNDLE_DIR);
  for (const [file, limit] of [[manifestPath, 65536], [executable, 64 * 1024 * 1024], [nodeFile, 128 * 1024 * 1024]] as const) {
    let info;
    try { info = await lstat(file); } catch { throw new Error("work_device_manifest_invalid"); }
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error("work_device_manifest_invalid");
  }
  let bundleInfo;
  try { bundleInfo = await lstat(bundleDir); } catch { throw new Error("work_device_manifest_invalid"); }
  if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) throw new Error("work_device_manifest_invalid");
  if ((await readdir(absolute)).sort().join(",") !== `manifest.json,${WORK_DEVICE_NODE_FILE},${WORK_DEVICE_BUNDLE_DIR},${WORK_DEVICE_FILE}`) throw new Error("work_device_inventory_invalid");
  let manifest: { file?: unknown; sha256?: unknown; nodeSha256?: unknown; runtimeDigest?: unknown; toolManifestHash?: unknown };
  try { manifest = JSON.parse((await readFile(manifestPath)).toString("utf8")); } catch { throw new Error("work_device_manifest_invalid"); }
  if (!manifest || manifest.file !== WORK_DEVICE_FILE || !hash(manifest.sha256) || !hash(manifest.nodeSha256) || !hash(manifest.runtimeDigest) || !hash(manifest.toolManifestHash)) throw new Error("work_device_manifest_invalid");
  const descriptor: WorkDeviceDescriptor = {
    protocolVersion: 2, platform: "win32", arch: "x64",
    sha256: manifest.sha256 as string, nodeSha256: manifest.nodeSha256 as string,
    runtimeDigest: manifest.runtimeDigest as string, toolManifestHash: manifest.toolManifestHash as string,
  };
  const exeDigest = createHash("sha256").update(await readFile(executable)).digest("hex");
  const nodeDigest = createHash("sha256").update(await readFile(nodeFile)).digest("hex");
  if (exeDigest !== descriptor.sha256 || nodeDigest !== descriptor.nodeSha256 ||
    (expected && (expected.sha256 !== descriptor.sha256 || expected.nodeSha256 !== descriptor.nodeSha256 ||
      expected.runtimeDigest !== descriptor.runtimeDigest || expected.toolManifestHash !== descriptor.toolManifestHash))) {
    throw new Error("work_device_integrity_failed");
  }
  await verifyBundle(bundleDir, descriptor.runtimeDigest, descriptor.toolManifestHash);
  return { executable, descriptor };
}

export type BrokerEvent = { event: "ready"; pipeName: string } | { event: "terminated"; code: number | null; stderr: string } | { event: "failed"; reason: string };

export class BrokerSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private stderr = "";
  private closed = false;
  private stopping?: Promise<number | null>;

  /** Spawn the verified Broker with the closed config file and wait for its ready line. */
  async start(resourceRoot: string, configPath: string, pipeName: string, descriptor?: WorkDeviceDescriptor | null): Promise<void> {
    if (process.platform !== "win32" || process.arch !== "x64" || this.child || this.closed) throw new Error("work_device_unavailable");
    const { executable } = await verifyWorkDevice(resourceRoot, descriptor);
    if (this.closed) throw new Error("work_device_unavailable");
    const child = spawn(executable, [configPath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-65536);
    });
    child.on("error", () => this.fail("work_device_spawn_failed"));
    child.on("exit", code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.emit("state", { event: "terminated", code, stderr: this.stderr } satisfies BrokerEvent);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("work_device_start_timeout")), 15000);
      const listener = (event: BrokerEvent) => {
        if (event.event === "ready") done();
        else if (event.event === "terminated" || event.event === "failed") done(new Error("work_device_start_failed"));
      };
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.off("state", listener);
        if (error) { void this.stop(); reject(error); } else resolve();
      };
      this.on("state", listener);
      // The entry announces its pipe on stderr once the service loop is up (main.rs).
      const announce = () => {
        if (this.stderr.includes(`pipe ${pipeName} ready`)) {
          this.emit("state", { event: "ready", pipeName } satisfies BrokerEvent);
        }
      };
      child.stderr!.on("data", announce);
      announce();
    });
  }

  /** Terminate the Broker and wait for the exit ledger. There is no graceful shutdown message
   * in the closed pipe set, so the process is killed after the shell releases the pipe. */
  stop(): Promise<number | null> {
    this.closed = true;
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve(null);
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => finish(null), 5000);
      const listener = (event: BrokerEvent) => {
        if (event.event === "terminated") finish(event.code);
      };
      const finish = (code: number | null) => {
        clearTimeout(timer);
        this.off("state", listener);
        resolve(code);
      };
      this.on("state", listener);
      child.kill();
    });
    return this.stopping;
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.emit("state", { event: "failed", reason } satisfies BrokerEvent);
  }
}
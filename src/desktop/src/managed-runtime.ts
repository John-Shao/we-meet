/** Versioned, verified payloads. No vendor SDK or model secrets in this module. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

type Descriptor = { version: string; manifest_sha256: string };
type Pointer = { current: Descriptor; previous?: Descriptor };
export type RuntimeTrust = { key_id: string; public_key: string }[];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const validVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v);
const validHash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const relativeFile = (name: unknown): name is string => typeof name === "string" && name.length < 240 &&
  name.split("/").every(p => /^[a-zA-Z0-9_.@+ -]+$/.test(p) && p !== "." && p !== ".." && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));

export class ManagedRuntime {
  private switching = false;
  constructor(private bundled: string, private root: string, private initial: Descriptor, private trust: RuntimeTrust = []) {}
  private async pointer(): Promise<Pointer> {
    try { return JSON.parse(await fs.readFile(path.join(this.root, "active.json"), "utf8")); }
    catch (e: any) { if (e.code === "ENOENT") return { current: this.initial }; throw new Error("runtime_state_invalid"); }
  }
  private async directory(d: Descriptor) {
    if (!d || !validVersion(d.version) || !validHash(d.manifest_sha256)) throw new Error("runtime_state_invalid");
    const local = path.join(this.root, "versions", d.version);
    return await fs.access(local).then(() => local, () => path.join(this.bundled, d.version));
  }
  async verify(directory: string, expected?: Descriptor, signed = false): Promise<Descriptor> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("runtime_invalid_package");
    const manifestPath = path.join(directory, "manifest.json");
    const ms = await fs.lstat(manifestPath);
    if (!ms.isFile() || ms.isSymbolicLink() || ms.nlink !== 1 || ms.size > 2000000) throw new Error("runtime_invalid_package");
    const bytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(bytes.toString("utf8"));
    const d = { version: manifest.version, manifest_sha256: hash(bytes) };
    if (!validVersion(d.version) || manifest.contract !== "work-runtime/v1" || manifest.platform !== "win32-x64" ||
      manifest.adapter_contract !== "work-local/v1" || manifest.entry !== "work-agent-local.exe" ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000 ||
      (expected && (d.version !== expected.version || d.manifest_sha256 !== expected.manifest_sha256))) throw new Error("runtime_integrity_failed");
    if (signed) {
      if (!this.trust.length) throw new Error("runtime_signing_unconfigured");
      const signaturePath = path.join(directory, "manifest.sig.json");
      const ss = await fs.lstat(signaturePath);
      if (!ss.isFile() || ss.isSymbolicLink() || ss.nlink !== 1 || ss.size > 8192) throw new Error("runtime_signature_invalid");
      const signature = JSON.parse(await fs.readFile(signaturePath, "utf8"));
      const key = this.trust.find(k => k.key_id === signature.key_id);
      if (!key || createPublicKey(key.public_key).asymmetricKeyType !== "ed25519" ||
        !verify(null, bytes, key.public_key, Buffer.from(signature.signature, "base64"))) throw new Error("runtime_signature_invalid");
    }
    const names = new Set<string>();
    let total = 0;
    for (const file of manifest.files) {
      if (!relativeFile(file.name) || ["manifest.json", "manifest.sig.json"].includes(file.name) || !validHash(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || names.has(file.name.toLowerCase())) throw new Error("runtime_invalid_package");
      names.add(file.name.toLowerCase()); total += file.bytes;
      if (total > 1_000_000_000) throw new Error("runtime_invalid_package");
      const filename = path.join(directory, ...file.name.split("/"));
      const st = await fs.lstat(filename);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== file.bytes) throw new Error("runtime_integrity_failed");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(filename)) digest.update(chunk);
      if (digest.digest("hex") !== file.sha256) throw new Error("runtime_integrity_failed");
    }
    if (!names.has("work-agent-local.exe")) throw new Error("runtime_invalid_package");
    const inspect = async (parent: string, prefix = "") => {
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (!relativeFile(name) || entry.isSymbolicLink()) throw new Error("runtime_invalid_package");
        if (entry.isDirectory()) await inspect(path.join(parent, entry.name), name + "/");
        else if (!entry.isFile() || (!names.has(name.toLowerCase()) && !["manifest.json", "manifest.sig.json"].includes(name))) throw new Error("runtime_invalid_package");
      }
    };
    await inspect(directory);
    return d;
  }
  async resolve() {
    const p = await this.pointer();
    const directory = await this.directory(p.current);
    // The bundled hash is pinned by the application; installed versions also require signature.
    await this.verify(directory, p.current, p.current.manifest_sha256 !== this.initial.manifest_sha256);
    return { ...p.current, executable: path.join(directory, "work-agent-local.exe") };
  }
  async status() {
    const p = await this.pointer();
    return { version: p.current.version, previous: p.previous?.version, signed_updates_enabled: this.trust.length > 0 };
  }
  private async commit(p: Pointer) {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, "active.json.tmp"), JSON.stringify(p), { mode: 0o600 });
    await fs.rename(path.join(this.root, "active.json.tmp"), path.join(this.root, "active.json"));
  }
  private async switchRuntime<T>(action: () => Promise<T>): Promise<T> {
    if (this.switching) throw new Error("runtime_update_busy");
    this.switching = true;
    try { return await action(); }
    finally { this.switching = false; }
  }
  async install(directory: string, probe: (executable: string) => Promise<void>) {
    return this.switchRuntime(async () => {
      const d = await this.verify(directory, undefined, true);
      const p = await this.pointer();
      if (d.version === p.current.version || d.version === this.initial.version) throw new Error("runtime_version_conflict");
      const versionsPath = path.resolve(this.root, "versions");
      await fs.mkdir(versionsPath, { recursive: true });
      const vs = await fs.lstat(versionsPath);
      if (!vs.isDirectory() || vs.isSymbolicLink()) throw new Error("runtime_state_invalid");
      const versions = await fs.realpath(versionsPath);
      const target = path.join(versions, d.version);
      if (await fs.lstat(target).then(() => true, (e: any) => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("runtime_version_conflict");
      const stage = await fs.mkdtemp(path.join(versions, ".install-"));
      const payload = path.join(stage, "payload");
      const owner = await fs.lstat(stage);
      try {
        await fs.cp(directory, payload, { recursive: true, errorOnExist: true, force: false, dereference: false });
        await this.verify(payload, d, true);
        await probe(path.join(payload, "work-agent-local.exe"));
        await this.verify(payload, d, true);
        await fs.rename(payload, target);
        await this.commit({ current: d, previous: p.current });
        return this.status();
      } finally {
        if (stage) {
          // Only remove the exact staging directory this attempt created.
          const actual = await fs.realpath(stage);
          const current = await fs.lstat(stage);
          if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== owner.ino ||
            current.dev !== owner.dev || path.relative(stage, actual) !== "" ||
            path.relative(versions, path.dirname(actual)) !== "" || !path.basename(actual).startsWith(".install-")) throw new Error("runtime_unsafe_cleanup");
          await fs.rm(actual, { recursive: true, force: false });
        }
      }
    });
  }
  async rollback(probe: (executable: string) => Promise<void>) {
    return this.switchRuntime(async () => {
      const p = await this.pointer();
      if (!p.previous) throw new Error("runtime_rollback_unavailable");
      const directory = await this.directory(p.previous);
      await this.verify(directory, p.previous, p.previous.manifest_sha256 !== this.initial.manifest_sha256);
      await probe(path.join(directory, "work-agent-local.exe"));
      await this.verify(directory, p.previous, p.previous.manifest_sha256 !== this.initial.manifest_sha256);
      await this.commit({ current: p.previous, previous: p.current });
      return this.status();
    });
  }
}

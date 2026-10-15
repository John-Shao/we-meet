import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const NATIVE_FILE = "we-meet-remote-input.exe";
export const NATIVE_SOURCES = ["main.cpp", "protocol.h", "trusted-ui.h", "session-state.h", "runtime.manifest"] as const;
export type NativeDescriptor = { protocolVersion: 1; platform: "win32"; arch: "x64"; manifestSha256: string; sha256: string };
export type NativeManifest = { protocolVersion: 1; platform: "win32"; arch: "x64"; file: typeof NATIVE_FILE; sha256: string; sourceSha256: Record<string, string> };
export const nativeDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function nativeDescriptor(value: unknown): NativeDescriptor {
  const d = value as NativeDescriptor;
  if (!d || Object.keys(d).sort().join(",") !== "arch,manifestSha256,platform,protocolVersion,sha256" ||
      d.protocolVersion !== 1 || d.platform !== "win32" || d.arch !== "x64" || !hash(d.manifestSha256) || !hash(d.sha256)) throw new Error("native_manifest_invalid");
  return { ...d };
}

/** A packaged app must supply its ASAR-pinned descriptor. null fails closed. */
export async function verifyNativeResources(root: string, expected?: NativeDescriptor | null, exactInventory = false) {
  if (expected === null) throw new Error("native_manifest_invalid");
  if (expected !== undefined) expected = nativeDescriptor(expected);
  const absolute = path.resolve(root), folder = await lstat(absolute);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("native_manifest_invalid");
  const manifestPath = path.join(absolute, "manifest.json"), executable = path.join(absolute, NATIVE_FILE);
  for (const [file, limit] of [[manifestPath, 65536], [executable, 32 * 1024 * 1024]] as const) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error("native_manifest_invalid");
  }
  if (exactInventory && (await readdir(absolute)).sort().join(",") !== `manifest.json,${NATIVE_FILE}`) throw new Error("native_inventory_invalid");
  const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes.toString("utf8")) as NativeManifest;
  if (!manifest || Object.keys(manifest).sort().join(",") !== "arch,file,platform,protocolVersion,sha256,sourceSha256" ||
      manifest.protocolVersion !== 1 || manifest.platform !== "win32" || manifest.arch !== "x64" ||
      manifest.file !== NATIVE_FILE || !hash(manifest.sha256) || !manifest.sourceSha256 ||
      Object.keys(manifest.sourceSha256).sort().join(",") !== [...NATIVE_SOURCES].sort().join(",") ||
      Object.values(manifest.sourceSha256).some(value => !hash(value))) throw new Error("native_manifest_invalid");
  const descriptor: NativeDescriptor = { protocolVersion: 1, platform: "win32", arch: "x64", manifestSha256: nativeDigest(bytes), sha256: manifest.sha256 };
  if ((expected && (expected.manifestSha256 !== descriptor.manifestSha256 || expected.sha256 !== descriptor.sha256)) ||
      nativeDigest(await readFile(executable)) !== descriptor.sha256) throw new Error("native_integrity_failed");
  return { executable, manifest, descriptor };
}

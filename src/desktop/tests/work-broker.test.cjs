// Broker supervision: the integrity gate runs against real files; the spawn/ready/exit ledger
// runs against a mocked child_process.spawn (the real executable's full chain is covered by the
// Go interop drivers and the packaging smoke, not by re-launching CNG here). 批2-7: the payload is
// the Broker exe + the pinned Node runtime + the signed bundle; the gate re-hashes all three.
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WORK_DEVICE_FILE, WORK_DEVICE_NODE_FILE, WORK_DEVICE_BUNDLE_DIR, BrokerSupervisor, workDeviceDescriptor, verifyWorkDevice } = require("../dist/work/broker.js");

const windows = { skip: process.platform !== "win32" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// RFC 8785 JCS for the manifest/schema shapes — byte-identical to broker.ts and build-manifest.mjs.
const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const jcsHash = (value) => sha256(Buffer.from(canonicalize(value), "utf8"));

// A minimal self-consistent bundle fixture: one signed file + the four-tool schema object.
const BUNDLE_MAIN = Buffer.from("fake bundle main.js");
const BUNDLE_SCHEMAS = { tools: {} };
const BUNDLE_FILES = [{ path: "main.js", sha256: sha256(BUNDLE_MAIN) }];
const RUNTIME_DIGEST = jcsHash(BUNDLE_FILES);
const TOOL_MANIFEST_HASH = jcsHash(BUNDLE_SCHEMAS);
const EXE_BYTES = Buffer.from("fake broker bytes");
const NODE_BYTES = Buffer.from("fake node bytes");

async function payload(t, exeBytes = EXE_BYTES, nodeBytes = NODE_BYTES) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-broker-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, WORK_DEVICE_FILE), exeBytes);
  await fs.writeFile(path.join(root, WORK_DEVICE_NODE_FILE), nodeBytes);
  const bundle = path.join(root, WORK_DEVICE_BUNDLE_DIR);
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(path.join(bundle, "main.js"), BUNDLE_MAIN);
  await fs.writeFile(path.join(bundle, "tool-schemas.json"), JSON.stringify(BUNDLE_SCHEMAS));
  await fs.writeFile(path.join(bundle, "bundle-manifest.json"), JSON.stringify({ files: BUNDLE_FILES, runtime_digest: RUNTIME_DIGEST, tool_manifest_hash: TOOL_MANIFEST_HASH }));
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({ file: WORK_DEVICE_FILE, sha256: sha256(exeBytes), nodeSha256: sha256(nodeBytes), runtimeDigest: RUNTIME_DIGEST, toolManifestHash: TOOL_MANIFEST_HASH }));
  return root;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 1, null));
  };
  return child;
}

function mockSpawn(t, child) {
  const spawns = [];
  t.mock.method(childProcess, "spawn", (executable, args, options) => {
    spawns.push({ executable, args, options });
    return child;
  });
  return spawns;
}

test("the descriptor is a closed seven-key win32-x64 pin", () => {
  const good = { protocolVersion: 2, platform: "win32", arch: "x64", sha256: "a".repeat(64), nodeSha256: "b".repeat(64), runtimeDigest: "c".repeat(64), toolManifestHash: "d".repeat(64) };
  assert.deepEqual(workDeviceDescriptor(good), good);
  for (const bad of [
    null, {}, { ...good, extra: 1 }, { ...good, protocolVersion: 1 }, { ...good, platform: "linux" },
    { ...good, arch: "arm64" }, { ...good, sha256: "xyz" }, { ...good, sha256: "A".repeat(64) },
    { ...good, nodeSha256: "xyz" }, { ...good, runtimeDigest: "xyz" }, { ...good, toolManifestHash: "xyz" },
  ]) {
    assert.throws(() => workDeviceDescriptor(bad), /work_device_manifest_invalid/);
  }
});

test("the staged payload verifies by exact inventory and pinned hashes", async (t) => {
  const root = await payload(t);
  const { executable, descriptor } = await verifyWorkDevice(root);
  assert.equal(executable, path.join(root, WORK_DEVICE_FILE));
  assert.deepEqual(descriptor, { protocolVersion: 2, platform: "win32", arch: "x64", sha256: sha256(EXE_BYTES), nodeSha256: sha256(NODE_BYTES), runtimeDigest: RUNTIME_DIGEST, toolManifestHash: TOOL_MANIFEST_HASH });
  assert.deepEqual(await verifyWorkDevice(root, descriptor), { executable, descriptor });
});

test("tampered bytes, a foreign pin or a null pin all fail closed", async (t) => {
  const root = await payload(t);
  await fs.writeFile(path.join(root, WORK_DEVICE_FILE), Buffer.from("tampered"));
  await assert.rejects(verifyWorkDevice(root), /work_device_integrity_failed/);
  const honest = await payload(t);
  await assert.rejects(verifyWorkDevice(honest, { protocolVersion: 2, platform: "win32", arch: "x64", sha256: "b".repeat(64), nodeSha256: sha256(NODE_BYTES), runtimeDigest: RUNTIME_DIGEST, toolManifestHash: TOOL_MANIFEST_HASH }), /work_device_integrity_failed/);
  await assert.rejects(verifyWorkDevice(honest, null), /work_device_manifest_invalid/);
});

test("a tampered Node runtime or bundle file is refused before spawn", async (t) => {
  const node = await payload(t);
  await fs.writeFile(path.join(node, WORK_DEVICE_NODE_FILE), Buffer.from("tampered node"));
  await assert.rejects(verifyWorkDevice(node), /work_device_integrity_failed/);
  const bundle = await payload(t);
  await fs.writeFile(path.join(bundle, WORK_DEVICE_BUNDLE_DIR, "main.js"), Buffer.from("tampered bundle"));
  await assert.rejects(verifyWorkDevice(bundle), /work_device_integrity_failed/);
  // A foreign runtime_digest pin is refused even though every byte is intact.
  const foreign = await payload(t);
  await assert.rejects(verifyWorkDevice(foreign, { protocolVersion: 2, platform: "win32", arch: "x64", sha256: sha256(EXE_BYTES), nodeSha256: sha256(NODE_BYTES), runtimeDigest: "0".repeat(64), toolManifestHash: TOOL_MANIFEST_HASH }), /work_device_integrity_failed/);
});

test("extra files, a wrong manifest file name and empty payloads are refused", async (t) => {
  const extra = await payload(t);
  await fs.writeFile(path.join(extra, "extra.dll"), "x");
  await assert.rejects(verifyWorkDevice(extra), /work_device_inventory_invalid/);
  const wrongName = await payload(t);
  await fs.writeFile(path.join(wrongName, "manifest.json"), JSON.stringify({ file: "other.exe", sha256: "a".repeat(64), nodeSha256: "b".repeat(64), runtimeDigest: "c".repeat(64), toolManifestHash: "d".repeat(64) }));
  await assert.rejects(verifyWorkDevice(wrongName), /work_device_manifest_invalid/);
  const empty = await payload(t, Buffer.alloc(0));
  await assert.rejects(verifyWorkDevice(empty), /work_device_manifest_invalid/);
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "work-broker-empty-"));
  t.after(() => fs.rm(missing, { recursive: true, force: true }));
  await assert.rejects(verifyWorkDevice(missing), /work_device_manifest_invalid/);
});

test("start spawns the verified executable with the closed config argv and waits for the ready line", windows, async (t) => {
  const root = await payload(t);
  const child = fakeChild();
  const spawns = mockSpawn(t, child);
  const supervisor = new BrokerSupervisor();
  const pipeName = `\\\\.\\pipe\\work-device-${randomUUID()}`;
  const starting = supervisor.start(root, "C:\\config\\broker.json", pipeName);
  await delay(10);
  // The ready line may arrive split across chunks; the supervisor accumulates stderr.
  child.stderr.push(`booting…\npipe ${pipeName.slice(0, 20)}`);
  child.stderr.push(`${pipeName.slice(20)} ready\n`);
  await starting;
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].executable, path.join(root, WORK_DEVICE_FILE));
  assert.deepEqual(spawns[0].args, ["C:\\config\\broker.json"]);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.deepEqual(spawns[0].options.stdio, ["ignore", "ignore", "pipe"]);
  const code = await supervisor.stop();
  assert.equal(code, 1);
  assert.equal(child.killed, true);
});

test("a child that exits before ready fails the start and lands in the exit ledger", windows, async (t) => {
  const root = await payload(t);
  const child = fakeChild();
  const spawns = mockSpawn(t, child);
  const supervisor = new BrokerSupervisor();
  const events = [];
  supervisor.on("state", (event) => events.push(event));
  const starting = supervisor.start(root, "broker.json", "pipe-x");
  const deadline = Date.now() + 5000;
  while (spawns.length === 0 && Date.now() < deadline) await delay(5);
  assert.equal(spawns.length, 1, "the child must spawn before the simulated early exit");
  child.stderr.push("fatal: bad config\n");
  child.emit("exit", 2, null);
  await assert.rejects(starting, /work_device_start_failed/);
  const terminated = events.find((event) => event.event === "terminated");
  assert.equal(terminated.code, 2);
  assert.match(terminated.stderr, /fatal: bad config/);
});

test("the stderr ledger is capped and a second start or a closed supervisor is refused", windows, async (t) => {
  const root = await payload(t);
  const child = fakeChild();
  mockSpawn(t, child);
  const supervisor = new BrokerSupervisor();
  const pipeName = "pipe-cap";
  const starting = supervisor.start(root, "broker.json", pipeName);
  await delay(10);
  child.stderr.push("x".repeat(70000));
  child.stderr.push(`pipe ${pipeName} ready\n`);
  await starting;
  await assert.rejects(supervisor.start(root, "broker.json", pipeName), /work_device_unavailable/);
  const events = [];
  supervisor.on("state", (event) => events.push(event));
  await supervisor.stop();
  const terminated = events.find((event) => event.event === "terminated");
  assert.ok(terminated.stderr.length <= 65536);
  assert.ok(terminated.stderr.endsWith(`pipe ${pipeName} ready\n`));
  await assert.rejects(supervisor.start(root, "broker.json", pipeName), /work_device_unavailable/);
});

test("an unverifiable payload never spawns", windows, async (t) => {
  const root = await payload(t);
  await fs.writeFile(path.join(root, WORK_DEVICE_FILE), Buffer.from("tampered"));
  const spawns = mockSpawn(t, fakeChild());
  const supervisor = new BrokerSupervisor();
  await assert.rejects(supervisor.start(root, "broker.json", "pipe-x"), /work_device_integrity_failed/);
  assert.equal(spawns.length, 0);
});
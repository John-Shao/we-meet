const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const analyzer = require("../scripts/work-os-evidence-analyze.cjs");

const START = Date.parse("2026-11-27T00:00:00.000Z");
const PIDS = { main: 100, viewer: 200, broker: 300 };

function event(pid, data, offset = 2000) {
  const fields = Object.entries(data)
    .map(([name, value]) => `<Data Name="${name}">${value}</Data>`)
    .join("");
  return `<Event><System><TimeCreated SystemTime="${new Date(START + offset).toISOString()}"/><Execution ProcessID="${pid}"/></System><EventData>${fields}</EventData></Event>`;
}

function xml(events) {
  return `<?xml version="1.0" encoding="utf-8"?><Events>${events.join("")}</Events>`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function bundle(directory, options) {
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    "net.xml": xml(options.net ?? []),
    "dns.xml": xml(options.dns ?? []),
    "file.xml": xml(options.file ?? []),
    "pipe.xml": xml(options.pipe ?? []),
  };
  const manifestFiles = [];
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
    manifestFiles.push({
      name,
      bytes: Buffer.byteLength(content),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  writeJson(path.join(directory, "collection.json"), {
    schemaVersion: 1,
    status: "stopped",
    files: manifestFiles,
  });
}

function negativeBundle(directory, overrides = {}) {
  bundle(directory, overrides);
  writeJson(path.join(directory, "idle-marker.json"), { at: START + 1000 });
  writeJson(path.join(directory, "idle-receipt.json"), {
    passed: true,
    idleOnly: true,
    pids: PIDS,
    viewerGestureObserved: false,
    acceptanceRestCount: 0,
    prepareLocalAcceptancePipeFrameCount: 0,
    testedAt: new Date(START + 5000).toISOString(),
  });
  fs.writeFileSync(path.join(directory, "acceptance-pipe.log"), "");
}

function positiveBundle(directory) {
  bundle(directory, {
    net: [event(PIDS.viewer, { LocalAddress: "127.0.0.1", RemoteAddress: "127.0.0.1" })],
    file: [event(PIDS.broker, { FileName: "D:\\workspace\\we-meet\\journal.db", DesiredAccess: "2" })],
    pipe: [event(PIDS.viewer, { PipeName: "work-device-test" })],
  });
  writeJson(path.join(directory, "receipt.json"), {
    pids: PIDS,
    viewerGestureObserved: true,
    acceptanceRestCount: 1,
    prepareLocalAcceptancePipeFrameCount: 1,
    testedAt: new Date(START + 10_000).toISOString(),
  });
  fs.writeFileSync(
    path.join(directory, "acceptance-pipe.log"),
    `${JSON.stringify({ direction: "request", method: "prepareLocalAcceptance" })}\n`,
  );
}

function options(root) {
  return {
    evidenceDir: path.join(root, "negative"),
    positiveDir: path.join(root, "positive"),
    protectedPaths: ["D:\\workspace\\we-meet"],
    allowedDns: [],
  };
}

test("clean negative window plus real positive control passes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-os-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = options(root);
  negativeBundle(opts.evidenceDir);
  positiveBundle(opts.positiveDir);
  const verdict = analyzer.run(opts);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.negative.violations.length, 0);
  assert.equal(verdict.positive.networkEvents, 1);
  assert.equal(verdict.positive.fileEvents, 1);
});

test("network DNS protected writes and acceptance pipe frames fail closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-os-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = options(root);
  negativeBundle(opts.evidenceDir, {
    net: [event(PIDS.viewer, { LocalAddress: "127.0.0.1", RemoteAddress: "203.0.113.9" })],
    dns: [event(PIDS.viewer, { QueryName: "evil.test" })],
    file: [event(PIDS.broker, { FileName: "D:\\workspace\\we-meet\\journal.db", DesiredAccess: "2" })],
  });
  fs.writeFileSync(
    path.join(opts.evidenceDir, "acceptance-pipe.log"),
    `${JSON.stringify({ direction: "request", method: "prepareLocalAcceptance" })}\n`,
  );
  positiveBundle(opts.positiveDir);
  assert.throws(() => analyzer.run(opts));
});

test("individual OS violations are reported with process evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-os-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = options(root);
  negativeBundle(opts.evidenceDir, {
    net: [event(PIDS.viewer, { LocalAddress: "127.0.0.1", RemoteAddress: "203.0.113.9" })],
    dns: [event(PIDS.viewer, { QueryName: "evil.test" })],
    file: [event(PIDS.broker, { FileName: "D:\\workspace\\we-meet\\journal.db", DesiredAccess: "2" })],
  });
  const verdict = analyzer.analyzeNegative(opts);
  assert.equal(verdict.passed, false);
  assert.deepEqual(new Set(verdict.violations.map((item) => item.kind)),
    new Set(["network", "dns", "file"]));
});

test("tampered and unrecognized observer output cannot pass as zero", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-os-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = options(root);
  negativeBundle(opts.evidenceDir);
  fs.appendFileSync(path.join(opts.evidenceDir, "net.xml"), "tampered");
  assert.throws(() => analyzer.analyzeNegative(opts), /hash mismatch/);
  negativeBundle(opts.evidenceDir, { net: [] });
  fs.writeFileSync(path.join(opts.evidenceDir, "net.xml"), "<html>not ETW</html>");
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.evidenceDir, "collection.json")));
  manifest.files.find((item) => item.name === "net.xml").sha256 =
    crypto.createHash("sha256").update("<html>not ETW</html>").digest("hex");
  writeJson(path.join(opts.evidenceDir, "collection.json"), manifest);
  assert.throws(() => analyzer.analyzeNegative(opts), /unrecognized ETW XML/);
});

test("a negative-only bundle is incomplete without a positive control", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-os-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = options(root);
  negativeBundle(opts.evidenceDir);
  assert.throws(() => analyzer.run(opts), /ENOENT|positive/);
});

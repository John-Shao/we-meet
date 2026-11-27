const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const TARGET_METHODS = new Set([
  "prepareLocalAcceptance",
  "acceptLocalArtifactVersion",
]);

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseEtwXml(xml) {
  if (!/<(?:Events|Root|EventList)\b/.test(xml) && !/<Event\b/.test(xml)) {
    throw new Error("unrecognized ETW XML output");
  }
  const events = [];
  for (const match of xml.matchAll(/<Event\b[\s\S]*?<\/Event>/g)) {
    const block = match[0];
    const time = block.match(/<TimeCreated\b[^>]*SystemTime="([^"]+)"/)?.[1];
    const pid = block.match(/<Execution\b[^>]*ProcessID="(\d+)"/)?.[1];
    if (!time || !pid || !Number.isFinite(Date.parse(time))) {
      throw new Error("ETW event is missing a parseable time or PID");
    }
    const data = {};
    for (const field of block.matchAll(
      /<Data\b[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Data>/g,
    )) {
      data[decodeXml(field[1])] = decodeXml(field[2]);
    }
    events.push({ time: Date.parse(time), pid, data });
  }
  return events;
}

function inWindow(event, start, end) {
  return event.time >= start && event.time <= end;
}

function isLoopback(value) {
  const address = value.replace(/^[[]|[]]$/g, "").split("%")[0];
  if (net.isIP(address) === 4) return address.startsWith("127.");
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:");
  }
  return false;
}

function eventAddresses(event) {
  const addresses = [];
  for (const [name, value] of Object.entries(event.data)) {
    if (!/(?:Address|Addr|IP)$/i.test(name)) continue;
    for (const candidate of value.match(
      /(?:\[[^\]]+\]|[0-9a-fA-F:.]+)(?:%\d+)?/g,
    ) ?? []) {
      if (net.isIP(candidate) || net.isIP(candidate.replace(/^\[|\]$/g, ""))) {
        addresses.push(candidate);
      }
    }
  }
  return addresses;
}

function targetPids(receipt) {
  const pids = receipt?.pids ?? {};
  return new Set(
    [pids.main, pids.viewer, pids.broker]
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .map(String),
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyManifest(directory) {
  const manifest = readJson(path.join(directory, "collection.json"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.status, "stopped");
  const files = [];
  for (const entry of manifest.files) {
    const file = path.join(directory, entry.name);
    assert.equal(sha256(file), entry.sha256, `hash mismatch: ${entry.name}`);
    files.push(file);
  }
  for (const required of ["net.xml", "dns.xml", "file.xml", "pipe.xml"]) {
    assert.ok(files.some((file) => path.basename(file) === required), `missing ${required}`);
  }
  return manifest;
}

function readEvents(directory, name) {
  return parseEtwXml(fs.readFileSync(path.join(directory, name), "utf8"));
}

function pipeRequestCount(file) {
  if (!fs.existsSync(file)) return null;
  let count = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.direction === "request" && TARGET_METHODS.has(frame.method)) count += 1;
  }
  return count;
}

function analyzeNegative(options) {
  const directory = path.resolve(options.evidenceDir);
  const manifest = verifyManifest(directory);
  const marker = readJson(path.join(directory, "idle-marker.json"));
  const receipt = readJson(path.join(directory, "idle-receipt.json"));
  const start = Number(marker.at);
  const end = Date.parse(receipt.testedAt);
  assert.ok(Number.isSafeInteger(start) && Number.isFinite(end) && end >= start);
  const pids = targetPids(receipt);
  assert.ok(pids.size >= 2, "idle receipt is missing process IDs");
  assert.equal(receipt.passed, true);
  assert.equal(receipt.idleOnly, true);
  assert.equal(receipt.viewerGestureObserved, false);
  assert.equal(receipt.acceptanceRestCount, 0);
  assert.equal(receipt.prepareLocalAcceptancePipeFrameCount, 0);

  const pipeLog = path.join(directory, "acceptance-pipe.log");
  const pipeCount = pipeRequestCount(pipeLog);
  assert.notEqual(pipeCount, null, "acceptance pipe log is missing");
  assert.equal(pipeCount, 0);

  const violations = [];
  const netEvents = readEvents(directory, "net.xml").filter((event) =>
    inWindow(event, start, end),
  );
  for (const event of netEvents) {
    if (!pids.has(event.pid)) continue;
    const external = eventAddresses(event).filter((address) => !isLoopback(address));
    if (external.length) {
      violations.push({ kind: "network", pid: event.pid, addresses: external });
    }
  }

  const dnsEvents = readEvents(directory, "dns.xml").filter((event) =>
    inWindow(event, start, end),
  );
  for (const event of dnsEvents) {
    const query = Object.entries(event.data).find(([name]) =>
      /^(?:QueryName|Name|DomainName)$/i.test(name),
    )?.[1];
    if (!query) continue;
    const expected = options.allowedDns.some((suffix) =>
      query.toLowerCase() === suffix ||
      query.toLowerCase().endsWith(`.${suffix}`),
    );
    if ((pids.has(event.pid) || /evil\.test/i.test(query)) && !expected) {
      violations.push({ kind: "dns", pid: event.pid, query });
    }
  }

  const fileEvents = readEvents(directory, "file.xml").filter((event) =>
    inWindow(event, start, end),
  );
  for (const event of fileEvents) {
    if (!pids.has(event.pid)) continue;
    const fileName = Object.entries(event.data).find(([name]) =>
      /^(?:FileName|Path|OpenName)$/i.test(name),
    )?.[1];
    if (!fileName) continue;
    const normalized = fileName.replaceAll("\\", "/").toLowerCase();
    const protectedPath = options.protectedPaths.find((prefix) =>
      normalized.startsWith(prefix.replaceAll("\\", "/").toLowerCase()),
    );
    if (!protectedPath) continue;
    const desiredAccess = event.data.DesiredAccess;
    const disposition = event.data.CreateDisposition;
    const access = desiredAccess ? Number.parseInt(desiredAccess, 16) : NaN;
    const create = disposition ? Number.parseInt(disposition, 10) : NaN;
    const writes = (Number.isFinite(access) && (access & 0x10006) !== 0) ||
      (Number.isFinite(create) && create > 1);
    if (writes || (!Number.isFinite(access) && !Number.isFinite(create))) {
      violations.push({ kind: "file", pid: event.pid, path: fileName });
    }
  }

  readEvents(directory, "pipe.xml");
  return {
    passed: violations.length === 0,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    pids: [...pids],
    observed: {
      network: netEvents.length,
      dns: dnsEvents.length,
      file: fileEvents.length,
      pipeRequests: pipeCount,
    },
    violations,
    manifest,
  };
}

function analyzePositive(options) {
  const directory = path.resolve(options.positiveDir);
  verifyManifest(directory);
  const receipt = readJson(path.join(directory, "receipt.json"));
  const pids = targetPids(receipt);
  assert.ok(pids.size >= 2, "positive receipt is missing process IDs");
  assert.equal(receipt.viewerGestureObserved, true);
  assert.ok(receipt.acceptanceRestCount > 0);
  assert.ok(receipt.prepareLocalAcceptancePipeFrameCount > 0);
  const pipeCount = pipeRequestCount(path.join(directory, "acceptance-pipe.log"));
  assert.ok(pipeCount > 0, "positive pipe log has no acceptance request");
  const start = Date.parse(receipt.testedAt) - 120_000;
  const end = Date.parse(receipt.testedAt);
  const netCount = readEvents(directory, "net.xml").filter(
    (event) => pids.has(event.pid) && inWindow(event, start, end),
  ).length;
  const fileCount = readEvents(directory, "file.xml").filter(
    (event) => pids.has(event.pid) && inWindow(event, start, end),
  ).length;
  assert.ok(netCount > 0, "positive control has no target process network events");
  assert.ok(fileCount > 0, "positive control has no target process file events");
  return {
    passed: true,
    acceptanceRestCount: receipt.acceptanceRestCount,
    prepareLocalAcceptancePipeFrameCount: receipt.prepareLocalAcceptancePipeFrameCount,
    networkEvents: netCount,
    fileEvents: fileCount,
  };
}

function parseArgs(argv) {
  const options = {
    evidenceDir: null,
    positiveDir: null,
    protectedPaths: [],
    allowedDns: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--evidence-dir") options.evidenceDir = argv[++i];
    else if (arg === "--positive-dir") options.positiveDir = argv[++i];
    else if (arg === "--protected-path") options.protectedPaths.push(argv[++i]);
    else if (arg === "--allowed-dns") options.allowedDns.push(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  assert.ok(options.evidenceDir, "--evidence-dir is required");
  assert.ok(options.positiveDir, "--positive-dir is required");
  assert.ok(options.protectedPaths.length > 0, "--protected-path is required");
  return options;
}

function run(options) {
  const negative = analyzeNegative(options);
  const positive = analyzePositive(options);
  return {
    schemaVersion: 1,
    passed: negative.passed && positive.passed,
    negative,
    positive,
  };
}

module.exports = {
  analyzeNegative,
  analyzePositive,
  isLoopback,
  parseEtwXml,
  pipeRequestCount,
  run,
};

if (require.main === module) {
  try {
    const verdict = run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.passed ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ passed: false, error: error.message }));
    process.exitCode = 2;
  }
}

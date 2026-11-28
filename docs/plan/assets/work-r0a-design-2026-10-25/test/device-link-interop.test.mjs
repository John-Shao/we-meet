// 2026-11-17 (GW17). A1 is the first batch where the SHIPPED Rust device link talks to the
// SHIPPED Go gateway over real platform mTLS and a real PostgreSQL chain. That evidence only
// exists if CI actually builds the probe and hands it to the Go suite: without
// WORK_DEVICE_INTEROP_BIN the interop test SKIPS, and a green job would then prove nothing about
// the cross-language contract. This guard pins that wiring, plus the boundaries that were
// measured rather than assumed and are one edit away from being silently lost:
//   - the probe drives transport::link::Link, not a reimplementation of the device side;
//   - schannel's Identity::from_pkcs8 is RSA-only, so an EC P-256 identity must go via PKCS#12;
//   - an empty PEM handed to schannel is a process crash, so the guards must precede the call;
//   - the hello must be queued before `streaming` is awaited, and `ready()` must precede it;
//   - every server downlink states recovery_generation explicitly (the device's u64 adapter
//     refuses the Go zero value ""), which is the break this batch found and fixed.
//
// Deliberately NOT asserted here: that the link consumes downlinks or spawns/kills sidecars.
// The lead ruled A1 = link only; every non-lease downlink is forwarded verbatim and the actual
// kill stays with the Node batch. A gate demanding consumption would be demanding unruled scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const DEVICE = join(ROOT, 'src', 'device');
const GATEWAY = join(ROOT, 'src', 'work', 'internal', 'gateway');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'work-r0a-gates.yml');
const read = (p) => readFileSync(p, 'utf8');
// Comments state intent; only code lines may satisfy a structural assertion.
const code = (t) => t.split(/\r?\n/).filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');

const PROBE = join(DEVICE, 'examples', 'device_link_probe.rs');
const TLS = join(DEVICE, 'src', 'transport', 'tls.rs');
const LINK = join(DEVICE, 'src', 'transport', 'link.rs');
const TICKET = join(DEVICE, 'src', 'ipc', 'ticket.rs');
const SCHEMA = join(DEVICE, 'src', 'ipc', 'schema.rs');
const INTEROP = join(GATEWAY, 'interop_test.go');
const WIRE = join(GATEWAY, 'envelope_wire_test.go');

for (const p of [PROBE, TLS, LINK, TICKET, SCHEMA, INTEROP, WIRE, WORKFLOW]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

const yaml = read(WORKFLOW);
// A job runs from its own `  name:` line to the next line at the same two-space indent.
const jobSection = (name) => {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} not found in the workflow`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  \S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
};
const stepsOf = (job) => job.split(/\n(?= {6}- )/).slice(1);

test('the Linux Go job builds the probe and hands it to the suite that needs it', () => {
  const job = jobSection('go-migrate');
  const steps = stepsOf(job);
  const build = steps.find((s) => s.includes('cargo build --example device_link_probe'));
  assert.ok(build, 'go-migrate never builds the Rust probe, so the interop would skip');
  assert.match(build, /working-directory: src\/device/);

  const suite = steps.find((s) => s.includes('go test ./... -p 1 -count=1'));
  assert.ok(suite, 'go-migrate lost the serial full-suite command');
  // The env must sit in the SAME step as the suite: a job-level env elsewhere would not reach it.
  assert.match(suite, /WORK_DEVICE_INTEROP_BIN:/);
  assert.match(suite, /src\/device\/target\/debug\/examples\/device_link_probe/);
  assert.ok(steps.indexOf(build) < steps.indexOf(suite), 'the probe must be built before the suite runs');

  // The Go constant and the CI env name are one contract; a rename on either side silences the
  // evidence by turning the interop back into a skip.
  const goEnv = read(INTEROP).match(/interopBinEnv = "([^"]+)"/);
  assert.ok(goEnv, 'interop_test.go no longer names its env constant');
  assert.equal(goEnv[1], 'WORK_DEVICE_INTEROP_BIN');
  assert.ok(suite.includes(goEnv[1]), 'the CI env name drifted from the Go constant');
});

test('a device-side change triggers the job that carries the cross-language evidence', () => {
  const pr = yaml.slice(yaml.indexOf('  pull_request:'), yaml.indexOf('  push:'));
  const push = yaml.slice(yaml.indexOf('  push:'), yaml.indexOf('permissions:'));
  for (const [name, block] of [['pull_request', pr], ['push', push]]) {
    assert.ok(block.includes("- 'src/device/**'"), `${name} does not trigger on src/device`);
    assert.ok(block.includes("- 'src/work/**'"), `${name} does not trigger on src/work`);
  }
  // Neither side alone proves the contract, so both paths must appear exactly twice.
  assert.equal(yaml.split("- 'src/device/**'").length - 1, 2);
});

test('the interop skips without Rust but refuses a binary it cannot read', () => {
  const go = read(INTEROP);
  assert.match(go, /bin == ""/);
  assert.match(go, /t\.Skipf\(/, 'a developer without a Rust toolchain must still get the Go suite');
  assert.match(go, /os\.Stat\(bin\)/);
  // A set-but-unreadable path is a broken CI wiring, not a reason to skip silently.
  const statAt = go.indexOf('os.Stat(bin)');
  assert.match(go.slice(statAt, statAt + 200), /t\.Fatalf\(/);
  assert.match(go, /exec\.CommandContext\(ctx, bin, configPath\)/);
});

test('the interop asserts server-side truth, not just a happy probe report', () => {
  const go = read(INTEROP);
  for (const needle of [
    'newGatewayFixture(t)', 'f.startServer(t)', 'seedSecondTicket',
    'work.device_session', 'work.device_session_ticket',
    'superseded', 'consumed', 'alive_ms',
    'server_public_jwk', 'permit_public_jwk',
  ]) {
    assert.ok(go.includes(needle), `interop no longer asserts ${needle}`);
  }
  // A replayed client_request_id returns ticket:null (0040:1429), so a second hello needs a
  // second row. Reusing the first ticket would make the probe fail for the wrong reason.
  assert.match(go, /probeTicket := "ticket-" \+ uuid\.NewString\(\)/);
  // The certificate and the frame signature must be ONE key (§2.1).
  assert.match(go, /jwkThumbprint\(t, probeJWK\); got != f\.thumbprint/);
});

test('the fixture builds a schannel-importable PKCS#12 with the openssl CLI', () => {
  const go = read(INTEROP);
  // Go's standard library has no PKCS#12 encoder, and schannel's from_pkcs8 is RSA-only.
  assert.match(go, /exec\.LookPath\("openssl"\)/);
  assert.match(go, /"pkcs12", "-export"/);
  assert.match(go, /"-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"/);
  assert.match(go, /x509\.MarshalPKCS8PrivateKey\(f\.priv\)/);
  // Test-only and ephemeral: the archive wraps a test CA key inside t.TempDir().
  assert.match(go, /t\.TempDir\(\)/);
});

test('the probe drives the shipped Link and re-implements none of the device side', () => {
  const probe = read(PROBE);
  const src = code(probe);
  assert.match(src, /use work_device::transport::link::Link;/);
  assert.match(src, /Link::new\(config, Arc::new\(key\)\)/);
  // 批1a (F1甲): Link gained an independent uplink receiver between commands and events.
  // The probe produces no uplinks, so it hands Link a closed channel (tx dropped immediately).
  assert.match(src, /link\.run\(\s*ticket_rx,\s*command_rx,\s*\{[\s\S]*?mpsc::channel\(1\)[\s\S]*?drop\(tx\);[\s\S]*?\},\s*event_tx,?\s*\)/);
  // No envelope, no signature and no canonicalizer of its own: those are the crate's job.
  for (const forbidden of ['schema_version', 'sign_es256', 'jcs::', 'hello_ack']) {
    assert.ok(!src.includes(forbidden), `the probe re-implements ${forbidden} instead of using the crate`);
  }
  assert.match(src, /SoftwareKey::from_bytes/);
  assert.match(probe, /PROBE_REPORT /);
  // Not a production artifact: examples/ is outside src/ and outside cmd/, and nothing ships it.
  assert.ok(!read(join(DEVICE, 'src', 'main.rs')).includes('device_link_probe'));
  assert.ok(!read(join(DEVICE, 'Cargo.toml')).includes('device_link_probe'));
  assert.ok(!existsSync(join(DEVICE, 'cmd', 'device_link_probe')));
});

test('the connector loads an EC identity through PKCS#12, never the RSA-only PKCS#8 path', () => {
  const tls = read(TLS);
  const src = code(tls);
  assert.match(src, /Identity::from_pkcs12\(client_pkcs12, pkcs12_password\)/);
  assert.ok(!src.includes('from_pkcs8'), 'schannel from_pkcs8 hardcodes rsa_full; an EC P-256 identity cannot use it');
  // The measured reason stays written down, so the next reader does not "simplify" it to PEM.
  assert.match(tls, /rsa_full/);
  assert.match(tls, /PFXImportCertStore/);
  assert.match(src, /request_alpns\(ALPN_H2\)/);
  assert.match(src, /const ALPN_H2: &\[&str\] = &\["h2"\]/);
  // tonic 0.13 drives hyper 1.x, whose rt::Read/rt::Write are hyper's own traits.
  assert.match(src, /TokioIo::new\(tls\)/);
});

test('empty key material is refused before schannel can crash on it', () => {
  const src = code(read(TLS));
  const pemAt = src.indexOf('Certificate::from_pem');
  assert.ok(pemAt > 0);
  // Measured: Certificate::from_pem on a zero-length buffer is STATUS_ACCESS_VIOLATION, not Err.
  for (const guard of ['client_pkcs12.is_empty()', 'ca_pem.is_empty()']) {
    const at = src.indexOf(guard);
    assert.ok(at >= 0, `the ${guard} guard is gone`);
    assert.ok(at < pemAt, `${guard} must precede the platform call`);
  }
  assert.match(read(TLS), /STATUS_ACCESS_VIOLATION/);
});

test('native-tls carries alpn and a vendored OpenSSL so the Linux job needs no apt packages', () => {
  const manifest = read(join(DEVICE, 'Cargo.toml'));
  const line = manifest.split(/\r?\n/).find((l) => /^native-tls\s*=/.test(l));
  assert.ok(line, 'native-tls is no longer a direct dependency');
  assert.match(line, /"alpn"/);
  assert.match(line, /"vendored"/);
  assert.match(manifest, /^hyper-util = .*"tokio"/m);
  assert.match(manifest, /^tonic = .*"transport"/m);
});

test('the hello is queued before streaming is awaited, and ready() precedes it', () => {
  const link = code(read(LINK));
  // Scope to establish: drive() also sends uplink frames, and those come first in the file.
  const start = link.indexOf('async fn establish(');
  const end = link.indexOf('fn hello_envelope(', start);
  assert.ok(start >= 0 && end > start, 'establish is no longer a distinct function');
  const src = link.slice(start, end);
  const hello = src.indexOf('hello_envelope(config, key, ticket)');
  const send = src.indexOf('.send(Bytes::from(raw))');
  const ready = src.indexOf('grpc.ready()');
  const streaming = src.indexOf('.streaming(');
  for (const [name, at] of [['hello build', hello], ['hello send', send], ['ready', ready], ['streaming', streaming]]) {
    assert.ok(at >= 0, `establish lost the ${name} step`);
  }
  // grpc-go emits no response headers until the hello arrives, and `streaming` resolves on those
  // headers: sending afterwards deadlocks both sides. Skipping ready() panics in tower's Buffer.
  assert.ok(hello < send && send < ready && ready < streaming,
    'establish must build → queue the hello → ready() → streaming, in that order');
});

test('the shell closure carries the ticket method and the broker agrees on its name', () => {
  const schema = read(SCHEMA);
  const ticket = read(TICKET);
  const member = '"deliverDeviceSessionTicket"';
  const closure = schema.slice(schema.indexOf('pub const SHELL_METHODS'), schema.indexOf('];', schema.indexOf('pub const SHELL_METHODS')));
  assert.ok(closure.includes(member), 'deliverDeviceSessionTicket left the shell closure');
  // artifact_edit adds four internal carriers including draft discovery; acceptance and rebind listing add two: 29.
  assert.match(schema, /assert_eq!\(SHELL_METHODS\.len\(\), 31\)/);
  for (const method of ['"openLocalContent"', '"confirmLocalSubmission"', '"listLocalArtifactDrafts"',
    '"prepareLocalArtifactEdit"', '"decideLocalArtifactEdit"', '"completeLocalArtifactEdit"',
    '"prepareLocalAcceptance"', '"listWorkspaceGrants"']) {
    assert.ok(closure.includes(method), `${method} left the shell closure`);
  }
  for (const confirm of ['"confirmWorkspaceRoot"', '"confirmLocalModel"']) {
    assert.ok(closure.includes(confirm), `${confirm} left the shell closure`);
  }
  const method = ticket.match(/pub const METHOD: &str = "([^"]+)"/);
  assert.ok(method, 'ticket.rs no longer names its method');
  assert.equal(`"${method[1]}"`, member);
  // The closed field set and the mint's output shape (0040:1469 sha256 hex, 64 chars).
  for (const field of ['device_id', 'method', 'request_id', 'session_ticket_id', 'ticket']) {
    assert.ok(ticket.includes(`"${field}"`), `ticket delivery lost the ${field} member`);
  }
  assert.match(code(ticket), /ticket\.len\(\) != 64/);
});

test('the broker ticket TTL is the mint TTL, not a guessed constant', () => {
  const ttl = read(TICKET).match(/pub const TICKET_TTL: Duration = Duration::from_secs\((\d+)\)/);
  assert.ok(ttl, 'TICKET_TTL is no longer a whole-second constant');
  const mint = read(join(ROOT, 'src', 'work', 'migrations', 'increments',
    '0040_device_identity_and_workspace_grants.sql'));
  // Scope to the ticket mint: 0040 also mints 120-second and 8-hour expiries for other tickets.
  const fnAt = mint.indexOf('CREATE FUNCTION work.mint_device_session_ticket(');
  assert.ok(fnAt >= 0, 'mint_device_session_ticket is no longer in 0040');
  const body = mint.slice(fnAt, mint.indexOf('\n$$;', fnAt));
  const line = body.split(/\r?\n/).find((l) => l.includes('v_expires := now() + interval'));
  assert.ok(line, 'the mint no longer states its expiry');
  const seconds = line.match(/interval '(\d+) seconds'/);
  assert.ok(seconds, `cannot read the mint TTL from ${line}`);
  assert.equal(ttl[1], seconds[1], 'the broker would retire a ticket the cloud still honors, or keep a dead one');
});

test('no server downlink leaves recovery_generation at the Go zero value', () => {
  const files = readdirSync(GATEWAY).filter((f) => f.endsWith('.go'));
  let stated = 0;
  for (const file of files) {
    const src = code(read(join(GATEWAY, file)));
    assert.ok(!/RecoveryGeneration:\s*""/.test(src),
      `${file} emits recovery_generation:"", which the device's u64 adapter refuses`);
    stated += (src.match(/RecoveryGeneration:/g) || []).length;
  }
  assert.ok(stated >= 8, `only ${stated} downlink builders state the generation; there are eight`);
  // The device side really parses it, so the boundary is measured rather than invented.
  assert.match(code(read(join(DEVICE, 'src', 'frame', 'u64string.rs'))), /text\.parse::<u64>\(\)/);
});

test('the wire gate covers every downlink builder and the shared signed path', () => {
  const wire = read(WIRE);
  for (const name of [
    'hello_ack', 'receipt_ack', 'reconcile_ack', 'checkpoint_ack', 'run_finish_ack',
    'action_prepared', 'lease', 'operation_resolution',
    'run_offer', 'run_start', 'command', 'cancel',
  ]) {
    assert.ok(wire.includes(`"${name}"`), `the wire gate no longer covers ${name}`);
  }
  assert.match(wire, /strconv\.ParseUint\(env\.RecoveryGeneration, 10, 64\)/);
  assert.match(wire, /len\(fields\) != 10/);
  assert.match(wire, /signedDownlink\(key, frameType/);
});
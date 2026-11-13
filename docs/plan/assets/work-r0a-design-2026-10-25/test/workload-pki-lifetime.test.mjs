// 2026-11-13, external review #6 (workload identity is an 825-day leaf with no revocation path).
// What this file does is narrower than the finding: the SHIPPED DEFAULT IS NOT AUTHORISED TO CHANGE,
// so B5 only makes the lifetime an explicit knob, refuses nonsense, and gives the whole thing a
// reader. `src/work/deploy/ecs/init-workload-pki.sh` had zero coverage before this file - work-
// glossary.md #97 left it as one of two R0b-paused scripts, and R0b moved to the main line on
// 2026-11-09.
//
// The segments below are cut out of the shipped file by anchor, so what runs here is the shipped
// text, not a copy of it. Deliberately NOT executed: the EUID root gate and the group gate (security
// controls that must not be relaxed to make a test pass), the `umask 077`/`chown` block, and the
// hard-coded /etc/work/runtime-ca target. Those are pinned statically. The renewal and revocation
// decisions the knob cannot answer by itself are filed as a card, not decided here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePackager, packagedNames } from '../release-payload.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const DEPLOY_DIR = join(REPO, 'src', 'work', 'deploy', 'ecs');
const SCRIPT = join(DEPLOY_DIR, 'init-workload-pki.sh');
const AUTHZ_MAIN = join(REPO, 'src', 'work', 'cmd', 'work-authz', 'main.go');
const REGISTRY_STORE = join(REPO, 'src', 'work', 'internal', 'authz', 'registry_store.go');
const PACKAGER = join(DEPLOY_DIR, 'make-release.sh');
const ROLLOUT = join(DEPLOY_DIR, 'rollout-r0a-0027.sh');

const text = readFileSync(SCRIPT, 'utf8');
const code = text
  .split(/\r?\n/)
  .filter((line) => !/^\s*#(?!if|endif|include)/.test(line))
  .join('\n');

// The three pieces the harness re-assembles, each located by an anchor that has to be where the
// behaviour claims it is. A moved anchor makes the slice wrong, so the ordering is asserted before
// any slice is handed to bash.
const knobAt = code.indexOf('LEAF_DAYS="');
const rootGateAt = code.indexOf('if [[ "$(id -u)" -ne 0 ]]');
const caAt = code.indexOf('if [[ ! -f "$DIR/ca.key" ]]');
const issueAt = code.indexOf('issue() {');
const callAt = code.indexOf('\nissue work-authz server');
for (const [name, at] of [
  ['the leaf knob', knobAt],
  ['the root gate', rootGateAt],
  ['the CA block', caAt],
  ['issue()', issueAt],
  ['the first issue call', callAt],
]) {
  assert.ok(at >= 0, `the shipped script must still contain ${name} verbatim - this read is broken`);
}
assert.ok(knobAt < rootGateAt && rootGateAt < caAt && caAt < issueAt && issueAt < callAt,
  'knobs must resolve before the root gate, and the root gate before any certificate is minted');

const knobSeg = code.slice(knobAt, rootGateAt);
const caSeg = code.slice(caAt, issueAt);
const issueSeg = code.slice(issueAt, callAt);
const echoAt = code.indexOf('echo "configured lifetimes:');
assert.ok(echoAt >= 0, 'the script must print the lifetimes it applied');
const echoSeg = code.slice(echoAt, code.indexOf('\n', echoAt));
assert.ok(knobSeg.includes('CA_DAYS="${WORK_RUNTIME_CA_DAYS') && !knobSeg.includes('id -u'),
  'the knob slice must carry both knobs and none of the root gate');
assert.ok(issueSeg.includes('-CAcreateserial') && !issueSeg.includes('issue work-authz'),
  'the issue() slice must stop before the real workload names are issued');
assert.ok(echoSeg.includes('${LEAF_DAYS}') && echoSeg.includes('${CA_DAYS}') && !echoSeg.includes('chown'),
  'the printed line must interpolate both knobs and stop before the ownership block');

// The lifetimes the running host was minted with. Pinned so editing either value goes red in review
// rather than at the next handshake.
const DEFAULT_LEAF_DAYS = 825;
const DEFAULT_CA_DAYS = 3650;

// Two environment dialects, both of them the sandbox and neither of them a shipped defect: the
// script is a Linux-root deploy file. (1) Git Bash rewrites an argument that looks like an absolute
// path, so `-subj "/CN=work-runtime-ca"` reaches openssl as "D:/Program Files/Git/CN=...". (2) MSYS
// mktemp() prints "/tmp/...", which the native openssl build cannot open, so on Windows only a
// PATH-prepended shim re-dialects that one temp path. The shipped lines themselves are never edited,
// and no shim is installed on Linux.
const toOpensslPath = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);

const baseEnv = () => ({
  ...process.env,
  ...(process.platform === 'win32' ? { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } : {}),
});

const runSh = (args, env = baseEnv()) => spawnSync('bash', args, { encoding: 'utf8', env });

// The shim is created only on Windows, and it calls the real mktemp by ABSOLUTE path: `command
// mktemp` still searches PATH, so a shim that resolves itself re-enters forever. That mistake
// cost ~5,800 orphaned sh processes on 2026-11-13, which is why the absolute path is a hard
// precondition rather than a fallback.
const mktempProbe = runSh(['-c', 'command -v mktemp']);
const realMktemp = mktempProbe.stdout.trim();

const shimDir = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'pki-mktemp-shim-')) : null;
if (shimDir) {
  assert.ok(/^\/[A-Za-z0-9_./-]+\/mktemp$/.test(realMktemp),
    `the shim needs the absolute real mktemp, got "${realMktemp}" - refusing to install a shim that could recurse`);
  writeFileSync(join(shimDir, 'mktemp'), [
    '#!/bin/sh',
    `real_mktemp='${realMktemp}'`,
    'out="$("$real_mktemp" "$@")" || exit 1',
    'path="$(cygpath -m "$out" 2>/dev/null)"',
    'printf \'%s\\n\' "${path:-$out}"',
    '',
  ].join('\n'));
  chmodSync(join(shimDir, 'mktemp'), 0o755);
  process.on('exit', () => rmSync(shimDir, { recursive: true, force: true }));
}

const childEnv = () => {
  const env = baseEnv();
  if (shimDir) env.PATH = `${shimDir}${delimiter}${env.PATH}`;
  return env;
};

const opensslMissing = runSh(['-c', 'command -v openssl >/dev/null && echo ok']);
assert.equal(opensslMissing.stdout.trim(), 'ok',
  'this gate executes the shipped openssl calls through bash and needs openssl - red, never skipped');

function harnessFor(dir) {
  const file = join(dir, 'run-shipped-segments.sh');
  writeFileSync(file, [
    'set -euo pipefail',
    `DIR="${toOpensslPath(dir)}"`,
    'OWNER=root',
    'GROUP=work-control',
    knobSeg,
    caSeg,
    issueSeg,
    'issue gate-leaf server "DNS:gate-leaf,IP:127.0.0.1"',
    echoSeg,
    '',
  ].join('\n'));
  return file;
}

// Month names are parsed by hand because Date.parse on the openssl timestamp form is not portable.
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const stampOf = (line) => {
  const m = /=([A-Za-z]{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s+GMT/.exec(line);
  assert.ok(m, `cannot read an openssl timestamp from: ${line}`);
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
};

const DAY_MS = 86_400_000;
const datesOf = (file, label) => {
  const out = runSh(['-c', 'openssl x509 -in "$1" -noout -startdate -enddate', 'x', toOpensslPath(file)]);
  assert.equal(out.status, 0, `openssl must read the ${label} this run minted: ${out.stderr}`);
  return out.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').map(stampOf);
};

const lifetimesIn = (dir) => {
  const [leafStart, leafEnd] = datesOf(join(dir, 'gate-leaf.crt'), 'leaf');
  const [caStart, caEnd] = datesOf(join(dir, 'ca.crt'), 'CA');
  return { leafDays: (leafEnd - leafStart) / DAY_MS, caDays: (caEnd - caStart) / DAY_MS, leafEnd };
};

test('the shipped defaults live in the knob lines, not inside the openssl calls', () => {
  assert.match(code, new RegExp(`LEAF_DAYS="\\$\\{WORK_RUNTIME_LEAF_DAYS:-${DEFAULT_LEAF_DAYS}\\}"`),
    'the leaf default must be a declared fallback, so an unset environment reproduces the shipped value');
  assert.match(code, new RegExp(`CA_DAYS="\\$\\{WORK_RUNTIME_CA_DAYS:-${DEFAULT_CA_DAYS}\\}"`),
    'the CA default likewise');
  assert.doesNotMatch(code, /-days\s+\d/, 'no bare -days literal may survive: two sources of truth is how a knob lies');
  assert.match(code, /openssl req -x509[^\n]*-days "\$CA_DAYS"/, 'the CA line must consume the CA knob');
  assert.match(code, /-CAcreateserial -days "\$LEAF_DAYS"/, 'the leaf line must consume the leaf knob');
});

test('a run with no environment still mints an 825-day leaf and a 3650-day CA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pki-default-'));
  try {
    const env = { ...childEnv() };
    delete env.WORK_RUNTIME_LEAF_DAYS;
    delete env.WORK_RUNTIME_CA_DAYS;
    const run = runSh([harnessFor(dir)], env);
    assert.equal(run.status, 0, `the shipped segments must issue cleanly: ${run.stderr}`);
    const got = lifetimesIn(dir);
    assert.equal(got.leafDays, DEFAULT_LEAF_DAYS, 'B5 was not authorised to move the shipped leaf lifetime');
    assert.equal(got.caDays, DEFAULT_CA_DAYS, 'nor the CA lifetime');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the knobs reach the certificate, not only the script text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pki-knob-'));
  try {
    const run = runSh([harnessFor(dir)], { ...childEnv(), WORK_RUNTIME_LEAF_DAYS: '7', WORK_RUNTIME_CA_DAYS: '30' });
    assert.equal(run.status, 0, `a short-lifetime run must succeed: ${run.stderr}`);
    const got = lifetimesIn(dir);
    assert.equal(got.leafDays, 7, 'WORK_RUNTIME_LEAF_DAYS has to be the number the leaf actually carries');
    assert.equal(got.caDays, 30, 'WORK_RUNTIME_CA_DAYS likewise');
    const verify = runSh(['-c', 'openssl verify -CAfile "$1/ca.crt" "$1/gate-leaf.crt"', 'x', toOpensslPath(dir)]);
    assert.equal(verify.status, 0, `the sliced segments must still form a valid chain: ${verify.stdout}${verify.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-numeric or zero lifetime is refused before a single key exists', () => {
  for (const bad of ['abc', '0', '-5', '7.5', '825x', ' 90']) {
    const dir = mkdtempSync(join(tmpdir(), 'pki-bad-'));
    try {
      const run = runSh([harnessFor(dir)], { ...childEnv(), WORK_RUNTIME_LEAF_DAYS: bad, WORK_RUNTIME_CA_DAYS: '3650' });
      assert.notEqual(run.status, 0, `WORK_RUNTIME_LEAF_DAYS="${bad}" must not be accepted`);
      assert.match(run.stderr, /WORK_RUNTIME_LEAF_DAYS/, `the refusal must name the knob the operator set: ${run.stderr}`);
      assert.ok(!existsSync(join(dir, 'ca.key')), 'validation has to precede any cryptographic material');
      assert.ok(!existsSync(join(dir, 'gate-leaf.crt')), 'and nothing may be issued on the rejected path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an explicitly empty knob falls back to the shipped default, it does not mint a zero-day leaf', () => {
  // `${VAR:-825}` is the declared semantics: empty means "not set". Pinned because the alternative
  // reading - empty reaching openssl as -days "" - would fail at the handshake instead of here.
  const dir = mkdtempSync(join(tmpdir(), 'pki-empty-'));
  try {
    const run = runSh([harnessFor(dir)], { ...childEnv(), WORK_RUNTIME_LEAF_DAYS: '', WORK_RUNTIME_CA_DAYS: '' });
    assert.equal(run.status, 0, `an empty knob is the unset case, not an error: ${run.stderr}`);
    const got = lifetimesIn(dir);
    assert.equal(got.leafDays, DEFAULT_LEAF_DAYS, 'and it must produce exactly the shipped lifetime');
    assert.equal(got.caDays, DEFAULT_CA_DAYS, 'for both knobs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a leaf longer than its CA is refused, because that chain cannot validate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pki-order-'));
  try {
    const run = runSh([harnessFor(dir)], { ...childEnv(), WORK_RUNTIME_LEAF_DAYS: '400', WORK_RUNTIME_CA_DAYS: '30' });
    assert.notEqual(run.status, 0, 'leaf longer than CA is not a deployable configuration');
    assert.match(run.stderr, /would not validate/, `the refusal has to say why: ${run.stderr}`);
    assert.ok(!existsSync(join(dir, 'ca.key')), 'the ordering check must also precede the CA');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-running keeps the existing certificate, so the knob cannot renew anything by itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pki-keep-'));
  try {
    const env = { ...childEnv(), WORK_RUNTIME_LEAF_DAYS: '90', WORK_RUNTIME_CA_DAYS: String(DEFAULT_CA_DAYS) };
    const first = runSh([harnessFor(dir)], env);
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(join(dir, 'gate-leaf.crt'), 'utf8');
    const firstEnd = lifetimesIn(dir).leafEnd;
    const second = runSh([harnessFor(dir)], env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /keep gate-leaf/, 'the idempotence branch is what makes a re-run safe');
    assert.equal(readFileSync(join(dir, 'gate-leaf.crt'), 'utf8'), before,
      'a live certificate must not be replaced just because a knob was set');
    assert.equal(lifetimesIn(dir).leafEnd, firstEnd, 'an untouched certificate keeps its expiry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the run prints the lifetimes it applied and says existing certificates are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pki-print-'));
  try {
    const env = { ...childEnv() };
    delete env.WORK_RUNTIME_LEAF_DAYS;
    delete env.WORK_RUNTIME_CA_DAYS;
    const run = runSh([harnessFor(dir)], env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`configured lifetimes: leaf ${DEFAULT_LEAF_DAYS}d, ca ${DEFAULT_CA_DAYS}d`),
      'the operator reads the effective value from the artifact that applied it');
    assert.match(run.stdout, /existing certificates are kept, not renewed/,
      'and the renewal gap travels with that line instead of living only in a design doc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the controls a lifetime knob could be used to relax are still in the shipped file', () => {
  assert.match(code, /if \[\[ "\$\(id -u\)" -ne 0 \]\]/, 'the root gate stays');
  assert.match(code, /echo "run as root"/, 'and its refusal');
  assert.match(code, /exit 1/, 'with a non-zero exit');
  assert.match(code, /getent group "\$GROUP"/, 'the service-account group check stays');
  assert.match(code, /umask 077/, 'the umask stays');
  assert.match(code, /chmod 600 "\$DIR\/ca\.key"/, 'the CA private key stays owner-only');
  assert.match(code, /-name '\*\.key' ! -name 'ca\.key'/,
    'and the blanket 640 must keep excluding ca.key, or any work-control service could mint certificates');
});

test('nothing in the shipped script claims a revocation source it does not create', () => {
  // Review #6 asks for revocability. Pretending is worse than the gap, so this pins that the script
  // advertises no CRL/OCSP endpoint without a producer, while the mechanism it does maintain - the
  // fingerprint registry - stays visible to the reader. The missing half is filed as a card.
  // 2026-11-13: that card (Y) is now partly closed on the consumer side - the registry below is read
  // while work-authz runs - but the script still creates no CRL/OCSP endpoint, so this pin stands.
  assert.doesNotMatch(code, /crl_url|ocsp_url|CRL Distribution/, 'no revocation endpoint may be advertised without a producer');
  assert.match(code, /fingerprint\(\)/, 'the registry this deployment does maintain is fingerprint based');
  assert.match(code, /workloads\.json/, 'and it is written here');
});

test('the verifier requires client certificates and reloads the fingerprint registry without a restart', () => {
  // 2026-11-13: card Y was ruled 丙, and that ruling reverses what this test used to pin. Before it
  // the file asserted `os.ReadFile(requiredEnv("WORK_AUTHZ_WORKLOADS"))` and, in the message under
  // the fsnotify check, "it is read once: revoking a workload today means editing workloads.json AND
  // restarting work-authz". There is no CRL/OCSP producer in this deployment, so that list IS the
  // revocation surface, and a revoke that needs a restart of a shared service is not one. The TLS
  // half below is unchanged; what is now required is that the same file is re-read while the process
  // runs, that a bad edit cannot darken it, and that the receipt lines the egress design names as the
  // audit reader are these exact bytes rather than prose.
  const go = readFileSync(AUTHZ_MAIN, 'utf8');
  assert.match(go, /ClientAuth:\s*tls\.RequireAndVerifyClientCert/,
    'client certificates are required and verified, so notAfter is enforced by the TLS stack');
  assert.match(go, /authz\.LoadRegistryStore\(registryPath\)/, 'the workload registry is read at startup');
  assert.match(go, /go verifier\.Watch\(watchCtx, authz\.DefaultRegistryWatchInterval/,
    'and the same path keeps being read while the service runs');
  assert.doesNotMatch(go, /fsnotify/,
    'the reload is a poll: no new dependency and no signal handler enters the authentication path');

  assert.match(go, /work authz listening addr=%s registry_path=%s registry_sha256=%s workloads=%d/,
    'the startup line prints which registry bytes are in force');
  assert.match(go, /work authz registry reloaded path=%s sha256=%s workloads=%d/,
    'an accepted swap is receipted, which is what makes the edit auditable after the fact');
  assert.match(go, /work authz registry reload refused path=%s keeping_sha256=%s workloads=%d err=%v/,
    'a refused edit is receipted too, together with the list that stayed in force');

  const store = readFileSync(REGISTRY_STORE, 'utf8');
  assert.match(store, /LoadRegistry\(body\)/,
    'a reload goes through the published strict loader, not a second parser that could be looser');
  assert.match(store, /return false, err/, 'a registry that fails to load does not replace the one in force');
  assert.match(store, /sha256\.Sum256\(body\)/, 'the receipt digest covers the exact bytes that were accepted');
  assert.match(store, /const DefaultRegistryWatchInterval = 5 \* time\.Second/,
    'the interval the egress design quotes is the interval the code uses');

  const rollout = readFileSync(ROLLOUT, 'utf8');
  assert.match(rollout, /if \[\[ ! -f \/etc\/work\/runtime-ca\/ca\.crt \]\]; then\n\s*run bash "\$RELEASE\/init-workload-pki\.sh"/,
    'the rollout invokes the PKI script only when the CA is absent, so no rollout path renews a leaf');
});

test('the file carrying the knobs is the file the release package ships', () => {
  const parsed = parsePackager(readFileSync(PACKAGER, 'utf8'));
  const { packaged } = packagedNames(readdirSync(DEPLOY_DIR), parsed);
  assert.ok(packaged.has('init-workload-pki.sh'),
    'a knob that is not packaged is a knob the host will never run');
});

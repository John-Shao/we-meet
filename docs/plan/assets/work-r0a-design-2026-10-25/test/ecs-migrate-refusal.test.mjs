// 2026-11-07, ruling #98 = B: the default binary is NOT changed. Instead the wrapper asks the
// resolved binary itself whether it knows the ledger, and refuses up front when it does not.
// Reading the Go runner first corrected the premise this guard is built on: work-migrate already
// fails closed on its own (verifyLedgerAgainstManifest -> ledger_version_unknown), so the hazard
// was never "a silent wrong apply" - it was an operator meeting a JSON code with no idea which
// binary produced it. The precheck's job is to name both paths before the real command runs.
//
// Coverage boundary, stated so nobody reads this as more than it is: both this machine and the CI
// runner are non-root, and the shipped file's EUID gate is a security control that must not be
// relaxed to make a test pass. So the refusal BRANCH is not executed here; it is pinned
// statically, and its real execution as root is filed as host evidence (see work-project.md
// #98). What IS executed here is the shipped file's own text on the unprivileged path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK_SRC = join(ASSET_DIR, '..', '..', 'src', 'work');
const SCRIPT = join(WORK_SRC, 'scripts', 'ecs-migrate.sh');
const text = readFileSync(SCRIPT, 'utf8');
const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const start = code.indexOf('if ! precheck=');
const execAt = code.indexOf('exec "$binary"');
assert.ok(start >= 0, 'the refusal precheck must exist in the shipped code, not only in prose');
assert.ok(execAt > start, 'the precheck must sit BEFORE the exec, otherwise it cannot refuse anything');
const block = code.slice(start, execAt);

test('the refusal is keyed on the binary own reading, and that reading has a real producer', () => {
  assert.match(block, /"\$binary" status/,
    'the precheck must ask the RESOLVED binary (not a hard-coded one) and must be the read-only status');
  assert.match(block, /2>&1/, 'both streams have to be captured, the JSON error goes to stderr');
  assert.doesNotMatch(block, /"\$binary" (apply|plan|snapshot)/,
    'a precheck that writes or snapshots is not a precheck');
  assert.match(block, /ledger_version_unknown/, 'the refusal must key on a specific code, not on any failure');

  const ledger = readFileSync(join(WORK_SRC, 'internal', 'migrate', 'ledger.go'), 'utf8');
  assert.match(ledger, /newError\("ledger_version_unknown"/,
    'the code the wrapper greps for must actually be produced by the migration runner');
  assert.match(ledger, /not present in the manifest/,
    'and it must mean what the wrapper says it means: ledger has a version the manifest lacks');
});

test('the refusal names both paths and stops with a non-zero exit', () => {
  assert.match(block, /exit 3/, 'refusing means a non-zero exit, not a warning followed by the apply');
  assert.match(block, /Resolved binary *: \$binary/, 'the operator must see which binary was resolved');
  assert.match(block, /\/usr\/local\/bin\/work-migrate/, 'and which one to point at instead');
  assert.match(block, /WORK_MIGRATE_BIN=/, 'the escape hatch has to be spelled out at the refusal');
  assert.match(block, /embedded in the binary/, 'the reason must travel with the refusal');
});

test('the refusal cannot leak the credential it was handed', () => {
  // precheck output is captured precisely because a connection error's message can carry the DSN.
  assert.doesNotMatch(block, /echo[^\n]*\$precheck/, 'never echo the captured output back');
  assert.doesNotMatch(block, /printf[^\n]*echo[^\n]*\$precheck/, 'nor launder it through printf');
  assert.doesNotMatch(block, /echo[^\n]*\$\*/, 'nor the caller argv, which may hold an explicit -url');
  assert.doesNotMatch(block, /echo[^\n]*\$@/, 'nor "$@"');
  assert.doesNotMatch(block, /echo[^\n]*\$\{?password/, 'nor the password');
  assert.doesNotMatch(block, /echo[^\n]*WORK_DATABASE_URL/, 'nor the assembled DSN');
  assert.doesNotMatch(block, /set -x|xtrace/, 'xtrace would print the DSN on every line');
});

test('ruling B keeps the default verbatim - the check is additive, not a behaviour swap', () => {
  assert.match(code, /binary="\$\{WORK_MIGRATE_BIN:-\/home\/johnshao\/work-migrate\}"/,
    'B was chosen over A: changing this default is a visible behaviour change and was NOT authorised');
  assert.match(code, /exec "\$binary" "\$@"/, 'the real command still runs with the caller arguments');
  // Any failure other than the one ruled on must fall through untouched, so unrelated error
  // behaviour (db down, bad flag) is still the binary own output.
  assert.match(block, /if printf '%s' "\$precheck" \| grep -q/,
    'the fall-through has to be conditional on the specific code, not a blanket refusal');
});

test('the shipped file itself still refuses to run unprivileged', () => {
  const euid = spawnSync('bash', ['-c', 'echo $EUID'], { encoding: 'utf8' });
  assert.equal(euid.status, 0, `bash is required to execute the shipped file: ${euid.stderr}`);
  assert.notEqual(euid.stdout.trim(), '0',
    'this assertion needs a NON-root run; as root the EUID gate would not fire and the test would be vacuous');
  const run = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(run.status, 1, `the unprivileged refusal must exit 1, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /run with sudo/, `it must say how to run it properly: ${run.stderr}`);
});
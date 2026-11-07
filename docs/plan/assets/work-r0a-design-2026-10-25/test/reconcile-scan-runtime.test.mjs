// 2026-11-07: work-reconcile-scan.sh is the hourly read-only orphan patrol (a systemd timer runs it),
// and an enumeration of shipped scripts showed it had no test or CI reference at all. Its two
// non-obvious behaviours are worth pinning: the orphan count comes from `grep -o` occurrences, not
// lines (the real -scan JSON can put several runs on one line), and a per-org scan failure must be
// counted as infrastructure error (exit 1) rather than silently reading as "no orphans".
// The binary is stubbed through the script's own WORK_RECONCILE_BIN knob, so nothing here needs a
// database, a Temporal server, or root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const SCRIPT = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs', 'work-reconcile-scan.sh');
const ORG_A = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';
const ORG_B = '11111111-2222-3333-4444-555555555555';

const bashProbe = spawnSync('bash', ['-c', 'command -v grep >/dev/null && command -v wc >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0,
  `this gate executes the shipped bash wrapper; bash/grep/wc unavailable: ${bashProbe.stderr || bashProbe.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-reconcile-scan-'));
const calls = join(sandbox, 'calls.txt');
const stub = join(sandbox, 'work-reconcile');
writeFileSync(stub, [
  '#!/usr/bin/env bash',
  'org=""',
  'while [ $# -gt 0 ]; do case "$1" in -org) org="$2"; shift 2;; *) shift;; esac; done',
  'printf \'%s\\n\' "$org" >> "$CALLS"',
  'if [ "$org" = "${FAKE_FAIL_ORG:-}" ]; then echo "stub: connection refused" >&2; exit 3; fi',
  // deliberately one line carrying several runs, so a line-based count would under-report
  'printf \'{"runs":[{"orphan": %s},{"orphan": %s}]}\\n\' "${FAKE_ORPHAN:-false}" "${FAKE_ORPHAN:-false}"',
  '',
].join('\n'), { encoding: 'utf8' });
chmodSync(stub, 0o755);

const runScan = ({ orgs = `${ORG_A} ${ORG_B}`, orphan = 'false', failOrg = '' } = {}) => {
  writeFileSync(calls, '', { encoding: 'utf8' });
  const runDir = mkdtempSync(join(sandbox, 'run-'));
  const script = join(runDir, 'work-reconcile-scan.sh');
  copyFileSync(SCRIPT, script);
  const env = { ...process.env, WORK_RECONCILE_BIN: stub, CALLS: calls, FAKE_ORPHAN: orphan, FAKE_FAIL_ORG: failOrg };
  if (orgs === null) delete env.WORK_RECONCILE_ORGS;
  else env.WORK_RECONCILE_ORGS = orgs;
  const result = spawnSync('bash', [script], { encoding: 'utf8', env });
  const text = `${result.stdout}\n${result.stderr}`;
  const called = existsSync(calls) ? readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  return { status: result.status, text, called };
};

test('a clean patrol exits 0, reports both orgs, and calls the binary once per org', () => {
  const run = runScan();
  assert.equal(run.status, 0, `status=${run.status}:\n${run.text}`);
  assert.match(run.text, /summary: orgs=2 orphans=0 scan_errors=0/, run.text);
  assert.deepEqual(run.called, [ORG_A, ORG_B],
    `each configured org must be scanned exactly once: ${JSON.stringify(run.called)}`);
});

test('orphan occurrences are counted, not lines, and drive exit 2', () => {
  const run = runScan({ orgs: ORG_A, orphan: 'true' });
  assert.equal(run.status, 2, `an orphan must exit 2 for systemd to mark the unit red: ${run.text}`);
  assert.match(run.text, /summary: orgs=1 orphans=2 scan_errors=0/,
    `two occurrences on one line must count as 2, not 1: ${run.text}`);
  assert.match(run.text, /2 ORPHAN run\(s\)/, run.text);
});

test('a per-org scan failure is an infrastructure error, not a clean reading', () => {
  const run = runScan({ failOrg: ORG_A });
  assert.equal(run.status, 1, `scan failure must exit 1, got ${run.status}:\n${run.text}`);
  // a regex literal does not interpolate ${...}: it would match that text literally. Use a
  // substring check so the assertion names the org it actually means.
  assert.ok(run.text.includes('scan FAILED for org ' + ORG_A), run.text);
  assert.match(run.text, /summary: orgs=2 orphans=0 scan_errors=1/,
    `the other org must still be scanned and the error counted: ${run.text}`);
  assert.deepEqual(run.called, [ORG_A, ORG_B], 'a failing org must not stop the patrol');
});

test('scan failure wins over orphans when both happen', () => {
  const run = runScan({ orphan: 'true', failOrg: ORG_B });
  assert.equal(run.status, 1, `infrastructure error must take precedence, got ${run.status}:\n${run.text}`);
  assert.match(run.text, /orphans=2 scan_errors=1/, run.text);
});

test('an empty org list refuses instead of reporting a clean patrol', () => {
  const run = runScan({ orgs: null });
  assert.equal(run.status, 1, `misconfiguration must exit 1, got ${run.status}:\n${run.text}`);
  assert.match(run.text, /WORK_RECONCILE_ORGS is empty/, run.text);
  assert.deepEqual(run.called, [], 'the binary must not be called when there is nothing to scan');
  assert.ok(!/summary: orgs=0 orphans=0 scan_errors=0/.test(run.text),
    'must not print a clean-looking summary for a patrol that never ran');
});

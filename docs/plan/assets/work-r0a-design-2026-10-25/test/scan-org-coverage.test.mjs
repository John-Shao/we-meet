import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VERIFY = join(HERE, '..', '..', '..', '..', '..', 'src', 'work', 'deploy', 'ecs', 'verify-r0a-0027.sh');
const source = readFileSync(VERIFY, 'utf8');
const start = source.indexOf('verify_scan_org_coverage() {');
const end = source.indexOf('\npsql_ro() {', start);
assert.ok(start >= 0 && end > start, 'the shipped verifier must define the org coverage guard');
const guard = source.slice(start, end);
const bash = spawnSync('bash', ['-c', 'command -v sort && command -v uniq'], { encoding: 'utf8' });
assert.equal(bash.status, 0, `bash coverage runtime unavailable: ${bash.stderr || bash.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'work-org-coverage-'));
const bin = join(sandbox, 'bin');
mkdirSync(bin);
const runuser = join(bin, 'runuser');
writeFileSync(runuser, '#!/usr/bin/env bash\nprintf \'%s\' "${DATABASE_ORGS:-}"\nexit "${DATABASE_RC:-0}"\n');
chmodSync(runuser, 0o755);

const run = ({ contents, database = 'org-a\norg-b\n', databaseRc = '0', missing = false } = {}, expectedFailures) => {
  const envFile = join(sandbox, missing ? 'missing.env' : 'scan.env');
  if (!missing) writeFileSync(envFile, contents);
  const script = join(sandbox, 'guard.sh');
  writeFileSync(script, `FAILURES=0\n${guard}\nverify_scan_org_coverage scan "$1" WORK_SCAN_ORGS\nprintf 'failures=%s\\n' "$FAILURES"\n[[ "$FAILURES" == "$EXPECTED_FAILURES" ]]\n`);
  return spawnSync('bash', [script, envFile], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DATABASE_ORGS: database, DATABASE_RC: databaseRc, EXPECTED_FAILURES: String(expectedFailures) },
  });
};

const cases = [
  ['exact matching sets pass', { contents: 'WORK_SCAN_ORGS="org-b org-a"\n', database: 'org-a\norg-b\n' }, 'scan_org_coverage=true', 'failures=0'],
  ['missing organization fails closed', { contents: 'WORK_SCAN_ORGS=org-a\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['same-count wrong organization fails closed', { contents: 'WORK_SCAN_ORGS="org-a wrong"\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['duplicate organization fails closed', { contents: 'WORK_SCAN_ORGS="org-a org-a"\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['empty organization list fails closed', { contents: 'WORK_SCAN_ORGS=\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['missing organization setting fails closed', { contents: 'OTHER=value\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['duplicate setting fails closed', { contents: 'WORK_SCAN_ORGS="org-a org-b"\nWORK_SCAN_ORGS="org-a org-b"\n' }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['unreadable environment fails closed', { missing: true }, 'scan_org_coverage=FALSE', 'failures=1'],
  ['database read failure fails closed', { contents: 'WORK_SCAN_ORGS="org-a org-b"\n', databaseRc: '1' }, 'scan_org_coverage=FALSE', 'failures=1'],
];

for (const [name, input, verdict, failures] of cases) {
  test(name, () => {
    const result = run(input, failures === 'failures=0' ? 0 : 1);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^${verdict}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^${failures}$`, 'm'));
  });
}

test('all production scan configurations use the exact coverage guard', () => {
  assert.match(source, /verify_scan_org_coverage reconcile \/etc\/work\/work-reconcile-scan\.env WORK_RECONCILE_ORGS/);
  assert.match(source, /verify_scan_org_coverage retention \/etc\/work\/work-retention-scan\.env WORK_RETENTION_ORGS/);
  assert.match(source, /verify_scan_org_coverage runstream \/etc\/work\/work-runstream-scan\.env WORK_RUNSTREAM_ORGS/);
  assert.doesNotMatch(source, /WARN: (?:scan|retention|gauge) org list/);
});

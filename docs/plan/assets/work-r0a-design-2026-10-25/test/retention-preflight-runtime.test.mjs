// 2026-11-07 (#97): run-retention-preflight.sh had no test or CI reference. Its whole reason to
// exist is stated in its own header: the SQL is only meaningful over a superuser connection, and
// ON_ERROR_STOP must be pinned because without it psql exits 0 on error and this preflight would
// quietly read "debt = 0" - the very number a drill checkbox is signed against. So the guard pins
// the refusal paths, the pinned flag, and that the caller sees psql's own exit code.
// psql is stubbed; the PGHOST branch is used because that is the one a non-root operator takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const SCRIPTS = join(ASSET_DIR, '..', '..', 'src', 'work', 'scripts');
const SCRIPT = join(SCRIPTS, 'run-retention-preflight.sh');
const SQL = join(SCRIPTS, 'retention-preflight-d0.sql');

const bashProbe = spawnSync('bash', ['-c', 'command -v dirname >/dev/null && command -v id >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0,
  `this gate executes the shipped bash wrapper; bash/dirname/id unavailable: ${bashProbe.stderr || bashProbe.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-preflight-'));
const argvFile = join(sandbox, 'psql.argv');
const stubDir = join(sandbox, 'bin');
mkdirSync(stubDir, { recursive: true });
const stub = join(stubDir, 'psql');
writeFileSync(stub, [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$@" > "$PSQL_ARGV"',
  'exit "${FAKE_PSQL_RC:-0}"',
  '',
].join('\n'), { encoding: 'utf8' });
chmodSync(stub, 0o755);

const runPreflight = ({ withSql = true, psqlRc = 0, env: extra = {} } = {}) => {
  const runDir = mkdtempSync(join(sandbox, 'run-'));
  const script = join(runDir, 'run-retention-preflight.sh');
  copyFileSync(SCRIPT, script);
  if (withSql) copyFileSync(SQL, join(runDir, 'retention-preflight-d0.sql'));
  writeFileSync(argvFile, '', { encoding: 'utf8' });
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
      PSQL_ARGV: argvFile,
      FAKE_PSQL_RC: String(psqlRc),
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'postgres',
      ...extra,
    },
  });
  const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split(/\r?\n/).filter((l) => l !== '') : [];
  return { status: result.status, text: `${result.stdout}\n${result.stderr}`, argv, runDir };
};

test('a missing SQL sibling refuses and names the pair-delivery rule', () => {
  const run = runPreflight({ withSql: false });
  assert.equal(run.status, 1, `status=${run.status}:\n${run.text}`);
  assert.match(run.text, /missing SQL next to this wrapper/, run.text);
  assert.match(run.text, /#47/, 'the refusal must point at the pair-delivery rule, not just fail');
  assert.deepEqual(run.argv, [], 'psql must not be invoked without its SQL');
});

test('ON_ERROR_STOP is pinned and the sibling SQL is the file handed to psql', () => {
  const run = runPreflight();
  assert.equal(run.status, 0, `status=${run.status}:\n${run.text}`);
  const i = run.argv.indexOf('ON_ERROR_STOP=1');
  assert.ok(i > 0 && run.argv[i - 1] === '-v',
    `without -v ON_ERROR_STOP=1 psql exits 0 on error and the preflight reads debt as zero: ${run.argv.join(' ')}`);
  const f = run.argv.indexOf('-f');
  assert.ok(f >= 0, `no -f in ${run.argv.join(' ')}`);
  // MSYS bash reports POSIX-style paths while node join uses backslashes on Windows, so compare
  // the normalised tail plus the unique run directory instead of the raw string.
  const handed = run.argv[f + 1].split('\\').join('/');
  assert.ok(handed.endsWith('/retention-preflight-d0.sql'),
    `the SQL handed to psql must be the sibling that ships with the wrapper: ${handed}`);
  assert.ok(handed.includes(run.runDir.split('\\').join('/').split('/').pop()),
    `it must be this run's own sibling, not another copy: ${handed}`);
  assert.ok(run.argv.includes('-X') && run.argv.includes('-At'),
    `the reading must stay machine-parseable and rcfile-free: ${run.argv.join(' ')}`);
});

test('psql own exit code reaches the caller instead of being swallowed', () => {
  const run = runPreflight({ psqlRc: 7 });
  assert.equal(run.status, 7,
    `a psql failure must surface as its own code, got ${run.status}:\n${run.text}`);
});

test('the TCP branch carries host, port and user explicitly', () => {
  const run = runPreflight({ env: { PGHOST: '10.0.0.9', PGPORT: '55432', PGUSER: 'work_ro', WORK_DB: 'work_ro' } });
  assert.equal(run.status, 0, run.text);
  for (const [flag, value] of [['-h', '10.0.0.9'], ['-p', '55432'], ['-U', 'work_ro'], ['-d', 'work_ro']]) {
    const i = run.argv.indexOf(flag);
    assert.ok(i >= 0, `${flag} missing from ${run.argv.join(' ')}`);
    assert.equal(run.argv[i + 1], value, `${flag} must carry the configured value`);
  }
});

test('no password is ever placed in psql argv', () => {
  const run = runPreflight({ env: { PGPASSWORD: 'sentinel-secret-value' } });
  assert.equal(run.status, 0, run.text);
  assert.ok(!run.argv.some((a) => a.includes('sentinel-secret-value')),
    'credentials must travel in the environment, not in argv (ps and journald record argv)');
  assert.ok(!run.text.includes('sentinel-secret-value'), 'nor may the wrapper echo it');
});

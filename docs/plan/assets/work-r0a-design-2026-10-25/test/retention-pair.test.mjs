// 2026-11-07 (#88 = F2): the ruling was not to add another gauge. It was to make "read the two
// retention numbers together" a machine-checked step instead of a sentence in a runbook: the wrapper
// must fetch and print orphan objects and shred_stuck in the same pass, on one line, and - because
// orphans are report-only - that line must not move the exit code. This guard runs the shipped
// wrapper with a stubbed psql and a real content directory shaped the way the writer shapes it
// (sha256(org) truncated to 32 hex chars, files named <id>.enc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(ASSET_DIR, '..', '..', 'src', 'work');
const SCRIPT = join(WORK_ROOT, 'scripts', 'run-retention-scan.sh');
const SQL = join(WORK_ROOT, 'scripts', 'retention-scan.sql');
const ORG = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';

const bashProbe = spawnSync('bash', ['-c', 'command -v sed >/dev/null && command -v sha256sum >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0,
  `this gate executes the shipped bash wrapper; bash/sed/sha256sum unavailable: ${bashProbe.stderr || bashProbe.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-retention-'));
const stub = join(sandbox, 'psql');
writeFileSync(stub, [
  '#!/usr/bin/env bash',
  'IFS=, read -r -a ids <<< "${FAKE_REF_IDS:-}"',
  'for id in "${ids[@]}"; do [ -n "$id" ] && printf \'refid=%s\\n\' "$id"; done',
  'printf \'gauge=exports_expired value=%s\\n\' "${FAKE_EXPIRED:-0}"',
  'printf \'gauge=exports_shredded value=0\\n\'',
  'printf \'gauge=inputs_expired value=0\\n\'',
  'printf \'gauge=shred_stuck value=%s\\n\' "${FAKE_STUCK:-0}"',
  '',
].join('\n'), { encoding: 'utf8' });
chmodSync(stub, 0o755);

// filesOnDisk / referencedIds drive the orphan count exactly as the wrapper computes it
const runScan = ({ filesOnDisk = [], referencedIds = [], stuck = 0, withContentDir = true }) => {
  const runDir = mkdtempSync(join(sandbox, 'run-'));
  const script = join(runDir, 'run-retention-scan.sh');
  copyFileSync(SCRIPT, script);
  copyFileSync(SQL, join(runDir, 'retention-scan.sql'));
  const contentDir = join(runDir, 'content');
  if (withContentDir) {
    const hash = createHash('sha256').update(ORG).digest('hex').slice(0, 32);
    const orgDir = join(contentDir, hash);
    mkdirSync(orgDir, { recursive: true });
    for (const id of filesOnDisk) writeFileSync(join(orgDir, `${id}.enc`), 'x', { encoding: 'utf8' });
  }
  const env = {
    ...process.env,
    PATH: `${sandbox}${delimiter}${process.env.PATH}`,
    WORK_DATABASE_URL: 'postgres://stub/stub',
    WORK_RETENTION_ORGS: ORG,
    FAKE_STUCK: String(stuck),
    FAKE_REF_IDS: referencedIds.join(','),
  };
  if (withContentDir) env.WORK_CONTENT_DIR = contentDir;
  else delete env.WORK_CONTENT_DIR;
  const result = spawnSync('bash', [script], { encoding: 'utf8', env });
  const text = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, text, pairs: text.split(/\r?\n/).filter((l) => l.includes(': PAIR ')) };
};

test('one pass prints both numbers on one line, and orphans alone do not change the exit code', () => {
  const run = runScan({ filesOnDisk: ['a', 'b'], referencedIds: ['a'], stuck: 0 });
  assert.equal(run.pairs.length, 1, `expected exactly one PAIR line, got ${run.pairs.length}:\n${run.text}`);
  assert.match(run.pairs[0], /content_orphans=1/, `the orphan half must be on the pair line: ${run.pairs[0]}`);
  assert.match(run.pairs[0], /shred_stuck=0/, `the delivery half must be on the same line: ${run.pairs[0]}`);
  assert.match(run.text, new RegExp(`org=${ORG}`), 'the stub was not used, so this run proves nothing');
  assert.equal(run.status, 0,
    `orphans are report-only: status=${run.status}, want 0 (§5.30 只报不删不得动退出码)\n${run.text}`);
});

test('a stuck deletion obligation still owns the exit code, with both numbers on the pair line', () => {
  const run = runScan({ filesOnDisk: ['a'], referencedIds: ['a'], stuck: 2 });
  assert.equal(run.pairs.length, 1, `PAIR line count ${run.pairs.length}:\n${run.text}`);
  assert.match(run.pairs[0], /content_orphans=0/, run.pairs[0]);
  assert.match(run.pairs[0], /shred_stuck=2/, run.pairs[0]);
  assert.equal(run.status, 2, `stuck must still exit 2, got ${run.status}:\n${run.text}`);
  assert.match(run.text, /STUCK /, 'the STUCK branch must still speak for itself');
});

test('without a content dir the pair line admits the orphan half is missing', () => {
  const run = runScan({ withContentDir: false, stuck: 0 });
  assert.equal(run.pairs.length, 1, `PAIR line count ${run.pairs.length}:\n${run.text}`);
  assert.match(run.pairs[0], /orphan_reading=0/,
    `a missing half must be declared, not silently dropped: ${run.pairs[0]}`);
  assert.ok(!/content_orphans=/.test(run.pairs[0]),
    `must not print an orphan count it never measured: ${run.pairs[0]}`);
  assert.equal(run.status, 0, `status=${run.status}:\n${run.text}`);
});

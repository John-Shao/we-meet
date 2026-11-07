// 2026-11-07 (#56-B closure, second half): runstream-tolerance.test.mjs pins the *text* of the
// tolerance, and text is not behaviour. The value drifted for six days precisely because nothing
// ever executed this wrapper - a green regex sat on top of a script that could have alerted on
// nothing at all. This gate runs the shipped file itself, with only psql stubbed, and asserts the
// exit codes and the number the run declares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(ASSET_DIR, '..', '..', 'src', 'work');
const WRAPPER = join(WORK_ROOT, 'scripts', 'run-runstream-gauges.sh');
const SQL = join(WORK_ROOT, 'scripts', 'runstream-gauges.sql');
const TEMPLATE = join(WORK_ROOT, 'deploy', 'ecs', 'work-runstream-scan.env.example');
const ORG = '4a2d3f28-38b9-4d6c-8614-70ef9a83960d';

// bash is part of the contract here, not a convenience: the artifact under test is a shell script.
// A machine without it fails loudly rather than reporting a vacuous pass.
const bashProbe = spawnSync('bash', ['-c', 'command -v sed >/dev/null && command -v awk >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0,
  `this gate executes the shipped bash wrapper; bash/sed/awk are unavailable: ${bashProbe.stderr || bashProbe.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-runstream-'));
const stub = join(sandbox, 'psql');
writeFileSync(stub, [
  '#!/usr/bin/env bash',
  'printf \'gauge=parked_runs value=%s\\n\' "${FAKE_PARKED:-0}"',
  'printf \'gauge=held_on_terminal value=%s\\n\' "${FAKE_HELD:-0}"',
  'printf \'gauge=unknown_operations value=0\\n\'',
  'printf \'gauge=suspended_orgs value=0\\n\'',
  'printf \'gauge=open_runs value=1\\n\'',
  'printf \'gauge=held_tokens value=100000\\n\'',
  '',
].join('\n'), { encoding: 'utf8' });
chmodSync(stub, 0o755);

const runGauges = ({ held = 0, parked = 0, tolerance, script = WRAPPER }) => {
  const env = {
    ...process.env,
    PATH: `${sandbox}${delimiter}${process.env.PATH}`,
    WORK_DATABASE_URL: 'postgres://stub/stub',
    WORK_RUNSTREAM_ORGS: ORG,
    FAKE_HELD: String(held),
    FAKE_PARKED: String(parked),
  };
  if (tolerance === undefined) delete env.WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL;
  else env.WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL = String(tolerance);
  const result = spawnSync('bash', [script], { encoding: 'utf8', env });
  return { status: result.status, text: `${result.stdout}\n${result.stderr}`, env };
};

test('a leaked reservation on a terminal Run exits 2 with no env key at all', () => {
  const run = runGauges({ held: 1 });
  assert.match(run.text, /max_held_on_terminal=0/,
    `the fallback must declare 0 in the run's own summary, got:\n${run.text}`);
  assert.match(run.text, /BREACH.*held_on_terminal=1/,
    `one leaked reservation must breach on the fallback, got:\n${run.text}`);
  assert.equal(run.status, 2, `status = ${run.status}, want 2 (越限): ${run.text}`);
});

test('the value a fresh install inherits from the template alerts on one leak', () => {
  // install_env builds a missing /etc/work/work-runstream-scan.env FROM this template, so the
  // template's number is what a reinstall actually runs with - asserted here as behaviour, not text.
  const template = readFileSync(TEMPLATE, 'utf8');
  const declared = [...template.matchAll(/^WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL=([0-9]+)$/gm)].map((m) => m[1]);
  assert.equal(declared.length, 1, `template must declare the tolerance once, found ${declared.length}`);
  const run = runGauges({ held: 1, tolerance: Number(declared[0]) });
  assert.equal(run.status, 2,
    `template tolerance ${declared[0]} silenced a single leaked reservation (status=${run.status}): ${run.text}`);
});

test('an explicit widening is honoured, so the gate is not just asserting zero twice', () => {
  const run = runGauges({ held: 1, tolerance: 2 });
  assert.equal(run.status, 0, `tolerance 2 must tolerate one leak, status=${run.status}: ${run.text}`);
  assert.match(run.text, /max_held_on_terminal=2/, `the effective value must be reported: ${run.text}`);
});

test('zero leaks exits 0 and parked runs take the other breach leg', () => {
  const clean = runGauges({ held: 0 });
  assert.equal(clean.status, 0, `clean readings must exit 0, got ${clean.status}: ${clean.text}`);
  assert.match(clean.text, /: ok /, `clean readings must report ok: ${clean.text}`);
  assert.match(clean.text, /breaches=0 scan_errors=0/, `clean summary must count nothing: ${clean.text}`);

  const parked = runGauges({ parked: 2 });
  assert.equal(parked.status, 2, `parked runs must breach, got ${parked.status}: ${parked.text}`);
  assert.match(parked.text, /BREACH.*parked_runs=2/, `parked leg must name the gauge: ${parked.text}`);
});

test('the SQL sibling is required, so a half-installed release cannot read as clean', () => {
  // The wrapper resolves runstream-gauges.sql next to itself; copy only the wrapper into an empty
  // directory and the run must refuse rather than report zero breaches from an empty reading set.
  const orphan = join(sandbox, 'lonely-runstream-gauges.sh');
  copyFileSync(WRAPPER, orphan);
  assert.ok(!SQL.startsWith(sandbox), 'the sandbox must not already hold the sibling SQL');
  const run = runGauges({ script: orphan });
  assert.equal(run.status, 1, `missing sibling must exit 1, got ${run.status}: ${run.text}`);
  assert.match(run.text, /must ship run-runstream-gauges\.sh and runstream-gauges\.sql together/,
    `the refusal must name the pair, got: ${run.text}`);
});

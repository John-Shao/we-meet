// 2026-11-07: the C16 log-scan wrapper is the channel a pilot gate's evidence comes through, and it
// has been wrong in two ways this batch caught: it counted the assembled "-u x" string instead of
// the units (15 units printed as 30), and with no work-* units discovered it ran journalctl with no
// -u at all - reading every other service on the box while reporting a Work runtime verdict. The
// text-level guards could not see either. This gate executes the shipped file, stubbing only the
// systemd surface, and asserts the count, the flags actually passed, and the refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(ASSET_DIR, '..', '..', 'src', 'work');
const SCRIPT = join(WORK_ROOT, 'scripts', 'work-c16-log-scan.sh');
const SCANNER = join(ASSET_DIR, 'assets', 'work-r0a-hardening-2026-10-25', 'log-scan.mjs');

const bashProbe = spawnSync('bash', ['-c', 'command -v awk >/dev/null && command -v wc >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0,
  `this gate executes the shipped bash wrapper; bash/awk are unavailable: ${bashProbe.stderr || bashProbe.error}`);
// The wrapper prefers /tmp/work-log-scan.mjs over its own directory, so a leftover there would make
// this gate test a file that is not in the repo.
assert.ok(!existsSync('/tmp/work-log-scan.mjs'),
  'a stray /tmp/work-log-scan.mjs exists and would shadow the repository scanner this gate is meant to exercise');

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-c16-'));
const argvFile = join(sandbox, 'journalctl.argv');
const nodePath = process.execPath.replace(/\\/g, '/');

const writeStub = (name, body) => {
  const path = join(sandbox, name);
  writeFileSync(path, body, { encoding: 'utf8' });
  chmodSync(path, 0o755);
};

writeStub('systemctl', [
  '#!/usr/bin/env bash',
  '[ "${1:-}" = "list-units" ] || exit 0',
  'for i in $(seq 1 "${FAKE_C16_UNITS:-0}"); do',
  '  printf \'work-unit-%02d.service loaded active running stub\\n\' "$i"',
  'done',
  'printf \'meet-backend.service loaded active running stub\\n\'',
  '',
].join('\n'));
writeStub('journalctl', [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$@" > "$C16_ARGV"',
  'printf \'2026-11-07T00:00:00 work-api[1]: GET /healthz 200\\n\'',
  'printf \'2026-11-07T00:00:01 work-worker[2]: advance ok\\n\'',
  'printf \'2026-11-07T00:00:02 work-export[3]: export done\\n\'',
  '',
].join('\n'));
// The DB canary leg needs a role that can read every org; forcing it to fail keeps the run
// deterministic on machines that do or do not have postgres, and the synthetic canary still drives
// the positive control the script asserts on.
writeStub('sudo', '#!/usr/bin/env bash\nexit 1\n');
writeStub('node', `#!/usr/bin/env bash\nexec "${nodePath}" "$@"\n`);

// Each run gets its own directory holding the script and its sibling scanner. The shipped cleanup
// deletes any scanner it resolved under /tmp - on Linux the sandbox *is* under /tmp, so a single
// shared copy would be eaten by the first run and every later run would die at "scanner absent".
const runScan = (unitCount) => {
  rmSync(argvFile, { force: true });
  const runDir = mkdtempSync(join(sandbox, `run-${unitCount}-`));
  const script = join(runDir, 'work-c16-log-scan.sh');
  copyFileSync(SCRIPT, script);
  copyFileSync(SCANNER, join(runDir, 'log-scan.mjs'));
  const result = spawnSync('bash', [script, 'clean'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox}${delimiter}${process.env.PATH}`,
      FAKE_C16_UNITS: String(unitCount),
      C16_ARGV: argvFile,
      WORK_C16_DIR: join(runDir, 'c16-work'),
    },
  });
  const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split(/\r?\n/).filter((line) => line !== '') : null;
  return { status: result.status, text: `${result.stdout}\n${result.stderr}`, argv };
};

test('the unit count reported is the number of units, not the number of words', () => {
  const run = runScan(15);
  assert.equal(run.status, 0, `the scan must complete, status=${run.status}:\n${run.text}`);
  assert.match(run.text, /^units=15$/m, `the evidence line must report 15 units:\n${run.text}`);
  assert.ok(run.argv, 'journalctl was never invoked, so the scan covered nothing');
  const flags = run.argv.filter((arg) => arg === '-u');
  assert.equal(flags.length, 15,
    `journalctl got ${flags.length} -u flags for 15 units; the flag and unit arrays must stay in step`);
  const requested = run.argv.filter((arg) => arg.endsWith('.service'));
  assert.equal(requested.length, 15, `units passed as positional filters instead of flag values: ${requested}`);
  assert.ok(requested.every((arg) => arg.startsWith('work-')),
    `a non-work unit reached journalctl: ${requested.filter((a) => !a.startsWith('work-'))}`);
  assert.ok(!requested.includes('meet-backend.service'),
    'the awk filter must exclude non-work units before they become -u arguments');
});

test('discovery finding no work unit refuses instead of scanning the whole journal', () => {
  const run = runScan(0);
  assert.match(run.text, /^units=0$/m, `the count must still be printed before refusing:\n${run.text}`);
  assert.equal(run.status, 1, `zero units must fail closed, got status=${run.status}:\n${run.text}`);
  assert.match(run.text, /refusing to scan the whole journal/,
    `the refusal must name the reason, got:\n${run.text}`);
  assert.equal(run.argv, null,
    `journalctl was invoked with ${run.argv?.length} arguments after an empty unit list - that is the whole-journal scan`);
});

test('a single unit reports one, so the count cannot drift back to a word count', () => {
  const run = runScan(1);
  assert.equal(run.status, 0, `status=${run.status}:\n${run.text}`);
  assert.match(run.text, /^units=1$/m, `units line:\n${run.text}`);
  assert.equal(run.argv.filter((arg) => arg === '-u').length, 1,
    `one unit must produce exactly one -u: ${run.argv.join(' ')}`);
});

// #100：scanner 发现内容时 wrapper 必须 exit 4，让 unit 变红驱动告警。
// 修改 journalctl 桩让它输出 canary，scanner 会找到并 exit 1，wrapper 捕获后 exit 4。
test('a content finding exits 4 to red the unit', () => {
  const findingSandbox = mkdtempSync(join(tmpdir(), 'r0a-c16-finding-'));
  const findingArgvFile = join(findingSandbox, 'journalctl.argv');
  const writeFindingStub = (name, body) => {
    const path = join(findingSandbox, name);
    writeFileSync(path, body, { encoding: 'utf8' });
    chmodSync(path, 0o755);
  };
  writeFindingStub('systemctl', [
    '#!/usr/bin/env bash',
    '[ "${1:-}" = "list-units" ] || exit 0',
    'printf \'work-unit-01.service loaded active running stub\\n\'',
    '',
  ].join('\n'));
  writeFindingStub('journalctl', [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$@" > "$C16_ARGV"',
    'printf \'2026-11-07T00:00:00 work-api[1]: GET /healthz 200\\n\'',
    'printf \'CANARY-work-r0a-c16-sentinel\\n\'',
    '',
  ].join('\n'));
  writeFindingStub('sudo', '#!/usr/bin/env bash\nexit 1\n');
  writeFindingStub('node', `#!/usr/bin/env bash\nexec "${nodePath}" "$@"\n`);

  const runDir = mkdtempSync(join(findingSandbox, 'run-finding-'));
  const script = join(runDir, 'work-c16-log-scan.sh');
  copyFileSync(SCRIPT, script);
  copyFileSync(SCANNER, join(runDir, 'log-scan.mjs'));
  const result = spawnSync('bash', [script, 'clean'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${findingSandbox}${delimiter}${process.env.PATH}`,
      FAKE_C16_UNITS: '1',
      C16_ARGV: findingArgvFile,
      WORK_C16_DIR: join(runDir, 'c16-work'),
    },
  });
  assert.equal(result.status, 4,
    `a content finding must exit 4 to red the unit, got ${result.status}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, /content finding detected/,
    'the refusal must name the reason');
  rmSync(findingSandbox, { recursive: true, force: true });
});

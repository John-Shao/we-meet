// 2026-11-07, ruling #96 = C1: the canary-based content check already existed and its positive
// control already fired on both hand runs, but `systemctl list-timers --all | grep -ciE
// "c16|log-scan"` measured 0 on the pilot host - so prose content detection only happened when
// somebody remembered. C1 buys an executor, not a new rule. These assertions pin the three
// propagation points that made #50 (installed but never wired) and #47 (script without its pair)
// the recurring failures they were: package, install+schedule, verify.
//
// Deliberately NOT asserted here: that a content FINDING reds the unit. Reading the wrapper shows
// its exit code reflects preflight and the positive control only - the scanner's own verdict is
// piped to tail and never propagated. Whether a finding should fail the unit is registered as a
// separate ruling, so this guard must not pretend the wiring already alerts on findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK = join(ASSET_DIR, '..', '..', 'src', 'work');
const ECS = join(WORK, 'deploy', 'ecs');
const read = (p) => readFileSync(p, 'utf8');
const directives = (t) => t.split(/\r?\n/).filter((l) => !/^\s*[#;]/.test(l)).join('\n');

const SERVICE = join(ECS, 'work-c16-log-scan.service');
const TIMER = join(ECS, 'work-c16-log-scan.timer');
const pkg = read(join(ECS, 'make-release.sh'));
const rollout = read(join(ECS, 'rollout-r0a-0027.sh'));
const verify = read(join(ECS, 'verify-r0a-0027.sh'));

test('both halves of the timer exist and are packaged', () => {
  assert.ok(existsSync(SERVICE), 'the service file must exist, not just be named in a script');
  assert.ok(existsSync(TIMER), 'the timer file must exist too');
  for (const f of ['work-c16-log-scan.service', 'work-c16-log-scan.timer']) {
    assert.ok(pkg.includes(`cp "$ROOT/deploy/ecs/${f}" "$OUT/"`),
      `make-release must copy ${f} explicitly - its asset list is a literal cp list, nothing is globbed`);
  }
  assert.ok(pkg.includes('cp "$ROOT/scripts/work-c16-log-scan.sh" "$OUT/"'),
    'the wrapper it schedules must still be packaged');
  assert.ok(pkg.includes('log-scan.mjs'), 'and the scanner the wrapper looks up next to itself');
});

test('rollout installs both units and actually enables and starts the timer', () => {
  assert.match(rollout, /for unit in work-c16-log-scan\.service work-c16-log-scan\.timer; do/,
    'both units must be installed to /etc/systemd/system');
  assert.match(rollout, /systemctl enable[^\n]*work-c16-log-scan\.timer/,
    'installed is not wired: #50 was exactly an installed-but-never-enabled scan');
  assert.match(rollout, /systemctl start[^\n]*work-c16-log-scan\.timer/,
    'and it must be started this rollout, not left for the next boot');
  // Adding c16 must not drop the neighbour that shares the enable line.
  assert.match(rollout, /systemctl enable[^\n]*work-runstream-scan\.timer[^\n]*work-c16-log-scan\.timer/,
    'the runstream timer must still be enabled on the same line');
  const reloadAt = rollout.indexOf('systemctl daemon-reload', rollout.indexOf('for unit in work-c16-log-scan'));
  const enableAt = rollout.indexOf('systemctl enable work-runstream-scan.timer work-c16-log-scan.timer');
  assert.ok(reloadAt > 0 && enableAt > reloadAt,
    'daemon-reload must sit between installing the units and enabling them, or this rollout does not take effect');
});

test('the service can actually do what the wrapper needs', () => {
  const svc = directives(read(SERVICE));
  assert.match(svc, /^ExecStart=\/usr\/local\/bin\/work-c16-log-scan\.sh$/m,
    'it must run the installed wrapper, and that is the path rollout installs');
  assert.ok(rollout.includes('install -m 0755 -o root -g root "$RELEASE/work-c16-log-scan.sh" /usr/local/bin/work-c16-log-scan.sh'),
    'the ExecStart target must have a producer in rollout');
  assert.match(svc, /^User=root$/m,
    'the canary source is `sudo -u postgres psql`; as work-control it degrades to the synthetic sentinel only');
  assert.doesNotMatch(svc, /^ProtectSystem=strict$/m,
    'strict makes / read-only and the wrapper creates its own /work-c16 scratch root');
  assert.doesNotMatch(svc, /^ProtectHome=(true|tmpfs)$/m,
    'the fallback canary source reads /root/work-secrets.env; hiding /root breaks it silently');
  assert.doesNotMatch(svc, /^NoNewPrivileges=true$/m,
    'NNP would strip the setuid transition of the sudo the wrapper execs');
  assert.match(svc, /^Type=oneshot$/m, 'a scan is a job, not a daemon');
});

test('the timer schedules that service and catches up after downtime', () => {
  const tmr = directives(read(TIMER));
  assert.match(tmr, /^Unit=work-c16-log-scan\.service$/m, 'it must point at the service that exists');
  assert.match(tmr, /^Persistent=true$/m, 'a host that was down still owes one run');
  assert.match(tmr, /^OnCalendar=/m, 'a cadence must be stated, not left to the default');
  assert.match(tmr, /^WantedBy=timers\.target$/m, 'otherwise enable has nothing to hook');
});

test('verify reads the executor and can tell never-ran from ran-clean', () => {
  assert.match(verify, /is-enabled work-c16-log-scan\.timer/, 'the timer state must be read, not assumed');
  assert.match(verify, /show -p Result --value work-c16-log-scan\.service/, 'and the last result');
  assert.match(verify, /grep -c 'positive control fired'/,
    'the count must come from the wrapper own output: 0 means never ran, which in-place checks cannot distinguish');
  assert.match(verify, /work-c16-log-scan\.timer not enabled/,
    'a missing executor has to produce a WARN, the same way the retention timer does');
});

test('what C1 relies on is still in the shipped artifacts', () => {
  const wrapper = read(join(WORK, 'scripts', 'work-c16-log-scan.sh'));
  assert.match(wrapper, /select title from work\.task/,
    'wiring a timer is not a substitute for the canary being real user content');
  assert.match(wrapper, /positive control did not fire/, 'and the positive control must still be able to fail the run');
  const scanner = read(join(ASSET_DIR, 'assets', 'work-r0a-hardening-2026-10-25', 'log-scan.mjs'));
  assert.match(scanner, /content\.canary/,
    'the rule that makes real titles detectable must still exist - C1 reuses it, it does not replace it');
});
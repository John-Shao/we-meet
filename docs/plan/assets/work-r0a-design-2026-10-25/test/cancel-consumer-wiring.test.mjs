// 2026-11-17 (0057 / GW16). The governance cancellation-intent consumer ships as a oneshot binary
// driven by a systemd timer, and the lead ruled three boundaries that are easy to lose in a later
// edit: the org list is configuration (no new cross-tenant visibility switch), the cadence belongs
// to the timer (no resident loop inside a oneshot unit), and the dead-letter alert is an audit row
// rather than a red unit. This guard pins the wiring that carries those rulings, in the same shape
// as c16-timer-wiring: package, schedule, executor, and the boundary the code must not cross.
//
// The host run is a separate deployment authorization. This guard pins that full rollout proves
// exact work.org coverage before any write, installs the unit/timer/env permissions, enables the
// timer, and that the read-only verifier fails closed when the consumer is absent or partial.
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
// Comment lines describe intent; only code lines may satisfy a structural assertion.
const directives = (t) => t.split(/\r?\n/).filter((l) => !/^\s*[#;]/.test(l)).join('\n');

const SERVICE = join(ECS, 'work-cancel.service');
const TIMER = join(ECS, 'work-cancel.timer');
const ENV = join(ECS, 'work-cancel.env.example');
const MAIN = join(WORK, 'cmd', 'work-cancel', 'main.go');
const CONSUMER = join(WORK, 'internal', 'cancellation', 'cancellation.go');

test('all three halves exist and are packaged by name', () => {
  for (const f of [SERVICE, TIMER, ENV]) {
    assert.ok(existsSync(f), `${f} must exist, not just be named in a comment`);
  }
  const pkg = read(join(ECS, 'make-release.sh'));
  for (const name of ['work-cancel.service', 'work-cancel.timer', 'work-cancel.env.example']) {
    assert.ok(pkg.includes(`cp "$ROOT/deploy/ecs/${name}" "$OUT/"`),
      `make-release must copy ${name} explicitly - a unit without its pair is #47/#50 again`);
  }
});

test('the timer schedules that service, and the service runs a binary the tree builds', () => {
  const timer = directives(read(TIMER));
  const service = directives(read(SERVICE));
  assert.match(timer, /^Unit=work-cancel\.service$/m, 'the timer must name its own service');
  assert.match(timer, /^OnUnitActiveSec=/m, 'a periodic consumer needs a period, not only OnBootSec');
  assert.match(service, /^Type=oneshot$/m,
    'the ruling is a timer-driven pass: a resident Type=simple loop inside a oneshot-shaped unit would never exit');
  const exec = /^ExecStart=(.+)$/m.exec(service);
  assert.ok(exec, 'the service has no ExecStart');
  const bin = exec[1].trim().split('/').pop();
  assert.ok(existsSync(join(WORK, 'cmd', bin)),
    `ExecStart names ${bin}, which is not under cmd/ - the package would install a unit with no executor`);
  // Both env files travel: the DB credentials are reused from the worker env, the org list is its own.
  assert.match(service, /^EnvironmentFile=\/etc\/work\/work-worker\.env$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/work\/work-cancel\.env$/m);
});

test('the org list is configuration the binary reads, and an empty list is a refusal', () => {
  const env = read(ENV);
  const main = read(MAIN);
  assert.match(env, /^WORK_CANCEL_ORGS=$/m, 'the packaged template must stay empty until an operator supplies the exact org set');
  assert.match(main, /Getenv\("WORK_CANCEL_ORGS"\)/, 'the binary must read the knob the template advertises');
  assert.match(main, /WORK_CANCEL_ORGS is empty/,
    'a worker cannot enumerate orgs under FORCE RLS, so an empty list is a misconfigured unit, not a clean pass');
  for (const knob of ['WORK_CANCEL_TASK_LIMIT', 'WORK_CANCEL_INTENT_LIMIT']) {
    assert.ok(env.includes(`${knob}=`) && main.includes(`"${knob}"`),
      `${knob} must be both advertised and read`);
  }
});

test('the consumer stays inside one tenant and never becomes a terminal Run writer', () => {
  const src = read(CONSUMER);
  assert.match(src, /workdb\.WithWorkerOrgContext\(/,
    'every call must run under an explicit org context - that is the ruled no-bypass path');
  assert.ok(!/WithRelayContext\(/.test(src),
    'WithRelayContext is the cross-tenant relay switch; using it here would be the bypass the lead ruled out');
  assert.ok(!/SET state = 'canceled'/.test(src) && !/finish_local_run/.test(src),
    'the consumer enters cancel_requested only; the terminal writer stays finish_local_run_state (0042)');
  // The three commands it is allowed to call, and the ops-only replay it must not.
  for (const fn of ['claim_pending_cancellation_intents', 'consume_cancellation_intent', 'fail_cancellation_intent']) {
    assert.ok(src.includes(fn), `${fn} must be called by the consumer`);
  }
  assert.ok(!src.includes('requeue_cancellation_dead_letter'),
    'replay is work_ops-only (0057 grants it to work_ops); a worker calling it would be refused, so it must not try');
});

test('the dead-letter alert is an audit row, and the unit rc reports infrastructure only', () => {
  const ops = read(join(ASSET_DIR, '..', 'work', 'operations.md'));
  assert.match(ops, /work-cancel\.timer/, 'the timer must be in the operations timer inventory');
  assert.match(ops, /cancellation_intent\.dead_lettered/,
    'duty must be told where the alert actually is: the audit row, not a red unit and not a gauge');
  const verify = read(join(ECS, 'verify-r0a-0027.sh'));
  for (const name of ['work-cancel.service', 'work-cancel.timer', 'work-cancel.env.example']) {
    assert.ok(verify.includes(`"${name}:`),
      `verify must report ${name} as present/MISSING - packaged != installed, and the reading is how that stays visible`);
  }
  const rollout = read(join(ECS, 'rollout-r0a-0027.sh'));
  assert.match(rollout, /for bin in [^\n]*work-cancel/,
    'the binary needs an install path like every other cmd/ entry (the release-assets exhaustiveness gate)');
  assert.match(rollout, /verify_cancel_org_coverage\(\)/,
    'full rollout must have an explicit org coverage guard');
  assert.match(rollout, /verify_cancel_org_coverage\n/,
    'the coverage guard must actually be called, not merely declared');
  assert.match(rollout, /configured="\$\(read_env_exact "\$env_file" WORK_CANCEL_ORGS\)"/,
    'the org key must be read through the exactly-once env parser');
  assert.match(rollout, /verify_org_coverage WORK_CANCEL_ORGS "\$configured" "\$database"/,
    'coverage must reject duplicate org ids as well as missing or unknown ids');
  assert.doesNotMatch(rollout, /configured_sorted=.*sort -u/,
    'sort -u would silently accept duplicate configured org ids');
  assert.match(rollout, /select id from work\.org/,
    'coverage must compare against the database org set, not a second hand-written list');
  assert.match(rollout, /run chown root:work-control \/etc\/work\/work-cancel\.env/,
    'the operator-provisioned env must be tightened without being replaced');
  assert.match(rollout, /run chmod 640 \/etc\/work\/work-cancel\.env/);
  for (const unit of ['work-cancel.service', 'work-cancel.timer']) {
    assert.ok(rollout.includes(`"$RELEASE/$unit"`), `rollout must install ${unit}`);
  }
  assert.match(rollout, /run systemctl enable work-cancel\.timer/,
    'the consumer needs a persistent schedule');
  assert.match(rollout, /run systemctl start work-cancel\.timer/,
    'the schedule must become active in the same authorized rollout');
  assert.ok(!/^install_env work-cancel$/m.test(rollout),
    'the empty template must never overwrite or stand in for operator-provisioned org coverage');
  assert.match(verify, /work_cancel_consumer=true/,
    'verify must publish a positive consumer verdict');
  assert.match(verify, /work_cancel_consumer=FALSE/,
    'verify must have a negative branch');
  assert.match(verify, /work_cancel_consumer=FALSE"\r?\n\s+FAILURES=\$\(\(FAILURES \+ 1\)\)/,
    'missing or partial consumer deployment must fail the official verifier');
});
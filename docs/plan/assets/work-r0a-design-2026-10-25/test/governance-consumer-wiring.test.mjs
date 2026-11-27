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

const SERVICE = join(ECS, 'work-governance-events.service');
const TIMER = join(ECS, 'work-governance-events.timer');
const ENV = join(ECS, 'work-governance-events.env.example');
const MAIN = join(WORK, 'cmd', 'work-governance-events', 'main.go');

test('governance consumer unit, timer and env template are packaged together', () => {
  for (const file of [SERVICE, TIMER, ENV]) {
    assert.ok(existsSync(file), `${file} must exist`);
  }
  const pkg = read(join(ECS, 'make-release.sh'));
  for (const name of ['work-governance-events.service', 'work-governance-events.timer', 'work-governance-events.env.example']) {
    assert.ok(pkg.includes(`cp "$ROOT/deploy/ecs/${name}" "$OUT/"`), `make-release must copy ${name}`);
  }
});

test('governance timer drives the bounded oneshot with the dedicated identity', () => {
  const timer = directives(read(TIMER));
  const service = directives(read(SERVICE));
  const env = read(ENV);
  const main = read(MAIN);
  assert.match(timer, /^Unit=work-governance-events\.service$/m);
  assert.match(timer, /^OnUnitActiveSec=/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/work\/work-governance-events\.env$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/bin\/work-governance-events$/m);
  assert.match(env, /^WORK_GOVERNANCE_ORGS=$/m, 'the template must not ship a partial org list');
  assert.match(env, /^WORK_DATABASE_URL=postgresql:\/\/work_governance_events_login:CHANGE_ME@127\.0\.0\.1:5432\/work\?sslmode=disable$/m,
    'the dedicated DSN must match the loopback PostgreSQL sslmode used by the role provisioner');
  assert.match(env, /^WORK_GOVERNANCE_CLIENT_CERT=\/etc\/work\/certs\/work-governance-events\.crt$/m);
  assert.match(env, /^WORK_GOVERNANCE_CLIENT_KEY=\/etc\/work\/certs\/work-governance-events\.key$/m);
  assert.match(env, /^WORK_GOVERNANCE_CLIENT_CA=\/etc\/work\/certs\/ca\.crt$/m);
  assert.match(main, /Getenv\("WORK_GOVERNANCE_ORGS"\)/);
  assert.match(main, /WORK_GOVERNANCE_ORGS is empty/);
});

test('full rollout proves role, mTLS and org coverage before installing the timer', () => {
  const rollout = read(join(ECS, 'rollout-r0a-0027.sh'));
  const verify = read(join(ECS, 'verify-r0a-0027.sh'));
  assert.match(rollout, /verify_governance_consumer\(\)/);
  assert.match(rollout, /verify_governance_consumer\n/, 'the preflight function must be called');
  assert.match(rollout, /work_governance_events_login:[^@]+@/);
  assert.match(rollout, /--verify-governance-client/);
  assert.match(rollout, /WORK_GOVERNANCE_CLIENT_CA/);
  assert.match(verify, /CN=work-governance-events/);
  assert.match(verify, /verify_governance_client_cert\(\)/);
  assert.match(verify, /--verify-governance-client/);
  assert.match(verify, /governance_cert_valid/);
  assert.match(rollout, /select rolname from pg_roles where rolname='work_governance_events_login'/);
  assert.match(rollout, /select id from work\.org/);
  assert.match(rollout, /WORK_GOVERNANCE_ORGS must exactly cover every work\.org id/);
  assert.match(rollout, /run chown root:work-control \/etc\/work\/work-governance-events\.env/);
  assert.match(rollout, /run chmod 640 \/etc\/work\/work-governance-events\.env/);
  for (const unit of ['work-governance-events.service', 'work-governance-events.timer']) {
    assert.ok(rollout.includes(`"$RELEASE/$unit"`), `rollout must install ${unit}`);
  }
  assert.match(rollout, /run systemctl enable work-cancel\.timer work-governance-events\.timer/);
  assert.match(rollout, /run systemctl start work-cancel\.timer work-governance-events\.timer/);
  assert.ok(!/^install_env work-governance-events$/m.test(rollout),
    'the placeholder template must never become a running consumer configuration');
  assert.match(verify, /work_governance_consumer=true/);
  assert.match(verify, /work_governance_consumer=FALSE"\r?\n\s+FAILURES=\$\(\(FAILURES \+ 1\)\)/,
    'missing or partial governance deployment must fail the official verifier');
});

test('governance consumer failures and stopped timers reach the health alert path', () => {
  const healthcheck = read(join(ECS, 'work-healthcheck.sh'));
  const runtime = read(join(HERE, 'healthcheck-runtime.test.mjs'));
  for (const unit of ['work-cancel.service', 'work-governance-events.service']) {
    assert.ok(healthcheck.includes(unit), `healthcheck must observe ${unit}`);
  }
  for (const timer of ['work-cancel.timer', 'work-governance-events.timer']) {
    assert.ok(healthcheck.includes(timer), `healthcheck must observe ${timer}`);
  }
  assert.match(healthcheck, /systemctl is-enabled "\$timer"/);
  assert.match(healthcheck, /issues\+=\("\$\{timer\}=\$timer_active"\)/);
  assert.match(healthcheck, /"\$PYTHON_BIN" "\$ALERT_SCRIPT" "\$status" "\$issue_text"/,
    'consumer degradation must reach the existing mail alert command');
  assert.ok(runtime.includes('governance consumer service failure degrades and alerts'));
  assert.ok(runtime.includes('stopped governance consumer timer degrades and alerts'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contract = JSON.parse(readFileSync(new URL('./bootstrap-v1.json', import.meta.url), 'utf8'));

test('bootstrap v1 freezes the old eight-field surface', () => {
  assert.equal(contract.version, 'work-bootstrap-v1');
  assert.equal(contract.additionalProperties, false);
  assert.deepEqual(contract.required, [
    'subject_id',
    'org',
    'permissions',
    'phases',
    'execution_targets',
    'allowed_permission_modes',
    'limits',
    'csrf_token',
  ]);
  assert.deepEqual(contract.permissions, ['work.task.create', 'work.artifact.read']);
  assert.deepEqual(contract.phases, ['R0a']);
  assert.deepEqual(contract.execution_targets, [{ kind: 'cloud', profile: 'text-v1' }]);
  assert.deepEqual(contract.limits, {
    max_goal_chars: 2000,
    max_background_chars: 4000,
    max_artifact_bytes: 262144,
    max_active_runs: 1,
  });
});

test('bootstrap csrf is Go-issued and shared across tabs', () => {
  assert.equal(contract.csrf.cookie, 'work_csrf');
  assert.equal(contract.csrf.header, 'X-CSRF-Token');
  assert.equal(contract.csrf.tokenPrefix, 'v1.');
  assert.equal(contract.csrf.ttlSeconds, 3600);
  assert.match(contract.csrf.cookieAttributes, /HttpOnly=false/);
  assert.match(contract.csrf.cookieAttributes, /SameSite=Strict/);
});

test('bootstrap identity is server-derived and bootstrap-only is frozen', () => {
  assert.equal(contract.signoff.by, 'John Shao');
  assert.equal(contract.surfaceFrozen, 'bootstrap_only');
  assert.deepEqual(contract.org.roles, ['owner', 'admin', 'member', 'viewer']);
  assert.equal(contract.identity.subjectSource, 'verified Host session');
  assert.equal(contract.identity.orgSource, 'verified Host session');
});

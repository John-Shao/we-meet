import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeAccessDecision, serviceActionAllowed } from './runtime-access.model.mjs';

const policy = JSON.parse(readFileSync(new URL('./runtime-access.policy.json', import.meta.url), 'utf8'));
function facts() {
  const execution = {
    orgId: 'org-1', taskId: 'task-1', runId: 'run-1', executionId: 'exec-1', holderId: 'holder-1',
    fence: '3', mode: 'plan', state: 'active', current: true, canceled: false, deleted: false,
    leaseUntil: 30000, hardDeadline: 60000, capabilityGenerations: { 'work-content': 1, 'work-egress': 1 },
  };
  return {
    authenticated: true, authorityAvailable: true, now: 10000, execution,
    credential: {
      orgId: execution.orgId, taskId: execution.taskId, runId: execution.runId,
      executionId: execution.executionId, holderId: execution.holderId, fence: execution.fence,
      mode: execution.mode, audience: 'work-content', generation: 1,
      issuedAt: 5000, expiresAt: 25000, revoked: false,
    },
    request: { executionId: 'exec-1', audience: 'work-content', action: 'read_bound_object', refId: 'ref-1', hash: 'sha256:synthetic' },
    resource: {
      orgId: 'org-1', taskId: 'task-1', runId: 'run-1', refId: 'ref-1', hash: 'sha256:synthetic',
      tombstoned: false, immutable: true, readableByExecutions: ['exec-1'],
      kind: 'checkpoint_candidate', slotExecutionId: 'exec-1', slotState: 'reserved',
    },
  };
}
const decision = (f) => runtimeAccessDecision(policy, f);
const deny = (f) => assert.equal(decision(f), 'deny');

test('bound immutable reads pass the model without implying real authentication', () => {
  assert.equal(decision(facts()), 'allow_read');
  const f = facts();
  f.authenticated = false;
  deny(f);
});

test('authority failure denies rather than using a cached positive decision', () => {
  const f = facts();
  f.authorityAvailable = false;
  deny(f);
  assert.equal(policy.capability.positiveAuthorizationCacheSeconds, 0);
});

test('every capability identity dimension must match the live execution', () => {
  for (const field of ['orgId', 'taskId', 'runId', 'executionId', 'holderId', 'fence', 'mode']) {
    const f = facts();
    f.credential[field] = 'other';
    deny(f);
  }
});

test('expired, future, overlong, revoked and old-generation capabilities fail', () => {
  const cases = [
    { expiresAt: 10000 }, { issuedAt: 11000 }, { issuedAt: -10000, expiresAt: 25000 },
    { revoked: true }, { generation: 0 }, { generation: 2 }, { expiresAt: 40000 },
  ];
  for (const change of cases) {
    const f = facts();
    Object.assign(f.credential, change);
    deny(f);
  }
});

test('cancellation, deletion, lease expiry, stale Run and terminal execution revoke new access', () => {
  for (const change of [{ canceled: true }, { deleted: true }, { leaseUntil: 10000 }, { hardDeadline: 10000 }, { current: false }, { state: 'completed' }]) {
    const f = facts();
    Object.assign(f.execution, change);
    deny(f);
  }
});

test('audience swap and child lease renewal or issuance are rejected', () => {
  for (const action of ['renew_execution', 'issue_capabilities', 'commit_checkpoint', 'write_receipt_slot']) {
    const f = facts();
    f.request.action = action;
    deny(f);
  }
  const f = facts();
  f.request.audience = 'work-egress';
  deny(f);
});

test('a same-tenant but unbound object and a cross-tenant object both fail', () => {
  for (const change of [{ readableByExecutions: [] }, { orgId: 'org-2' }, { runId: 'run-2' }, { tombstoned: true }, { hash: 'other' }, { immutable: false }]) {
    const f = facts();
    Object.assign(f.resource, change);
    deny(f);
  }
});

test('candidate writes are limited to a reserved slot of the current execution', () => {
  const f = facts();
  f.request.action = 'write_checkpoint_candidate';
  assert.equal(decision(f), 'allow_candidate_write_only');
  for (const change of [{ slotExecutionId: 'exec-2' }, { slotState: 'committed' }, { kind: 'model_receipt' }]) {
    const altered = structuredClone(f);
    Object.assign(altered.resource, change);
    deny(altered);
  }
});

test('execute mode cannot overwrite the approved model intent', () => {
  const f = facts();
  f.request.action = 'write_model_request';
  f.resource.kind = 'model_request';
  assert.equal(decision(f), 'allow_candidate_write_only');
  f.execution.mode = f.credential.mode = 'execute';
  deny(f);
});

test('eligible model access still requires atomic gate consumption', () => {
  const f = facts();
  const binding = { operationId: 'op-1', dispatchAttemptId: 'attempt-1', requestHash: 'sha256:request' };
  Object.assign(f.execution, binding, { mode: 'execute', operationState: 'dispatching', gateState: 'absent' });
  Object.assign(f.credential, binding, { mode: 'execute', audience: 'work-egress' });
  Object.assign(f.request, { audience: 'work-egress', action: 'invoke_bound_model', requestHash: binding.requestHash });
  assert.equal(decision(f), 'requires_atomic_gate_consume');
  for (const field of ['operationId', 'dispatchAttemptId', 'requestHash']) {
    const altered = structuredClone(f);
    altered.credential[field] = 'other';
    deny(altered);
  }
  f.execution.gateState = 'consumed';
  deny(f);
});

test('plan capabilities never authorize a model call', () => {
  const f = facts();
  f.credential.audience = f.request.audience = 'work-egress';
  f.request.action = 'invoke_bound_model';
  deny(f);
});

test('service identity roles cannot substitute for each other', () => {
  assert.equal(serviceActionAllowed(policy, { verified: true, revoked: false, role: 'pool_parent' }, 'claim_execution'), true);
  assert.equal(serviceActionAllowed(policy, { verified: true, revoked: false, role: 'pool_parent' }, 'consume_delivery'), false);
  assert.equal(serviceActionAllowed(policy, { verified: true, revoked: false, role: 'runtime_child' }, 'issue_capabilities'), false);
  assert.equal(serviceActionAllowed(policy, { verified: false, revoked: false, role: 'egress_service' }, 'attach_receipt'), false);
  assert.equal(serviceActionAllowed(policy, { verified: true, revoked: true, role: 'egress_service' }, 'attach_receipt'), false);
});

test('content HTTP endpoint does not expose authority or Temporal transport', () => {
  assert.equal(policy.services.authority.transport, 'mtls');
  assert.equal(policy.services.temporal.transport, 'mtls');
  assert.notEqual(policy.services.content.port, policy.services.authority.port);
  assert.deepEqual(policy.services.content.callers, ['runtime_child']);
  assert.equal(policy.network.policyBoundary, 'pod_not_process');
});

test('draft declares unprivileged enforcement requirements rather than measured isolation', () => {
  assert.equal(policy.approval, 'design_signed');
  assert.equal(policy.evidence, 'design_model_only');
  assert.equal(policy.sandboxProof, false);
  assert.equal(policy.isolation.allowRootOrAddedCapabilities, false);
  assert.equal(policy.isolation.landlockRightsFallback, false);
  assert.equal(policy.isolation.nodePermissionModelIsSecurityBoundary, false);
});

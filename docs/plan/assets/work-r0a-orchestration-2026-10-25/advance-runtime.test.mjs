import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RUNTIME_ACTIVITY_DRAFT, RUNTIME_CONTRACT_VERSION } from './AdvanceRuntime.contract.ts';

const require = createRequire(new URL('../../../../src/frontend/package.json', import.meta.url));
const Ajv = require('ajv');
const schema = JSON.parse(readFileSync(new URL('./advance-runtime.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
const id = '00000000-0000-4000-8000-000000000001';
const reference = { refId: id, hash: `sha256:${'a'.repeat(64)}` };
const intent = { request: reference, requestHash: reference.hash, logicalKey: 'model:1' };
const permit = { operationId: id, dispatchAttemptId: id, requestHash: reference.hash };
const request = {
  kind: 'advance_request', contractVersion: RUNTIME_CONTRACT_VERSION,
  executionId: id, runId: id, taskId: id, orgId: 'org_1', snapshotId: id,
  runtimeVersion: 'work-pi-1.4.0-build1', fence: '9007199254740993',
  deadlineUnixMs: 1800000000000, mode: 'plan', checkpoint: null, intent: null, permit: null,
};
const execute = { ...request, mode: 'execute', checkpoint: reference, intent, permit };
const result = {
  kind: 'advance_result', contractVersion: RUNTIME_CONTRACT_VERSION, executionId: id,
  state: 'MODEL_REQUEST', checkpoint: reference, intent,
};

function accepts(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}
function rejects(value) {
  assert.equal(validate(value), false);
}

test('plan and execute messages round-trip with an exact bigint fence string', () => {
  for (const input of [request, execute]) {
    const decoded = JSON.parse(JSON.stringify(input));
    accepts(decoded);
    assert.equal(BigInt(decoded.fence), 9007199254740993n);
  }
});

test('plan never carries a permit and execute requires the complete persisted intent', () => {
  rejects({ ...request, permit });
  for (const field of ['checkpoint', 'intent', 'permit']) {
    rejects({ ...execute, [field]: null });
    const missing = structuredClone(execute);
    delete missing[field];
    rejects(missing);
  }
});

test('required identity and version fields cannot be omitted or replaced', () => {
  for (const field of ['executionId', 'runId', 'taskId', 'orgId', 'snapshotId', 'runtimeVersion', 'fence', 'deadlineUnixMs']) {
    const missing = structuredClone(request);
    delete missing[field];
    rejects(missing);
  }
  rejects({ ...request, contractVersion: 'work-runtime-fragment-v2' });
  rejects({ ...request, executionId: 'not-a-uuid' });
});

test('fence is decimal text rather than an unsafe JSON number', () => {
  for (const fence of [9007199254740992, '01', '-1', '1.5', '1e3', '']) {
    rejects({ ...request, fence });
  }
});

test('operation key and hashes are bounded rather than arbitrary strings', () => {
  for (const logicalKey of ['model:0', 'model:4', 'shell:1']) {
    rejects({ ...execute, intent: { ...intent, logicalKey } });
  }
  rejects({ ...execute, permit: { ...permit, requestHash: 'sha256:short' } });
  rejects({ ...execute, permit: { ...permit, dispatchAttemptId: null } });
});

test('all result variants have explicit persisted references or bounded failure reasons', () => {
  accepts(result);
  accepts({ ...result, state: 'CHECKPOINTED', intent: undefined, receipt: reference });
  accepts({ ...result, state: 'FINISHED', intent: undefined, artifact: reference });
  accepts({ ...result, state: 'WAITING_RECONCILE', intent: undefined, checkpoint: null, operationId: id, reason: 'provider_unknown' });
  accepts({ ...result, state: 'FAILED', intent: undefined, checkpoint: null, reason: 'checkpoint_failed' });
  accepts({ ...result, state: 'CANCELED', intent: undefined, checkpoint: null, reason: 'cancel_requested' });
});

test('success cannot omit a checkpoint or final reference', () => {
  rejects({ ...result, checkpoint: null });
  rejects({ ...result, state: 'CHECKPOINTED', intent: undefined });
  rejects({ ...result, state: 'FINISHED', intent: undefined });
});

test('result variants cannot be combined into contradictory facts', () => {
  rejects({ ...result, receipt: reference });
  rejects({ ...result, state: 'FINISHED', intent: undefined, artifact: reference, operationId: id });
  rejects({ ...result, state: 'FAILED', intent: undefined, reason: 'provider_unknown' });
  rejects({ ...result, state: 'WAITING_RECONCILE', intent: undefined, operationId: id, reason: 'checkpoint_failed' });
});

test('payloads reject additional content and credential fields at every nesting level', () => {
  for (const field of ['prompt', 'content', 'reasoning', 'messages', 'apiKey', 'token', 'stack', 'metadata']) {
    rejects({ ...request, [field]: 'synthetic-data' });
    rejects({ ...result, [field]: 'synthetic-data' });
    rejects({ ...execute, permit: { ...permit, [field]: 'synthetic-data' } });
    rejects({ ...result, intent: { ...intent, [field]: 'synthetic-data' } });
    rejects({ ...request, checkpoint: { ...reference, [field]: 'synthetic-data' } });
  }
});

test('stored references cannot be bearer URLs or filesystem paths', () => {
  for (const refId of ['https://example.invalid/object?token=synthetic', 'content://org/body', 'C:/private/file', '../other-run']) {
    rejects({ ...request, checkpoint: { ...reference, refId } });
  }
});

test('heartbeat carries bounded identity and phase rather than child logs', () => {
  const heartbeat = { kind: 'runtime_heartbeat', contractVersion: RUNTIME_CONTRACT_VERSION, executionId: id, sequence: 1, phase: 'executing' };
  accepts(heartbeat);
  rejects({ ...heartbeat, phase: 'arbitrary status text' });
  rejects({ ...heartbeat, sequence: -1 });
  rejects({ ...heartbeat, sequence: 9007199254740992 });
  rejects({ ...heartbeat, details: { prompt: 'synthetic' } });
});

test('cancel frame targets one execution and never carries a free-text reason', () => {
  const cancel = { kind: 'runtime_cancel', contractVersion: RUNTIME_CONTRACT_VERSION, executionId: id, reason: 'cancel_requested' };
  accepts(cancel);
  rejects({ ...cancel, reason: 'synthetic user text' });
  rejects({ ...cancel, token: 'synthetic' });
});

test('wire references are not grants and a valid shape does not prove identity binding', () => {
  accepts({ ...request, orgId: 'another_org' });
  accepts({ ...execute, permit: { ...permit, requestHash: `sha256:${'b'.repeat(64)}` } });
});

test('activity policy remains a single-shot design-signed but unimplemented contract', () => {
  assert.equal(RUNTIME_ACTIVITY_DRAFT.maximumAttempts, 1);
  assert.equal(RUNTIME_ACTIVITY_DRAFT.maxModelOperationsPerFragment, 1);
  assert.equal(RUNTIME_ACTIVITY_DRAFT.maxModelOperationsPerRun, 3);
  assert.equal(RUNTIME_ACTIVITY_DRAFT.approval, 'design_signed');
  assert.equal(RUNTIME_ACTIVITY_DRAFT.evidence, 'schema_only');
  assert.ok(RUNTIME_ACTIVITY_DRAFT.childHeartbeatIntervalMs < RUNTIME_ACTIVITY_DRAFT.heartbeatTimeoutMs);
  assert.ok(RUNTIME_ACTIVITY_DRAFT.startToCloseTimeoutMs < RUNTIME_ACTIVITY_DRAFT.scheduleToCloseTimeoutMs);
});

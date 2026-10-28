import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { canonicalJson, documentHash, deliveryTransition } from './runtime-recovery.model.mjs';
import { RECOVERY_DESIGN } from './RuntimeRecovery.contract.ts';

const require = createRequire(new URL('../../../../src/frontend/package.json', import.meta.url));
const Ajv = require('ajv');
const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(readJson('./advance-runtime.schema.json'), 'advance-runtime.schema.json');
const validate = ajv.compile(readJson('./runtime-recovery.schema.json'));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = (n) => ({ refId: uuid(n), hash: `sha256:${'a'.repeat(64)}` });
const binding = { orgId: 'org_1', taskId: uuid(1), runId: uuid(2), snapshotId: uuid(3), runtimeVersion: 'pi-1.4.0-build1' };
const request = {
  kind: 'model_request', schemaVersion: 'work-model-request-v1', binding,
  logicalKey: 'model:1', input: ref(4), template: ref(5), priorReceipts: [],
  route: { provider: 'aliyun', model: 'qwen-text', configRevision: '1', compatProfileVersion: 'v1' },
  parameters: { maxOutputTokens: 2048, temperatureMilli: 500, outputFormat: 'markdown' },
};
const pending = { request: ref(6), requestHash: documentHash(request), logicalKey: 'model:1' };
const checkpoint = {
  kind: 'canonical_state', schemaVersion: 'work-canonical-v1', binding, revision: 0,
  previous: null, writerExecutionId: uuid(7), input: ref(4), template: ref(5),
  completedModels: [], phase: 'ready', pending: null, artifact: null,
};
const receipt = {
  kind: 'model_receipt', schemaVersion: 'work-model-receipt-v1', receiptId: uuid(8), binding,
  logicalKey: 'model:1', operationId: uuid(9), dispatchAttemptId: uuid(10), executionId: uuid(7),
  requestHash: documentHash(request), writerGatewayId: uuid(11), recordedAtUnixMs: 1800000000000,
  outcome: 'succeeded', providerRequestId: 'req-1', content: ref(12), contentBytes: 32,
  usage: { source: 'provider', inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 }, rejectionEvidence: null,
};
const completedModel = { logicalKey: 'model:1', requestHash: receipt.requestHash, receipt: ref(8) };
const accepts = (value) => assert.equal(validate(value), true, JSON.stringify(validate.errors));
const rejects = (value) => assert.equal(validate(value), false);

test('request, initial checkpoint, pending checkpoint and receipt have valid shapes', () => {
  for (const value of [request, checkpoint, receipt, { ...checkpoint, revision: 1, previous: ref(13), phase: 'awaiting_model', pending }]) {
    accepts(JSON.parse(JSON.stringify(value)));
  }
});

test('checkpoint revision zero is initial only and later revisions require a predecessor', () => {
  rejects({ ...checkpoint, previous: ref(13) });
  rejects({ ...checkpoint, revision: 1 });
  rejects({ ...checkpoint, completedModels: [completedModel] });
});

test('finished state requires a result and cannot retain a pending request', () => {
  const finished = { ...checkpoint, revision: 2, previous: ref(13), phase: 'finished', completedModels: [completedModel], artifact: ref(12) };
  accepts(finished);
  rejects({ ...finished, artifact: null });
  rejects({ ...finished, pending });
  rejects({ ...finished, completedModels: [] });
});

test('completed and pending model collections are bounded', () => {
  const models = [1, 2, 3].map((n) => ({ logicalKey: `model:${n}`, requestHash: receipt.requestHash, receipt: ref(n + 20) }));
  accepts({ ...checkpoint, revision: 3, previous: ref(13), completedModels: models });
  rejects({ ...checkpoint, revision: 3, previous: ref(13), completedModels: [...models, models[0]] });
  rejects({ ...checkpoint, revision: 3, previous: ref(13), phase: 'awaiting_model', pending, completedModels: models });
});

test('success with unknown usage does not invent zero tokens', () => {
  const usage = { source: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null };
  accepts({ ...receipt, usage });
  rejects({ ...receipt, usage: { ...usage, outputTokens: 0 } });
  rejects({ ...receipt, usage: { source: 'provider', inputTokens: -1, outputTokens: 1, cachedInputTokens: 0 } });
});

test('not-executed rejection requires evidence and forbids content or billed usage', () => {
  const rejected = { ...receipt, outcome: 'rejected_not_executed', content: null, contentBytes: 0, rejectionEvidence: ref(14), usage: { source: 'provider', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
  accepts(rejected);
  rejects({ ...rejected, rejectionEvidence: null });
  rejects({ ...rejected, content: ref(12) });
  rejects({ ...rejected, usage: { ...rejected.usage, outputTokens: 1 } });
});

test('unknown and SDK aborted placeholders are not terminal receipts', () => {
  rejects({ ...receipt, outcome: 'unknown' });
  rejects({ ...receipt, outcome: 'aborted' });
  rejects({ ...receipt, content: null });
});

test('recovery documents reject raw messages, reasoning and credentials', () => {
  for (const value of [request, checkpoint, receipt]) {
    for (const key of ['messages', 'reasoning', 'apiKey', 'token', 'sdkState']) rejects({ ...value, [key]: 'synthetic' });
    rejects({ ...value, binding: { ...binding, token: 'synthetic' } });
  }
  rejects({ ...request, route: { ...request.route, baseUrl: 'https://example.invalid' } });
});

test('hashing sorts keys recursively but preserves array order and exact string bytes', () => {
  assert.equal(canonicalJson({ z: 1, a: ['b', 'a'] }), '{"a":["b","a"],"z":1}');
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.equal(documentHash(request), documentHash(reordered));
  assert.notEqual(canonicalJson(['a', 'b']), canonicalJson(['b', 'a']));
  assert.notEqual(canonicalJson('\u00e9'), canonicalJson('e\u0301'));
});

test('hash changes with routing, snapshot, input version and request parameters', () => {
  const variants = [
    { ...request, route: { ...request.route, model: 'other' } },
    { ...request, binding: { ...binding, snapshotId: uuid(50) } },
    { ...request, input: { ...request.input, hash: `sha256:${'b'.repeat(64)}` } },
    { ...request, parameters: { ...request.parameters, maxOutputTokens: 4096 } },
  ];
  for (const variant of variants) assert.notEqual(documentHash(request), documentHash(variant));
});

test('canonical encoding rejects unsafe integers, floats, malformed Unicode and unknown versions', () => {
  for (const value of [undefined, NaN, Infinity, -0, 0.5, 9007199254740992, '\ud800']) assert.throws(() => canonicalJson(value));
  assert.throws(() => documentHash({ ...request, schemaVersion: 'unknown' }));
  assert.equal(RECOVERY_DESIGN.approval, 'design_signed');
});

test('lost consume response cannot be replayed into a second won result', () => {
  const first = deliveryTransition(null, { kind: 'consume', invocationId: uuid(1) });
  assert.equal(first.won, true);
  for (const invocationId of [uuid(1), uuid(2)]) {
    const retry = deliveryTransition(first.gate, { kind: 'consume', invocationId });
    assert.equal(retry.won, false);
    assert.deepEqual(retry.gate, first.gate);
  }
});

test('all sequential orders of seal and two consumers grant at most one send', () => {
  const events = [{ kind: 'seal' }, { kind: 'consume', invocationId: uuid(1) }, { kind: 'consume', invocationId: uuid(2) }];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    let gate = null;
    let wins = 0;
    for (const index of order) {
      const result = deliveryTransition(gate, events[index]);
      gate = result.gate;
      wins += result.won === true ? 1 : 0;
    }
    assert.ok(wins <= 1);
    assert.equal(wins, order[0] === 0 ? 0 : 1);
  }
});

test('consumed gate cannot be certified not sent or reopened after receipt', () => {
  const consumed = deliveryTransition(null, { kind: 'consume', invocationId: uuid(1) }).gate;
  assert.equal(deliveryTransition(consumed, { kind: 'seal' }).sealed, false);
  const recorded = deliveryTransition(consumed, { kind: 'attach', receiptHash: documentHash(receipt) }).gate;
  assert.equal(deliveryTransition(recorded, { kind: 'consume', invocationId: uuid(2) }).won, false);
  assert.deepEqual(deliveryTransition(recorded, { kind: 'attach', receiptHash: documentHash(receipt) }).gate, recorded);
  assert.throws(() => deliveryTransition(recorded, { kind: 'attach', receiptHash: `sha256:${'c'.repeat(64)}` }), /receipt_conflict/);
});

test('receipt attachment requires consumption, not just an empty or sealed gate', () => {
  assert.throws(() => deliveryTransition(null, { kind: 'attach', receiptHash: receipt.requestHash }));
  const sealed = deliveryTransition(null, { kind: 'seal' }).gate;
  assert.throws(() => deliveryTransition(sealed, { kind: 'attach', receiptHash: receipt.requestHash }));
});

test('valid receipt shape and hash alone do not authenticate its writer', () => {
  const forged = { ...receipt, writerGatewayId: uuid(99) };
  accepts(forged);
  assert.notEqual(documentHash(forged), documentHash(receipt));
});

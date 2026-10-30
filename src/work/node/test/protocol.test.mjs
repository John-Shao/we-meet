import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FRAME_BYTES,
  MAX_OUTCOME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  createFrameReader,
  decodeFrame,
  encodeFrame,
  validateOutcome,
} from '../src/protocol.mjs';

const CHECKPOINT = { refId: '77777777-7777-4777-8777-777777777777', hash: `sha256:${'a'.repeat(64)}` };
const RECEIPT = { refId: '88888888-8888-4888-8888-888888888888', hash: `sha256:${'b'.repeat(64)}` };
const ARTIFACT = { refId: '99999999-9999-4999-8999-999999999999', hash: `sha256:${'c'.repeat(64)}` };
const INTENT = {
  request: { refId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', hash: `sha256:${'d'.repeat(64)}` },
  requestHash: `sha256:${'d'.repeat(64)}`,
  logicalKey: 'model:1',
};
const OPERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function hasCode(expected) {
  return (error) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, expected);
    return true;
  };
}

function rejectsCode(fn, code) {
  assert.throws(fn, hasCode(code));
}

test('round-trips hello, run, and result frames', () => {
  const hello = { v: PROTOCOL_VERSION, type: 'hello', runId: 'run-1', nonce: 'a'.repeat(48) };
  const run = { v: PROTOCOL_VERSION, type: 'run' };
  const result = { v: PROTOCOL_VERSION, type: 'result', status: 'completed' };

  assert.deepEqual(decodeFrame(encodeFrame(hello)), hello);
  assert.deepEqual(decodeFrame(encodeFrame(run)), run);
  assert.deepEqual(decodeFrame(encodeFrame(result)), result);
});

test('rejects non-object frames', () => {
  rejectsCode(() => decodeFrame('null'), 'not_object');
  rejectsCode(() => decodeFrame('[]'), 'not_object');
  rejectsCode(() => decodeFrame('"hello"'), 'not_object');
  rejectsCode(() => decodeFrame('42'), 'not_object');
  rejectsCode(() => decodeFrame({ type: 'hello' }), 'not_serialized');
});

test('rejects missing, unknown, and non-string types', () => {
  rejectsCode(() => decodeFrame(JSON.stringify({ v: 1 })), 'missing_type');
  rejectsCode(() => decodeFrame(JSON.stringify({ v: 1, type: 'cancel' })), 'unknown_type');
  rejectsCode(() => decodeFrame(JSON.stringify({ v: 1, type: 7 })), 'unknown_type');
  rejectsCode(() => encodeFrame({ v: 1, type: 'bogus' }), 'unknown_type');
});

test('rejects missing and wrong protocol versions', () => {
  rejectsCode(() => decodeFrame(JSON.stringify({ type: 'result', status: 'completed' })), 'missing_version');
  rejectsCode(() => decodeFrame(JSON.stringify({ v: 2, type: 'result', status: 'completed' })), 'wrong_version');
  rejectsCode(() => decodeFrame(JSON.stringify({ v: '1', type: 'result', status: 'completed' })), 'wrong_version');
});

test('rejects unexpected fields on every frame type', () => {
  rejectsCode(() => encodeFrame({
    v: PROTOCOL_VERSION,
    type: 'hello',
    runId: 'r',
    nonce: 'n',
    body: 'task body',
  }), 'unexpected_field');
  rejectsCode(() => encodeFrame({
    v: PROTOCOL_VERSION,
    type: 'run',
    payload: { goal: 'task body' },
  }), 'unexpected_field');
  rejectsCode(() => encodeFrame({
    v: PROTOCOL_VERSION,
    type: 'run',
    holderId: 'h',
  }), 'unexpected_field');
  rejectsCode(() => encodeFrame({
    v: PROTOCOL_VERSION,
    type: 'result',
    status: 'completed',
    output: 'task body',
  }), 'unexpected_field');
  rejectsCode(() => encodeFrame({
    v: PROTOCOL_VERSION,
    type: 'result',
    status: 'completed',
    diagnostics: { body: 'task body' },
  }), 'unexpected_field');
});

test('rejects invalid field values', () => {
  rejectsCode(() => encodeFrame({ v: 1, type: 'hello', runId: '', nonce: 'n' }), 'invalid_field');
  rejectsCode(() => encodeFrame({ v: 1, type: 'hello', runId: 'r', nonce: '' }), 'invalid_field');
  rejectsCode(() => encodeFrame({ v: 1, type: 'result', status: 'timed_out' }), 'invalid_field');
});

test('enforces the byte limit before parsing', () => {
  const invalidJson = 'x'.repeat(MAX_FRAME_BYTES + 1);
  rejectsCode(() => decodeFrame(invalidJson), 'frame_too_large');
  rejectsCode(() => decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78)), 'frame_too_large');
});

test('accepts exactly MAX_FRAME_BYTES and rejects one byte more', () => {
  const base = encodeFrame({ v: 1, type: 'hello', runId: 'r', nonce: 'n' });
  const padding = MAX_FRAME_BYTES - Buffer.byteLength(base, 'utf8');
  const exact = { v: 1, type: 'hello', runId: 'r', nonce: `n${'x'.repeat(padding)}` };

  assert.equal(Buffer.byteLength(encodeFrame(exact), 'utf8'), MAX_FRAME_BYTES);
  rejectsCode(() => encodeFrame({
    v: 1,
    type: 'hello',
    runId: 'r',
    nonce: `n${'x'.repeat(padding + 1)}`,
  }), 'frame_too_large');
});

test('the run frame carries no task body', () => {
  const decoded = decodeFrame(encodeFrame({ v: PROTOCOL_VERSION, type: 'run' }));
  assert.deepEqual(decoded, { v: PROTOCOL_VERSION, type: 'run' });
  rejectsCode(() => decodeFrame(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'run',
    payload: { body: 'never in a control frame' },
  })), 'unexpected_field');
});

test('frame reader splits chunks and rejects an oversized unterminated line', () => {
  const frames = [];
  let failure = null;
  const reader = createFrameReader({
    onFrame: (frame) => frames.push(frame),
    onError: (error) => { failure = error; },
  });

  const line = `${encodeFrame({ v: 1, type: 'result', status: 'completed' })}\n`;
  reader.push(Buffer.from(line.slice(0, 7)));
  reader.push(Buffer.from(line.slice(7)));
  assert.equal(frames.length, 1);
  assert.equal(failure, null);

  reader.push(Buffer.from('x'.repeat(MAX_FRAME_BYTES + 1)));
  assert.equal(failure.code, 'frame_too_large');
});

test('accepts a valid signed outcome alongside the status', () => {
  const outcome = { state: 'CHECKPOINTED', checkpoint: CHECKPOINT, receipt: RECEIPT };
  const frame = { v: PROTOCOL_VERSION, type: 'result', status: 'completed', outcome };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.deepEqual(decoded.outcome, outcome);
  assert.equal(decoded.status, 'completed');

  assert.deepEqual(validateOutcome({
    state: 'MODEL_REQUEST', checkpoint: CHECKPOINT, intent: INTENT,
  }), { state: 'MODEL_REQUEST', checkpoint: CHECKPOINT, intent: INTENT });
  assert.deepEqual(validateOutcome({
    state: 'WAITING_RECONCILE', operationId: OPERATION, reason: 'provider_unknown',
  }), {
    state: 'WAITING_RECONCILE', checkpoint: null, operationId: OPERATION, reason: 'provider_unknown',
  });
  assert.deepEqual(validateOutcome({
    state: 'FAILED', checkpoint: CHECKPOINT, reason: 'checkpoint_failed',
  }), { state: 'FAILED', checkpoint: CHECKPOINT, reason: 'checkpoint_failed' });
  assert.deepEqual(validateOutcome({ state: 'FAILED', reason: 'runtime_fault' }), {
    state: 'FAILED', checkpoint: null, reason: 'runtime_fault',
  });
  assert.deepEqual(validateOutcome({ state: 'FAILED', reason: 'provider_rejected' }), {
    state: 'FAILED', checkpoint: null, reason: 'provider_rejected',
  });
  assert.deepEqual(validateOutcome({ state: 'FINISHED', checkpoint: CHECKPOINT, artifact: ARTIFACT }), {
    state: 'FINISHED', checkpoint: CHECKPOINT, artifact: ARTIFACT,
  });
});

test('status-only result frames still validate', () => {
  for (const status of ['completed', 'failed']) {
    const frame = { v: PROTOCOL_VERSION, type: 'result', status };
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
  }
});

test('rejects an outcome with unknown keys at any level', () => {
  const frame = (outcome) => ({
    v: PROTOCOL_VERSION, type: 'result', status: 'completed', outcome,
  });
  rejectsCode(() => encodeFrame(frame({
    state: 'CHECKPOINTED', checkpoint: CHECKPOINT, receipt: RECEIPT, text: 'task body',
  })), 'unexpected_field');
  rejectsCode(() => encodeFrame(frame({
    state: 'CHECKPOINTED',
    checkpoint: { ...CHECKPOINT, text: 'task body' },
    receipt: RECEIPT,
  })), 'invalid_field');
  rejectsCode(() => encodeFrame(frame({
    state: 'MODEL_REQUEST', checkpoint: CHECKPOINT, intent: { ...INTENT, text: 'task body' },
  })), 'invalid_field');
  rejectsCode(() => encodeFrame(frame({
    state: 'CHECKPOINTED', checkpoint: CHECKPOINT, receipt: RECEIPT, reason: 'runtime_fault',
  })), 'unexpected_field');
});

test('rejects oversize, malformed and inconsistent outcomes', () => {
  rejectsCode(() => validateOutcome({ state: 'FAILED', reason: 'x'.repeat(MAX_OUTCOME_BYTES + 1) }),
    'outcome_too_large');
  rejectsCode(() => validateOutcome(null), 'invalid_field');
  rejectsCode(() => validateOutcome([]), 'invalid_field');
  rejectsCode(() => validateOutcome({ state: 'BOGUS' }), 'invalid_field');
  rejectsCode(() => validateOutcome({}), 'missing_field');
  rejectsCode(() => validateOutcome({ state: 'MODEL_REQUEST', checkpoint: CHECKPOINT }), 'missing_field');
  rejectsCode(() => validateOutcome({ state: 'CHECKPOINTED', checkpoint: CHECKPOINT }), 'missing_field');
  rejectsCode(() => validateOutcome({ state: 'WAITING_RECONCILE', operationId: OPERATION }),
    'missing_field');
  rejectsCode(() => validateOutcome({ state: 'WAITING_RECONCILE', operationId: OPERATION, reason: 'runtime_fault' }), 'invalid_field');
  // provider_rejected is a terminal failure only: an unknown outcome never
  // becomes a proven non-execution.
  rejectsCode(() => validateOutcome({ state: 'WAITING_RECONCILE', operationId: OPERATION, reason: 'provider_rejected' }), 'invalid_field');
  rejectsCode(() => validateOutcome({ state: 'CANCELED', reason: 'runtime_fault' }), 'invalid_field');
  assert.deepEqual(validateOutcome({ state: 'CANCELED', reason: 'cancel_requested' }), {
    state: 'CANCELED', checkpoint: null, reason: 'cancel_requested',
  });
});

test('rejects a bad uuid or hash inside an outcome', () => {
  rejectsCode(() => validateOutcome({
    state: 'CHECKPOINTED',
    checkpoint: { ...CHECKPOINT, refId: 'not-a-uuid' },
    receipt: RECEIPT,
  }), 'invalid_field');
  rejectsCode(() => validateOutcome({
    state: 'CHECKPOINTED',
    checkpoint: { ...CHECKPOINT, hash: 'sha256:ABC' },
    receipt: RECEIPT,
  }), 'invalid_field');
  rejectsCode(() => validateOutcome({
    state: 'CHECKPOINTED', checkpoint: CHECKPOINT,
    receipt: { refId: RECEIPT.refId, hash: `md5:${'b'.repeat(32)}` },
  }), 'invalid_field');
  rejectsCode(() => validateOutcome({
    state: 'MODEL_REQUEST', checkpoint: CHECKPOINT,
    intent: { ...INTENT, logicalKey: 'model:4' },
  }), 'invalid_field');
  rejectsCode(() => validateOutcome({
    state: 'WAITING_RECONCILE', operationId: 'not-a-uuid', reason: 'provider_unknown',
  }), 'invalid_field');
});

test('an outcome cannot smuggle task text past the size bound', () => {
  const marker = 'TASK_BODY_MARKER_5e1';
  let encoded = null;
  try {
    encoded = encodeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      status: 'completed',
      outcome: { state: 'CHECKPOINTED', checkpoint: CHECKPOINT, receipt: RECEIPT, note: marker },
    });
  } catch (error) {
    assert.ok(error instanceof ProtocolError);
  }
  assert.equal(encoded, null);
});

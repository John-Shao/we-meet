import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_FRAME_BYTES } from '../src/protocol.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { isAlive, recordingSpawn, waitFor } from '../test-support/helpers.mjs';

const FAST = { startTimeoutMs: 3000, runTimeoutMs: 2000, killGraceMs: 150 };

function makeSupervisor(spawn, overrides = {}) {
  return new Supervisor({
    maxConcurrent: 1,
    runtimeVersion: 'runtime-v1',
    ...FAST,
    spawn,
    ...overrides,
  });
}

function runRequest(runId = 'run-1', payload = {}) {
  return { runId, fence: 'fence-1', holderId: 'holder-1', payload };
}

async function expectViolation({ behavior, env }, code, phase) {
  const controller = recordingSpawn({ behavior, env });
  const supervisor = makeSupervisor(controller.spawn);
  try {
    const result = await supervisor.start(runRequest());
    assert.equal(result.status, 'protocol_violation');
    assert.equal(result.diagnostics.code, code);
    assert.equal(result.diagnostics.phase, phase);

    const record = controller.records[0];
    assert.equal(record.exited, true);
    assert.equal(isAlive(record.pid), false);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    await supervisor.shutdown();
  }
}

test('generates a fresh nonce per spawn, passes the payload opaquely, and completes', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-payload-'));
  const payloadFile = join(dir, 'payload.bin');
  const controller = recordingSpawn({
    behavior: 'ok',
    env: { WORK_STUB_PAYLOAD_FILE: payloadFile },
  });
  const supervisor = makeSupervisor(controller.spawn);
  const marker = 'TASK_BODY_MARKER_9f2c';
  const payload = {
    marker,
    v: 99,
    type: 'result',
    status: 'failed',
    body: { secret: marker },
  };
  process.env.WORK_PARENT_SECRET_SENTINEL = 'must-not-reach-child';
  t.after(async () => {
    delete process.env.WORK_PARENT_SECRET_SENTINEL;
    await rm(dir, { recursive: true, force: true });
  });

  const first = await supervisor.start(runRequest('run-1', payload));
  assert.equal(first.status, 'completed');
  assert.equal(first.exitCode, 0);
  assert.equal(Object.hasOwn(first, 'diagnostics'), false);
  assert.equal(JSON.stringify(first).includes(marker), false);
  assert.equal(controller.records[0].env.WORK_PARENT_SECRET_SENTINEL, undefined);
  assert.equal(JSON.stringify(controller.records[0].env).includes(marker), false);
  assert.deepEqual(await readFile(payloadFile), Buffer.from(JSON.stringify(payload), 'utf8'));

  const second = await supervisor.start(runRequest('run-2', {}));
  assert.equal(second.status, 'completed');

  assert.equal(controller.records.length, 2);
  const firstNonce = controller.records[0].env.WORK_RUN_NONCE;
  const secondNonce = controller.records[1].env.WORK_RUN_NONCE;
  assert.match(firstNonce, /^[0-9a-f]{48}$/);
  assert.match(secondNonce, /^[0-9a-f]{48}$/);
  assert.notEqual(firstNonce, secondNonce);
  assert.equal(controller.records[0].env.WORK_PROTOCOL_VERSION, '1');
  assert.equal(controller.records[0].env.WORK_RUN_ID, 'run-1');

  for (const record of controller.records) {
    assert.equal(record.exited, true);
    assert.equal(isAlive(record.pid), false);
  }
  await supervisor.shutdown();
});

test('a child-reported failure is reported as failed with its exit code', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'error' });
  const supervisor = makeSupervisor(controller.spawn);

  try {
    const result = await supervisor.start(runRequest());
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    assert.equal(result.diagnostics.code, 'child_reported_failure');

    const record = controller.records[0];
    assert.equal(record.exited, true);
    assert.equal(record.exitCode, 1);
    assert.equal(isAlive(record.pid), false);
  } finally {
    await supervisor.shutdown();
  }
});

test('a hello with the wrong nonce yields protocol_violation', { timeout: 10000 }, async () => {
  await expectViolation(
    { behavior: 'protocol_violation', env: { WORK_STUB_VIOLATION: 'nonce' } },
    'nonce_mismatch',
    'startup',
  );
});

test('a hello with the wrong protocol version yields protocol_violation', { timeout: 10000 }, async () => {
  await expectViolation(
    { behavior: 'protocol_violation', env: { WORK_STUB_VIOLATION: 'version' } },
    'wrong_version',
    'startup',
  );
});

test('an unparseable frame yields protocol_violation', { timeout: 10000 }, async () => {
  await expectViolation(
    { behavior: 'protocol_violation', env: { WORK_STUB_VIOLATION: 'malformed' } },
    'invalid_json',
    'startup',
  );
});

test('a hello with an unexpected field yields protocol_violation', { timeout: 10000 }, async () => {
  await expectViolation(
    { behavior: 'protocol_violation', env: { WORK_STUB_VIOLATION: 'extra_field' } },
    'unexpected_field',
    'startup',
  );
});

test('an oversized child frame yields protocol_violation', { timeout: 10000 }, async () => {
  await expectViolation({ behavior: 'oversized' }, 'frame_too_large', 'run');
});

test('runTimeoutMs kills a hung child and resolves timed_out only after its exit', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = makeSupervisor(controller.spawn, { runTimeoutMs: 300, killGraceMs: 150 });

  try {
    let exitedAtSettlement;
    const started = supervisor.start(runRequest());
    started.then(() => {
      exitedAtSettlement = controller.records[0]?.exited;
    });
    const result = await started;
    assert.equal(result.status, 'timed_out');
    assert.equal(result.diagnostics.phase, 'run');
    assert.equal(exitedAtSettlement, true);

    const record = controller.records[0];
    assert.equal(record.exited, true);
    assert.equal(isAlive(record.pid), false);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    await supervisor.shutdown();
  }
});

test('a child that exits non-zero before a result yields crashed exactly once', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'crash' });
  const supervisor = makeSupervisor(controller.spawn);

  let settlements = 0;
  const started = supervisor.start(runRequest());
  started.then(() => { settlements += 1; });

  const result = await started;
  assert.equal(result.status, 'crashed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.diagnostics.phase, 'run');

  await delay(100);
  assert.equal(settlements, 1);

  const record = controller.records[0];
  assert.equal(record.exitCode, 3);
  assert.equal(record.exited, true);
  assert.equal(isAlive(record.pid), false);
  assert.equal(controller.records.length, 1);
  await supervisor.shutdown();
});

test('a child that never sends hello is killed at startTimeoutMs and the supervisor stays usable', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({
    behavior: (index) => (index === 0
      ? { behavior: 'hang', env: { WORK_STUB_SKIP_HELLO: '1' } }
      : { behavior: 'ok' }),
  });
  const supervisor = makeSupervisor(controller.spawn, { startTimeoutMs: 300, runTimeoutMs: 2000 });

  try {
    const first = await supervisor.start(runRequest('run-1'));
    assert.equal(first.status, 'timed_out');
    assert.equal(first.diagnostics.phase, 'startup');
    assert.equal(controller.records[0].exited, true);
    assert.equal(isAlive(controller.records[0].pid), false);

    const second = await supervisor.start(runRequest('run-2'));
    assert.equal(second.status, 'completed');
    assert.equal(controller.records.length, 2);
    assert.equal(controller.records[1].exited, true);
    assert.equal(isAlive(controller.records[1].pid), false);
    assert.equal(supervisor.activeCount, 0);
  } finally {
    await supervisor.shutdown();
  }
});

test('a payload larger than MAX_FRAME_BYTES travels off-protocol and never enters control frames', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-payload-large-'));
  const payloadFile = join(dir, 'payload.bin');
  const controller = recordingSpawn({
    behavior: 'ok',
    env: { WORK_STUB_PAYLOAD_FILE: payloadFile },
  });
  const supervisor = makeSupervisor(controller.spawn);
  const marker = 'OFF_PROTOCOL_BODY_MARKER_7a1';
  const payload = { marker, pad: 'x'.repeat(MAX_FRAME_BYTES) };
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const result = await supervisor.start(runRequest('run-1', payload));
  assert.equal(result.status, 'completed');
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(controller.records[0].env).includes(marker), false);

  const received = await readFile(payloadFile);
  assert.equal(received.length > MAX_FRAME_BYTES, true);
  assert.deepEqual(received, Buffer.from(JSON.stringify(payload), 'utf8'));

  await supervisor.shutdown();
});

test('a valid result outcome is returned alongside the terminal status', { timeout: 10000 }, async () => {
  const outcome = {
    state: 'CHECKPOINTED',
    checkpoint: { refId: '77777777-7777-4777-8777-777777777777', hash: `sha256:${'a'.repeat(64)}` },
    receipt: { refId: '88888888-8888-4888-8888-888888888888', hash: `sha256:${'b'.repeat(64)}` },
  };
  const controller = recordingSpawn({
    behavior: 'outcome',
    env: {
      WORK_STUB_RESULT_FRAME: JSON.stringify({
        v: 1, type: 'result', status: 'completed', outcome,
      }),
    },
  });
  const supervisor = makeSupervisor(controller.spawn);
  try {
    const result = await supervisor.start(runRequest());
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.outcome, outcome);
    assert.equal(JSON.stringify(result).includes('TASK_BODY_MARKER'), false);
  } finally {
    await supervisor.shutdown();
  }
});

test('a status-only result carries no outcome', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const supervisor = makeSupervisor(controller.spawn);
  try {
    const result = await supervisor.start(runRequest());
    assert.equal(result.status, 'completed');
    assert.equal(Object.hasOwn(result, 'outcome'), false);
  } finally {
    await supervisor.shutdown();
  }
});

test('a malformed outcome kills the child with protocol_violation', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({
    behavior: 'outcome',
    env: {
      WORK_STUB_RESULT_FRAME: JSON.stringify({
        v: 1,
        type: 'result',
        status: 'completed',
        outcome: {
          state: 'CHECKPOINTED',
          checkpoint: { refId: '77777777-7777-4777-8777-777777777777', hash: `sha256:${'a'.repeat(64)}` },
          receipt: { refId: '88888888-8888-4888-8888-888888888888', hash: `sha256:${'b'.repeat(64)}` },
          text: 'TASK_BODY_MARKER_5e1',
        },
      }),
    },
  });
  const supervisor = makeSupervisor(controller.spawn);
  try {
    const result = await supervisor.start(runRequest());
    assert.equal(result.status, 'protocol_violation');
    assert.equal(result.diagnostics.code, 'unexpected_field');
    assert.equal(result.diagnostics.phase, 'run');
    assert.equal(Object.hasOwn(result, 'outcome'), false);
    assert.equal(JSON.stringify(result).includes('TASK_BODY_MARKER_5e1'), false);
    const record = controller.records[0];
    assert.equal(record.exited, true);
    assert.equal(isAlive(record.pid), false);
  } finally {
    await supervisor.shutdown();
  }
});

test('invalid start requests are rejected without spawning', async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = makeSupervisor(controller.spawn);

  for (const request of [
    null,
    {},
    { runId: 'r', fence: 'f', holderId: 'h' },
    { runId: '', fence: 'f', holderId: 'h', payload: {} },
    { runId: 'r', fence: 'f', holderId: 'h', payload: {}, extra: true },
  ]) {
    const result = await supervisor.start(request);
    assert.equal(result.status, 'rejected');
    assert.equal(result.diagnostics.reason, 'invalid_request');
  }

  assert.equal(controller.records.length, 0);
  await supervisor.shutdown();
});

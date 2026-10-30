import test from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/supervisor.mjs';
import { isAlive, recordingSpawn, waitFor } from '../test-support/helpers.mjs';

const BASE = { startTimeoutMs: 4000, runTimeoutMs: 3000, killGraceMs: 150 };

function makeSupervisor(spawn, overrides = {}) {
  return new Supervisor({
    maxConcurrent: 2,
    runtimeVersion: 'runtime-v1',
    ...BASE,
    spawn,
    ...overrides,
  });
}

test('a second concurrent start for the same Run is rejected without a second spawn', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = makeSupervisor(controller.spawn);

  const first = supervisor.start({ runId: 'run-1', fence: 'fence-1', holderId: 'holder-1', payload: { goal: 'x' } });
  await waitFor(() => controller.records.length === 1 && controller.records[0].pid !== undefined);

  const second = await supervisor.start({ runId: 'run-1', fence: 'fence-1', holderId: 'holder-1', payload: { goal: 'x' } });
  assert.equal(second.status, 'rejected');
  assert.equal(second.diagnostics.reason, 'run_active');
  assert.equal(controller.records.length, 1);
  assert.equal(supervisor.activeCount, 1);

  await supervisor.shutdown();
  const firstResult = await first;
  assert.equal(firstResult.status, 'failed');
  assert.equal(controller.records[0].exited, true);
  assert.equal(isAlive(controller.records[0].pid), false);
});

test('the per-Pod concurrency bound rejects a third Run and spawns nothing', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = makeSupervisor(controller.spawn, { maxConcurrent: 2 });

  const first = supervisor.start({ runId: 'run-1', fence: 1, holderId: 'h', payload: {} });
  const second = supervisor.start({ runId: 'run-2', fence: 2, holderId: 'h', payload: {} });
  await waitFor(() => controller.records.length === 2 && controller.records.every((record) => record.pid !== undefined));

  assert.deepEqual(
    supervisor.admit({ runFence: 3, runtimeVersion: 'runtime-v1' }),
    { ok: false, reason: 'capacity' },
  );

  const third = await supervisor.start({ runId: 'run-3', fence: 3, holderId: 'h', payload: {} });
  assert.equal(third.status, 'rejected');
  assert.equal(third.diagnostics.reason, 'capacity');
  assert.equal(controller.records.length, 2);
  assert.equal(supervisor.activeCount, 2);

  await supervisor.shutdown();
  await Promise.all([first, second]);
  assert.equal(isAlive(controller.records[0].pid), false);
  assert.equal(isAlive(controller.records[1].pid), false);
});

test('the runtime version gate refuses admission before any spawn', async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const supervisor = makeSupervisor(controller.spawn);

  assert.deepEqual(
    supervisor.admit({ runFence: 'fence-1', runtimeVersion: 'runtime-v2' }),
    { ok: false, reason: 'version_mismatch' },
  );
  assert.deepEqual(
    supervisor.admit({ runFence: 'fence-1', runtimeVersion: 'runtime-v1' }),
    { ok: true },
  );
  assert.equal(controller.records.length, 0);

  await supervisor.shutdown();
});

test('drain refuses new work while an in-flight child finishes normally', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok', env: { WORK_STUB_DELAY_MS: '150' } });
  const supervisor = makeSupervisor(controller.spawn, { maxConcurrent: 2, killGraceMs: 1500 });

  const running = supervisor.start({ runId: 'run-1', fence: 'fence-1', holderId: 'h', payload: {} });
  await waitFor(() => controller.records.length === 1 && controller.records[0].pid !== undefined);

  const drained = supervisor.drain();
  assert.equal(supervisor.draining, true);
  assert.deepEqual(
    supervisor.admit({ runFence: 'fence-2', runtimeVersion: 'runtime-v1' }),
    { ok: false, reason: 'draining' },
  );

  const rejected = await supervisor.start({ runId: 'run-2', fence: 'fence-2', holderId: 'h', payload: {} });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.diagnostics.reason, 'draining');
  assert.equal(controller.records.length, 1);

  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  await drained;

  assert.equal(controller.records.length, 1);
  assert.equal(isAlive(controller.records[0].pid), false);
  await supervisor.shutdown();
});

test('drain kills a child that outlives the grace window', { timeout: 10000 }, async () => {
  const controller = recordingSpawn({ behavior: 'hang', env: { WORK_STUB_IGNORE_SIGTERM: '1' } });
  const supervisor = makeSupervisor(controller.spawn, { maxConcurrent: 1, killGraceMs: 200 });

  const running = supervisor.start({ runId: 'run-1', fence: 'fence-1', holderId: 'h', payload: {} });
  await waitFor(() => controller.records.length === 1 && controller.records[0].pid !== undefined);

  await supervisor.drain();
  const result = await running;
  assert.equal(result.status, 'timed_out');
  assert.equal(result.diagnostics.phase, 'drain');
  assert.equal(controller.records[0].exited, true);
  assert.equal(isAlive(controller.records[0].pid), false);
  assert.equal(supervisor.activeCount, 0);
});

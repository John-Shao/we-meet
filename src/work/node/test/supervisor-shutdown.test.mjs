import test from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/supervisor.mjs';
import { isAlive, killQuietly, recordingSpawn, waitFor } from '../test-support/helpers.mjs';

test('shutdown escalates SIGTERM to SIGKILL and leaves no live child', { timeout: 15000 }, async (t) => {
  const controller = recordingSpawn({ behavior: 'hang', env: { WORK_STUB_IGNORE_SIGTERM: '1' } });
  const supervisor = new Supervisor({
    maxConcurrent: 2,
    runtimeVersion: 'runtime-v1',
    startTimeoutMs: 4000,
    runTimeoutMs: 5000,
    killGraceMs: 200,
    spawn: controller.spawn,
  });
  t.after(() => {
    for (const record of controller.records) killQuietly(record.pid);
  });

  const first = supervisor.start({ runId: 'run-1', fence: 1, holderId: 'h', payload: {} });
  const second = supervisor.start({ runId: 'run-2', fence: 2, holderId: 'h', payload: {} });
  await waitFor(() => controller.records.length === 2 && controller.records.every((record) => record.pid !== undefined));

  const pids = controller.records.map((record) => record.pid);
  assert.equal(pids.every((pid) => isAlive(pid)), true);

  await supervisor.shutdown();
  const results = await Promise.all([first, second]);

  for (const result of results) {
    assert.equal(result.status, 'failed');
    assert.equal(result.diagnostics.phase, 'shutdown');
  }
  for (const record of controller.records) {
    assert.equal(record.exited, true);
    assert.equal(isAlive(record.pid), false);
  }
  assert.equal(supervisor.activeCount, 0);

  const afterShutdown = await supervisor.start({ runId: 'run-3', fence: 3, holderId: 'h', payload: {} });
  assert.equal(afterShutdown.status, 'rejected');
  assert.equal(afterShutdown.diagnostics.reason, 'draining');

  await supervisor.shutdown({ force: true });
});

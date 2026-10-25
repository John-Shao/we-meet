import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, closePools } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import { submitTask, getTask, getBudget, getArtifactCount } from '../src/api.mjs';
import { startWorkflowDirect, closeRelay } from '../src/relay.mjs';

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('waitFor timeout');
}

test('normal Temporal run reaches acceptance', async () => {
  await setupDatabase();
  const worker = await startWorker();
  try {
    const task = await submitTask({
      clientRequestId: `smoke-${Date.now()}`,
      goal: 'Smoke normal Temporal run',
    });
    await startWorkflowDirect({
      runId: task.run_id,
      taskId: task.task_id,
      workflowId: task.workflowId,
      faultMode: 'none',
    });
    const summary = await waitFor(async () => {
      const value = await getTask(task.task_id);
      return value?.display_state === 'awaiting_acceptance' ? value : null;
    });
    assert.equal(summary.display_state, 'awaiting_acceptance');
    assert.equal(await getArtifactCount(task.task_id), 1);
    const budget = await getBudget();
    assert.equal(Number(budget.reserved_cents), 0);
    assert.equal(Number(budget.settled_cents), 80);
  } finally {
    await worker.shutdown();
    await closeRelay();
    await closePools();
  }
});

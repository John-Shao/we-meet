import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, closePools } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import { getArtifactCount, getBudget, getTask, submitTask } from '../src/api.mjs';
import { closeRelay, startWorkflowDirect } from '../src/relay.mjs';

let worker;
const nonce = Date.now().toString(36);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('waitFor timeout');
}

test.before(async () => {
  await setupDatabase();
  worker = await startWorker();
  await sleep(250);
});

test.after(async () => {
  if (worker) await worker.shutdown();
  await closeRelay();
  await closePools();
});

test('10 concurrent pilot-shaped runs complete within the pilot envelope', async () => {
  const submittedAt = Date.now();
  const tasks = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      submitTask({
        clientRequestId: `load-${nonce}-${i}`,
        goal: `Pilot load task ${i}`,
        workflowId: `run:load-${nonce}-${i}`,
      }),
    ),
  );
  await Promise.all(
    tasks.map((task) =>
      startWorkflowDirect({
        runId: task.run_id,
        taskId: task.task_id,
        workflowId: task.workflowId,
      }),
    ),
  );
  await Promise.all(
    tasks.map((task) =>
      waitFor(async () => {
        const summary = await getTask(task.task_id);
        return summary?.display_state === 'awaiting_acceptance' ? summary : null;
      }),
    ),
  );
  const elapsed = Date.now() - submittedAt;
  for (const task of tasks) {
    assert.equal(await getArtifactCount(task.task_id), 1);
  }
  const budget = await getBudget();
  assert.equal(Number(budget.reserved_cents), 0);
  assert.equal(Number(budget.settled_cents), 800);
  console.log(`LOAD_RESULT ${JSON.stringify({ runs: tasks.length, elapsed_ms: elapsed, settled_cents: 800 })}`);
});

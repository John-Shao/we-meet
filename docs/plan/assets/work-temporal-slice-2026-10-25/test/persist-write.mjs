import { setupDatabase, closePools } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import { getTask, submitTask } from '../src/api.mjs';
import { closeRelay, startWorkflowDirect } from '../src/relay.mjs';

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
  throw new Error('persist-write waitFor timeout');
}

await setupDatabase();
const worker = await startWorker();
const task = await submitTask({
  clientRequestId: `persist-write-${Date.now()}`,
  goal: 'Temporal persistence restart smoke',
  workflowId: `run:persist-${Date.now()}`,
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
console.log(
  `PERSIST_RESULT ${JSON.stringify({
    workflowId: task.workflowId,
    taskId: task.task_id,
    display: summary.display_state,
  })}`,
);
await worker.shutdown();
await closeRelay();
await closePools();

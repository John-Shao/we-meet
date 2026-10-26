import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, closePools } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import {
  getArtifactLogicalNames,
  getOperations,
  getTask,
  submitTask,
} from '../src/api.mjs';
import {
  closeRelay,
  signalResume,
  startWorkflowDirect,
} from '../src/relay.mjs';

let worker;
let nonce;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('waitFor timeout');
}

async function submit(prefix, goal, faultMode = 'none') {
  return submitTask({
    clientRequestId: `${prefix}-${nonce}`,
    goal,
    faultMode,
    workflowId: `run:${prefix}-${nonce}`,
  });
}

async function waitOperationSucceeded(runId) {
  return waitFor(async () => {
    const ops = await getOperations(runId);
    return ops.length === 1 && ops[0].state === 'succeeded' ? ops[0] : null;
  });
}

test.before(async () => {
  await setupDatabase();
  nonce = Date.now().toString(36);
  worker = await startWorker({ workflowsFile: 'workflows-v1.mjs' });
  await sleep(250);
});

test.after(async () => {
  if (worker) await worker.shutdown();
  await closeRelay();
  await closePools();
});

test('worker upgrade: old workflow keeps v1 artifact, new workflow uses v2 patch', async () => {
  const oldTask = await submit('up-old', 'Upgrade old workflow', 'hold_before_publish');
  await startWorkflowDirect({
    runId: oldTask.run_id,
    taskId: oldTask.task_id,
    workflowId: oldTask.workflowId,
    faultMode: 'hold_before_publish',
  });
  await waitOperationSucceeded(oldTask.run_id);
  assert.deepEqual(await getArtifactLogicalNames(oldTask.task_id), []);

  await worker.shutdown();
  worker = await startWorker({ workflowsFile: 'workflows.mjs' });
  await sleep(250);

  const newTask = await submit('up-new', 'Upgrade new workflow');
  await startWorkflowDirect({
    runId: newTask.run_id,
    taskId: newTask.task_id,
    workflowId: newTask.workflowId,
    faultMode: 'none',
  });
  await waitFor(async () => {
    const value = await getTask(newTask.task_id);
    return value?.display_state === 'awaiting_acceptance' ? value : null;
  });
  assert.deepEqual(await getArtifactLogicalNames(newTask.task_id), ['draft-v2.md']);

  await signalResume(oldTask.workflowId);
  await waitFor(async () => {
    const value = await getTask(oldTask.task_id);
    return value?.display_state === 'awaiting_acceptance' ? value : null;
  });
  assert.deepEqual(await getArtifactLogicalNames(oldTask.task_id), ['draft.md']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, setupDatabase, closePools, withAdmin } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import {
  countTasks,
  finishRunFailed,
  getArtifactCount,
  getOperations,
  getTask,
  setOrgExecution,
  submitTask,
} from '../src/api.mjs';
import {
  closeRelay,
  describeWorkflow,
  signalResume,
  startWorkflowDirect,
} from '../src/relay.mjs';
import { acquireRun } from '../src/activities.mjs';

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
  const clientRequestId = `${prefix}-${nonce}`;
  const workflowId = `run:${prefix}-${nonce}`;
  const result = await submitTask({ clientRequestId, goal, faultMode, workflowId });
  return { ...result, clientRequestId };
}

async function waitOperationSucceeded(runId) {
  return waitFor(async () => {
    const ops = await getOperations(runId);
    return ops.length === 1 && ops[0].state === 'succeeded' ? ops[0] : null;
  });
}

async function insertOldOutbox() {
  return withAdmin(async (client) => {
    const result = await client.query(
      `INSERT INTO work.outbox
         (org_id, aggregate_type, aggregate_id, event_id, payload, available_at, created_at)
       VALUES ($1, 'run', gen_random_uuid(), gen_random_uuid(),
               '{"kind":"start_workflow"}'::jsonb,
               now() - interval '10 minutes', now() - interval '10 minutes')
       RETURNING event_id`,
      [CFG.org],
    );
    return result.rows[0].event_id;
  });
}

async function deleteOutbox(eventId) {
  return withAdmin(async (client) => {
    await client.query('DELETE FROM work.outbox WHERE event_id = $1', [eventId]);
  });
}

test.before(async () => {
  await setupDatabase();
  nonce = Date.now().toString(36);
  worker = await startWorker();
  await sleep(250);
});

test.after(async () => {
  if (worker) await worker.shutdown();
  await closeRelay();
  await closePools();
});

test('S1-R01: worker restart while workflow holds; resume publishes once', async () => {
  const task = await submit('s1r', 'S1 worker restart hold', 'hold_before_publish');
  await startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode: 'hold_before_publish',
  });
  await waitOperationSucceeded(task.run_id);
  assert.equal(await getArtifactCount(task.task_id), 0);

  await worker.shutdown();
  worker = null;
  await sleep(250);
  worker = await startWorker();
  await sleep(250);
  await signalResume(task.workflowId);

  const summary = await waitFor(async () => {
    const value = await getTask(task.task_id);
    return value?.display_state === 'awaiting_acceptance' ? value : null;
  });
  assert.equal(summary.display_state, 'awaiting_acceptance');
  assert.equal(await getArtifactCount(task.task_id), 1);
});

test('S1-R02: DB terminal wins over an in-flight workflow; no late artifact', async () => {
  const task = await submit('s1o', 'S1 DB terminal offset', 'hold_before_publish');
  await startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode: 'hold_before_publish',
  });
  await waitOperationSucceeded(task.run_id);
  await finishRunFailed(task.run_id, 'db_terminal_offset');
  const failedTask = await getTask(task.task_id);
  assert.equal(failedTask.display_state, 'failed');

  await signalResume(task.workflowId);
  const failedWorkflow = await waitFor(async () => {
    try {
      const description = await describeWorkflow(task.workflowId);
      return description.status?.name === 'FAILED' ? description : null;
    } catch {
      return null;
    }
  }, 15000);
  assert.equal(failedWorkflow.status.name, 'FAILED');
  assert.equal(await getArtifactCount(task.task_id), 0);
  assert.equal((await getTask(task.task_id)).display_state, 'failed');
});

test('S1-R03: execution switch/org suspension blocks new submit and acquire; resume is explicit', async () => {
  await setOrgExecution({ executionEnabled: false, operatorSuspended: false });
  await assert.rejects(
    () => submit('s1k', 'S1 execution disabled'),
    /org_execution_unavailable/,
  );
  await setOrgExecution({ executionEnabled: true, operatorSuspended: false });

  const task = await submit('s1s', 'S1 org suspend acquire');
  await setOrgExecution({ executionEnabled: true, operatorSuspended: true });
  await assert.rejects(
    () => acquireRun(task.run_id, CFG.org),
    /org_execution_unavailable/,
  );
  await assert.rejects(
    () => submit('s1s2', 'S1 org suspend submit'),
    /org_execution_unavailable/,
  );

  await setOrgExecution({ executionEnabled: true, operatorSuspended: false });
  const acquired = await acquireRun(task.run_id, CFG.org);
  assert.equal(acquired.state, 'active');
  await finishRunFailed(task.run_id, 'cleanup');
});

test('S1-R04: outbox backlog fails new submits closed and recovers after drain', async () => {
  const before = await countTasks();
  const oldEvent = await insertOldOutbox();
  await assert.rejects(
    () => submit('s1b', 'S1 outbox backlog'),
    /outbox_backlog/,
  );
  assert.equal(await countTasks(), before);

  await deleteOutbox(oldEvent);
  const task = await submit('s1b2', 'S1 outbox backlog recovered');
  assert.ok(task.task_id);
  assert.equal(await countTasks(), before + 1);
});

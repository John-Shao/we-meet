import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, setupDatabase, closePools } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import {
  countTasks,
  finishRunFailed,
  getArtifactCount,
  getAuditCount,
  getBudget,
  getDedup,
  getOperations,
  getOutboxStart,
  getRun,
  getRunCountForTask,
  getTask,
  markDedupDeleted,
  reconcileNotSent,
  requestCancel,
  submitTask,
} from '../src/api.mjs';
import {
  closeRelay,
  describeWorkflow,
  relayOnce,
  signalCancel,
  startWorkflowDirect,
} from '../src/relay.mjs';
import { claimDispatch, getProviderCalls, resetProviderCalls } from '../src/activities.mjs';

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

async function workflowExists(workflowId) {
  try {
    await describeWorkflow(workflowId);
    return true;
  } catch {
    return false;
  }
}

test.before(async () => {
  await setupDatabase();
  resetProviderCalls();
  nonce = Date.now().toString(36);
  worker = await startWorker();
  await sleep(250);
});

test.after(async () => {
  await worker.shutdown();
  await closeRelay();
  await closePools();
});

test('F01: submit commits, relay is down, then exactly one workflow starts', async () => {
  const task = await submit('f01', 'F01 submit before relay');
  const outbox = await getOutboxStart(task.run_id);
  assert.ok(outbox);
  assert.equal(outbox.delivered_at, null);
  assert.equal(await workflowExists(task.workflowId), false);
  assert.equal(await getRunCountForTask(task.task_id), 1);

  await relayOnce();
  const summary = await waitFor(async () => {
    const value = await getTask(task.task_id);
    return value?.display_state === 'awaiting_acceptance' ? value : null;
  });
  assert.equal(summary.display_state, 'awaiting_acceptance');
  assert.equal(await getRunCountForTask(task.task_id), 1);
  assert.equal(await getArtifactCount(task.task_id), 1);
  const delivered = await waitFor(async () => {
    const value = await getOutboxStart(task.run_id);
    return value?.delivered_at ? value : null;
  });
  assert.ok(delivered.delivered_at);
  assert.equal(await workflowExists(task.workflowId), true);
  const budget = await getBudget();
  assert.equal(Number(budget.reserved_cents), 0);
  assert.equal(Number(budget.settled_cents), 80);
});

test('F02: workflow start succeeds but relay loses ACK; retry does not create a second Run', async () => {
  const task = await submit('f02', 'F02 start without relay ACK');
  await assert.rejects(() => relayOnce({ failAfterStart: true }), /simulated relay crash/);
  assert.equal(await workflowExists(task.workflowId), true);
  assert.equal(await getRunCountForTask(task.task_id), 1);
  const beforeAck = await getOutboxStart(task.run_id);
  assert.equal(beforeAck.delivered_at, null);

  await relayOnce();
  const summary = await waitFor(async () => {
    const value = await getTask(task.task_id);
    return value?.display_state === 'awaiting_acceptance' ? value : null;
  });
  assert.equal(summary.display_state, 'awaiting_acceptance');
  assert.equal(await getRunCountForTask(task.task_id), 1);
  assert.equal(await getArtifactCount(task.task_id), 1);
  const delivered = await waitFor(async () => {
    const value = await getOutboxStart(task.run_id);
    return value?.delivered_at ? value : null;
  });
  assert.ok(delivered.delivered_at);
});

test('F04: provider accepted but no receipt -> unknown, budget held, no replay', async () => {
  const task = await submit('f04', 'F04 provider lost after accept', 'provider_unknown');
  await startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode: 'provider_unknown',
  });
  const operation = await waitFor(async () => {
    const ops = await getOperations(task.run_id);
    return ops.length === 1 && ops[0].state === 'unknown' ? ops[0] : null;
  });
  const summary = await getTask(task.task_id);
  assert.equal(summary.display_state, 'reconciling');
  assert.equal(getProviderCalls(task.run_id), 1);
  assert.equal(await getArtifactCount(task.task_id), 0);
  const budget = await getBudget();
  assert.equal(Number(budget.reserved_cents), 100);

  await reconcileNotSent(operation.id);
  const reconciled = await getOperations(task.run_id);
  assert.equal(reconciled[0].state, 'reconciled');
  const released = await getBudget();
  assert.equal(Number(released.reserved_cents), 0);
  await finishRunFailed(task.run_id, 'reconciled_not_sent');
});

test('F07: cancel during dispatch does not publish a late artifact', async () => {
  const task = await submit('f07', 'F07 cancel before late model result', 'late_after_cancel');
  await startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode: 'late_after_cancel',
  });
  await waitFor(() => (getProviderCalls(task.run_id) === 1 ? true : null));
  await requestCancel(task.run_id, 'test cancel');
  await signalCancel(task.workflowId, 'test cancel');

  const run = await waitFor(async () => {
    const value = await getRun(task.run_id);
    return value?.state === 'canceled' ? value : null;
  });
  assert.equal(run.state, 'canceled');
  const operation = (await getOperations(task.run_id))[0];
  assert.equal(operation.state, 'unknown');
  assert.equal(await getArtifactCount(task.task_id), 0);
  const summary = await getTask(task.task_id);
  assert.equal(summary.display_state, 'run_canceled');
  assert.ok((await getAuditCount(task.run_id)) > 0);

  await sleep(1800); // allow the late activity to finish; it must not publish
  assert.equal(await getArtifactCount(task.task_id), 0);
  const budget = await getBudget();
  assert.equal(Number(budget.reserved_cents), 100);

  await reconcileNotSent(operation.id);
  const released = await getBudget();
  assert.equal(Number(released.reserved_cents), 0);
});

test('F21: crash after claim leaves one dispatch attempt and no blind resend', async () => {
  const task = await submit('f21', 'F21 crash after claim', 'claim_crash');
  await startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode: 'claim_crash',
  });
  const operation = await waitFor(async () => {
    const ops = await getOperations(task.run_id);
    return ops.length === 1 && ops[0].state === 'unknown' ? ops[0] : null;
  });
  const summary = await getTask(task.task_id);
  assert.equal(summary.display_state, 'reconciling');
  assert.equal(getProviderCalls(task.run_id), 0);
  assert.ok(operation.dispatch_attempt_id);
  const run = await getRun(task.run_id);
  const takeover = await claimDispatch(operation.id, CFG.org, run.fence);
  assert.equal(takeover, null);
  assert.equal(await getArtifactCount(task.task_id), 0);
  const budget = await getBudget();
  assert.equal(Number(budget.reserved_cents), 100);

  await reconcileNotSent(operation.id);
  const released = await getBudget();
  assert.equal(Number(released.reserved_cents), 0);
  await finishRunFailed(task.run_id, 'reconciled_not_sent');
});

test('F23: persistent dedup rejects replay after Task deletion without a new charge', async () => {
  const before = await countTasks();
  const task = await submit('f23', 'F23 replay after delete');
  const afterCreate = await countTasks();
  assert.equal(afterCreate, before + 1);
  const replay = await submitTask({
    clientRequestId: task.clientRequestId,
    goal: 'F23 replay after delete',
    workflowId: `run:f23-replay-${nonce}`,
  });
  assert.equal(replay.task_id, task.task_id);
  assert.equal(await countTasks(), afterCreate);

  const dedup = await getDedup(task.clientRequestId);
  assert.ok(dedup);
  await markDedupDeleted(task.clientRequestId);
  await assert.rejects(
    () =>
      submitTask({
        clientRequestId: task.clientRequestId,
        goal: 'F23 replay after delete',
        workflowId: `run:f23-second-${nonce}`,
      }),
    /task_deleted/,
  );
  assert.equal(await countTasks(), afterCreate);
});

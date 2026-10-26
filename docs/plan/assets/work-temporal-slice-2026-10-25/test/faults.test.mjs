import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, setupDatabase, closePools, withWorker } from '../src/db.mjs';
import { startWorker } from '../src/worker.mjs';
import {
  countTasks,
  finishRunFailed,
  getArtifactCount,
  getAuditCount,
  getBudget,
  getDedup,
  getOperations,
  getOutboxForRun,
  getReservation,
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
  signalResume,
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

async function submit(prefix, goal, faultMode = 'none', extra = {}) {
  const clientRequestId = `${prefix}-${nonce}`;
  const workflowId = `run:${prefix}-${nonce}`;
  const result = await submitTask({ clientRequestId, goal, faultMode, workflowId, ...extra });
  return { ...result, clientRequestId };
}

async function startDirect(task, faultMode) {
  return startWorkflowDirect({
    runId: task.run_id,
    taskId: task.task_id,
    workflowId: task.workflowId,
    faultMode,
    orgId: task.org,
  });
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
  await assert.rejects(
    () => relayOnce({ failAfterStart: true, leaseSeconds: 5 }),
    /simulated relay crash/,
  );
  assert.equal(await workflowExists(task.workflowId), true);
  assert.equal(await getRunCountForTask(task.task_id), 1);
  const beforeAck = await getOutboxStart(task.run_id);
  assert.equal(beforeAck.delivered_at, null);
  assert.equal(beforeAck.claimed_by, 'slice-relay-a');

  // Another relay cannot take the row while the crashed relay's lease is live.
  const during = await relayOnce({ relayId: 'slice-relay-b' });
  assert.equal(during.some((r) => r.eventId === beforeAck.event_id), false);
  await sleep(5200);
  const takeover = await relayOnce({ relayId: 'slice-relay-b' });
  assert.ok(takeover.some((r) => r.eventId === beforeAck.event_id && r.outcome === 'delivered'));
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

test('F07: cancel during dispatch does not publish, and bills the late usage', async () => {
  const task = await submit('f07', 'F07 cancel before late model result', 'late_after_cancel');
  await startDirect(task, 'late_after_cancel');
  await waitFor(() => (getProviderCalls(task.run_id) === 1 ? true : null));
  await requestCancel(task.run_id, 'user_requested');
  await signalCancel(task.workflowId, 'not a reason code');

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

  // The late result must not publish, but its real usage must be billed (no under-billing).
  const reconciled = await waitFor(async () => {
    const ops = await getOperations(task.run_id);
    return ops[0]?.state === 'reconciled' ? ops[0] : null;
  });
  assert.equal(reconciled.provider_request_id, `provider-${task.run_id}`);
  assert.equal(await getArtifactCount(task.task_id), 0);
  const reservation = await getReservation(reconciled.id);
  assert.equal(reservation.state, 'settled');
  assert.equal(Number(reservation.settled_cents), 80);
  assert.equal(getProviderCalls(task.run_id), 1);
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
    inputId: task.inputId,
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
        inputId: task.inputId,
      }),
    /task_deleted/,
  );
  assert.equal(await countTasks(), afterCreate);
});

test('D3-R06: cancel before the workflow starts closes the run without any operation', async () => {
  const task = await submit('d3r06', 'D3-R06 cancel before start');
  await requestCancel(task.run_id, 'user_requested');
  const first = await relayOnce();
  assert.ok(first.some((r) => r.kind === 'start_workflow' && r.outcome === 'delivered'));
  const run = await waitFor(async () => {
    const value = await getRun(task.run_id);
    return value?.state === 'canceled' ? value : null;
  });
  assert.equal(run.terminal_reason, 'user_requested');
  assert.equal((await getOperations(task.run_id)).length, 0);
  assert.equal(getProviderCalls(task.run_id), 0);
  // The cancel_signal sits behind the start on the same aggregate; it drains on a later pass.
  await waitFor(async () => {
    await relayOnce();
    const rows = await getOutboxForRun(task.run_id);
    return rows.every((r) => r.delivered_at) ? rows : null;
  });
  assert.equal((await getTask(task.task_id)).display_state, 'run_canceled');
});

test('D3-R07: cancel lands in DB between authorize and claim -> no dispatch, hold released', async () => {
  const task = await submit('d3r07', 'D3-R07 cancel before claim', 'hold_before_claim');
  await startDirect(task, 'hold_before_claim');
  const authorized = await waitFor(async () => {
    const ops = await getOperations(task.run_id);
    if (ops[0]?.state !== 'authorized') return null;
    return (await getReservation(ops[0].id))?.state === 'held' ? ops[0] : null;
  });
  // DB cancel only, no signal: the workflow must discover it through claim_dispatch -> NULL.
  await requestCancel(task.run_id, 'user_requested');
  await signalResume(task.workflowId);
  const run = await waitFor(async () => {
    const value = await getRun(task.run_id);
    return value?.state === 'canceled' ? value : null;
  });
  assert.equal(run.state, 'canceled');
  const [operation] = await getOperations(task.run_id);
  assert.equal(operation.state, 'canceled');
  assert.equal(operation.dispatch_attempt_id, null);
  assert.equal(getProviderCalls(task.run_id), 0);
  const reservation = await getReservation(authorized.id);
  assert.equal(reservation.state, 'released');
  assert.equal(Number(reservation.settled_cents), 0);
});

test('D3-R08: heartbeat timeout after dispatch -> unknown + reconciling, never not_sent', async () => {
  const task = await submit('d3r08', 'D3-R08 heartbeat stall', 'heartbeat_stall');
  await startDirect(task, 'heartbeat_stall');
  const operation = await waitFor(async () => {
    const ops = await getOperations(task.run_id);
    return ops[0]?.state === 'unknown' ? ops[0] : null;
  });
  assert.ok(operation.dispatch_attempt_id);
  assert.equal(getProviderCalls(task.run_id), 1);
  const run = await waitFor(async () => {
    const value = await getRun(task.run_id);
    return value?.state === 'waiting' ? value : null;
  });
  assert.equal(run.wait_reason, 'reconcile');
  assert.equal((await getTask(task.task_id)).display_state, 'reconciling');
  assert.equal(await getArtifactCount(task.task_id), 0);
  await reconcileNotSent(operation.id);
  await finishRunFailed(task.run_id, 'reconciled_not_sent');
});

test('D3-R09: one relay pass delivers starts for two orgs; each run stays in its own org', async () => {
  const a = await submit('d3r09a', 'D3-R09 org1');
  const b = await submit('d3r09b', 'D3-R09 org2', 'none', { org: CFG.org2, subject: CFG.subject2 });
  const results = await relayOnce();
  const orgs = new Set(results.filter((r) => r.kind === 'start_workflow').map((r) => r.orgId));
  assert.ok(orgs.has(CFG.org) && orgs.has(CFG.org2));
  for (const task of [a, b]) {
    const run = await waitFor(async () => {
      const value = await getRun(task.run_id, task.org);
      return value?.state === 'succeeded' ? value : null;
    });
    assert.equal(run.org_id, task.org);
  }
  // Cross-org reads stay empty under RLS even without an org filter in the query.
  const leaked = await withWorker(
    (db) => db.query('SELECT id FROM work.run WHERE id = $1', [b.run_id]),
    { org: CFG.org },
  );
  assert.equal(leaked.rowCount, 0);
});

import { Client, Connection } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { CFG, withWorker } from './db.mjs';

let clientPromise;

async function getClient() {
  if (!clientPromise) {
    clientPromise = Connection.connect({ address: CFG.temporalAddress }).then(
      (connection) => ({ connection, client: new Client({ connection, namespace: 'default' }) }),
    );
  }
  return clientPromise;
}

function isAlreadyStarted(error) {
  return (
    error?.name?.includes('AlreadyStarted') ||
    error?.code === 6 ||
    error?.message?.includes('already started') ||
    error?.message?.includes('AlreadyStarted') ||
    error?.message?.includes('ALREADY_EXISTS')
  );
}

export async function startWorkflowDirect({ runId, taskId, workflowId, faultMode = 'none' }) {
  const { client } = await getClient();
  return client.workflow.start('RunWorkflow', {
    taskQueue: CFG.taskQueue,
    workflowId,
    args: [{ runId, taskId, orgId: CFG.org, faultMode }],
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
}

function isNotFound(error) {
  return error?.name === 'WorkflowNotFoundError' || error?.code === 5;
}

async function deliver(client, db, row, failAfterStart) {
  const kind = row.payload?.kind;
  if (row.aggregate_type === 'task') {
    // Task events fan out to SSE from the DB event log; the outbox row only
    // records that the change was published.
    return;
  }
  const run = await db.query(
    'SELECT task_id, workflow_id FROM work.run WHERE id = $1 AND org_id = $2',
    [row.aggregate_id, row.org_id],
  );
  if (run.rowCount === 0) return;
  const { task_id: taskId, workflow_id: workflowId } = run.rows[0];
  if (kind === 'start_workflow') {
    try {
      await client.workflow.start('RunWorkflow', {
        taskQueue: CFG.taskQueue,
        workflowId,
        args: [{ runId: row.aggregate_id, taskId, orgId: row.org_id, faultMode: 'none' }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    } catch (error) {
      if (!isAlreadyStarted(error)) throw error;
    }
    if (failAfterStart) {
      throw Object.assign(new Error('simulated relay crash before ACK'), { crash: true });
    }
    return;
  }
  if (kind === 'cancel_signal') {
    try {
      await client.workflow.getHandle(workflowId).signal('cancel', row.payload.reason ?? 'user');
    } catch (error) {
      // Workflow already closed or never started: DB state already says cancel.
      if (!isNotFound(error)) throw error;
    }
    return;
  }
  throw Object.assign(new Error(`unknown outbox kind ${kind}`), { code: 'payload_invalid', permanent: true });
}

export async function relayOnce({ failAfterStart = false } = {}) {
  const { client } = await getClient();
  return withWorker(async (db) => {
    const claimed = await db.query('SELECT * FROM work.claim_outbox(20)');
    for (const row of claimed.rows) {
      try {
        await deliver(client, db, row, failAfterStart);
      } catch (error) {
        if (error.crash) throw error;
        await db.query('SELECT work.mark_outbox_failed($1, $2, $3)', [
          row.event_id,
          error.code && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : 'delivery_failed',
          !error.permanent,
        ]);
        continue;
      }
      await db.query('SELECT work.mark_outbox_delivered($1)', [row.event_id]);
    }
  });
}

export async function describeWorkflow(workflowId) {
  const { client } = await getClient();
  return client.workflow.getHandle(workflowId).describe();
}

export async function signalCancel(workflowId, reason = 'test cancel') {
  const { client } = await getClient();
  return client.workflow.getHandle(workflowId).signal('cancel', reason);
}

export async function signalResume(workflowId) {
  const { client } = await getClient();
  return client.workflow.getHandle(workflowId).signal('resume');
}

export async function closeRelay() {
  if (!clientPromise) return;
  const { connection } = await clientPromise;
  await connection.close();
  clientPromise = undefined;
}

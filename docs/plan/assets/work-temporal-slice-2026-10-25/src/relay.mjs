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

export async function relayOnce({ failAfterStart = false } = {}) {
  const { client } = await getClient();
  return withWorker(async (db) => {
    const claimed = await db.query('SELECT * FROM work.claim_outbox(20)');
    for (const row of claimed.rows) {
      if (row.payload?.kind !== 'start_workflow') continue;
      const run = await db.query(
        'SELECT task_id, workflow_id FROM work.run WHERE id = $1 AND org_id = $2',
        [row.aggregate_id, row.org_id],
      );
      if (run.rowCount === 0) {
        await db.query('SELECT work.mark_outbox_delivered($1)', [row.event_id]);
        continue;
      }
      const taskId = run.rows[0].task_id;
      const workflowId = run.rows[0].workflow_id;
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
        throw new Error('simulated relay crash before ACK');
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

export async function closeRelay() {
  if (!clientPromise) return;
  const { connection } = await clientPromise;
  await connection.close();
  clientPromise = undefined;
}

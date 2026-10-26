import { Client, Connection } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { CFG, withRelay, withWorker } from './db.mjs';

export const DEFAULT_RELAY_ID = process.env.RELAY_ID ?? 'slice-relay-a';
const TEMPORAL_CALL_DEADLINE_MS = Number(process.env.RELAY_TEMPORAL_DEADLINE_MS ?? 5000);
const ERROR_CODE = /^[a-z][a-z0-9_]{1,63}$/;

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

function isNotFound(error) {
  return error?.name === 'WorkflowNotFoundError' || error?.code === 5;
}

function classify(error) {
  if (error?.code === 4) return Object.assign(error, { relayCode: 'temporal_deadline' });
  if (error?.code === 14) return Object.assign(error, { relayCode: 'temporal_unavailable' });
  return error;
}

export async function startWorkflowDirect({ runId, taskId, workflowId, faultMode = 'none', orgId = CFG.org }) {
  const { client } = await getClient();
  return client.workflow.start('RunWorkflow', {
    taskQueue: CFG.taskQueue,
    workflowId,
    args: [{ runId, taskId, orgId, faultMode }],
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
}

async function readRun(row) {
  return withWorker(async (db) => {
    const result = await db.query(
      'SELECT task_id, workflow_id, state FROM work.run WHERE id = $1 AND org_id = $2',
      [row.aggregate_id, row.org_id],
    );
    return result.rows[0] ?? null;
  }, { org: row.org_id });
}

// Runs outside any DB transaction: no row lock is held while Temporal is called.
async function deliver(temporal, row, failAfterStart) {
  const kind = row.payload?.kind;
  if (row.aggregate_type === 'task') {
    // Task events fan out to SSE from the DB event log; the outbox row only records publication.
    return;
  }
  if (row.aggregate_type === 'content' && kind === 'content_shred') {
    // The slice has no content store; production hands content_refs to the shredder here.
    return;
  }
  if (row.aggregate_type !== 'run') {
    throw Object.assign(new Error(`unknown aggregate ${row.aggregate_type}`), {
      relayCode: 'payload_invalid',
      permanent: true,
    });
  }
  const run = await readRun(row);
  if (!run) {
    throw Object.assign(new Error('run not visible'), { relayCode: 'run_not_found', permanent: true });
  }
  const { client, connection } = temporal;
  const withDeadline = (fn) => connection.withDeadline(Date.now() + TEMPORAL_CALL_DEADLINE_MS, fn);
  if (kind === 'start_workflow') {
    try {
      await withDeadline(() =>
        client.workflow.start('RunWorkflow', {
          taskQueue: CFG.taskQueue,
          workflowId: run.workflow_id,
          args: [{ runId: row.aggregate_id, taskId: run.task_id, orgId: row.org_id, faultMode: 'none' }],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        }),
      );
    } catch (error) {
      if (!isAlreadyStarted(error)) throw classify(error);
    }
    if (failAfterStart) {
      throw Object.assign(new Error('simulated relay crash before ACK'), { crash: true });
    }
    return;
  }
  if (kind === 'cancel_signal') {
    try {
      await withDeadline(() =>
        client.workflow.getHandle(run.workflow_id).signal('cancel', row.payload.reason ?? 'user_requested'),
      );
    } catch (error) {
      if (!isNotFound(error)) throw classify(error);
      // A closed workflow is fine only if the DB already shows the run terminal; otherwise retry.
      const latest = await readRun(row);
      if (!['succeeded', 'failed', 'canceled'].includes(latest?.state)) {
        throw Object.assign(error, { relayCode: 'workflow_not_found' });
      }
    }
    return;
  }
  throw Object.assign(new Error(`unknown outbox kind ${kind}`), { relayCode: 'payload_invalid', permanent: true });
}

async function ack(sql, params) {
  try {
    const result = await withRelay((db) => db.query(sql, params));
    return result.rows[0]?.result ?? 'delivered';
  } catch (error) {
    if (error.message === 'outbox_lease_lost') return 'lease_lost';
    if (error.message === 'outbox_dead_lettered') return 'dead_letter';
    throw error;
  }
}

export async function relayOnce({
  failAfterStart = false,
  relayId = DEFAULT_RELAY_ID,
  leaseSeconds = 60,
  limit = 20,
} = {}) {
  const temporal = await getClient();
  const claimed = await withRelay((db) =>
    db.query('SELECT * FROM work.claim_outbox($1, $2, $3)', [relayId, limit, leaseSeconds]),
  );
  const rows = [...claimed.rows].sort((a, b) =>
    BigInt(a.outbox_seq) < BigInt(b.outbox_seq) ? -1 : 1,
  );
  const results = [];
  for (const row of rows) {
    let outcome;
    try {
      await deliver(temporal, row, failAfterStart);
      outcome = await ack('SELECT work.mark_outbox_delivered($1, $2)', [row.event_id, relayId]);
    } catch (error) {
      if (error.crash) throw error;
      const code = error.relayCode && ERROR_CODE.test(error.relayCode) ? error.relayCode : 'delivery_failed';
      outcome = await ack('SELECT work.mark_outbox_failed($1, $2, $3, $4) AS result', [
        row.event_id,
        relayId,
        code,
        !error.permanent,
      ]);
    }
    results.push({ eventId: row.event_id, orgId: row.org_id, kind: row.payload?.kind, outcome });
  }
  return results;
}

export async function describeWorkflow(workflowId) {
  const { client } = await getClient();
  return client.workflow.getHandle(workflowId).describe();
}

export async function signalCancel(workflowId, reason = 'user_requested') {
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

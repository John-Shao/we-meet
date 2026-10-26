import { createHash, randomUUID } from 'node:crypto';
import { CFG, withAdmin, withApi, withWorker } from './db.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function assertOutboxHealthy(org) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS count, min(created_at) AS oldest
       FROM work.outbox
       WHERE org_id = $1
         AND aggregate_type = 'run'
         AND payload->>'kind' = 'start_workflow'
         AND delivered_at IS NULL`,
      [org],
    );
    const count = result.rows[0].count;
    const oldest = result.rows[0].oldest;
    const ageMs = oldest ? Date.now() - new Date(oldest).getTime() : 0;
    if (count > CFG.outboxMaxCount || ageMs > CFG.outboxMaxAgeMs) {
      const error = new Error('outbox_backlog');
      error.code = 'outbox_backlog';
      error.status = 503;
      throw error;
    }
  });
}

export async function setOrgExecution({ executionEnabled, operatorSuspended }) {
  return withAdmin(async (client) => {
    await client.query(
      'UPDATE work.org SET execution_enabled = $2, operator_suspended = $3 WHERE id = $1',
      [CFG.org, executionEnabled, operatorSuspended],
    );
  });
}

export async function submitTask({
  clientRequestId,
  goal,
  faultMode = 'none',
  workflowId = `run:${randomUUID()}`,
  org = CFG.org,
  subject = CFG.subject,
  inputId = null,
}) {
  await assertOutboxHealthy(org);
  const contentRef = `content://temporal/${randomUUID()}`;
  const inputHash = `sha256:${sha256(`${goal}:${clientRequestId}`)}`;
  return withApi(async (client) => {
    // A client retry reuses its uploaded input; only a first attempt creates one.
    const boundInput =
      inputId ??
      (
        await client.query('SELECT work.create_input($1, $2, $3, $4, $5, $6) AS id', [
          org, subject, contentRef, inputHash, 256, 'application/json',
        ])
      ).rows[0].id;
    const result = await client.query(
      `SELECT task_id, run_id, revision
       FROM work.submit_task($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        org,
        subject,
        clientRequestId,
        boundInput,
        goal.slice(0, 20),
        'ask_each',
        `sha256:snap-${sha256(`${org}:${clientRequestId}:${faultMode}`)}`,
        JSON.stringify({ fault_mode: faultMode, source: 'temporal-slice' }),
        ['model_call'],
        JSON.stringify({ provider: 'faux', model: 'faux-text-v1' }),
        'price-v1',
        workflowId,
        'slice-pi-1.4.0',
      ],
    );
    return { ...result.rows[0], workflowId, org, inputId: boundInput };
  }, { org, subject });
}

export async function requestCancel(runId, reason = 'user_requested', { org = CFG.org, subject = CFG.subject } = {}) {
  return withApi(async (client) => {
    await client.query('SELECT work.request_cancel($1, $2, $3, $4)', [org, runId, subject, reason]);
  }, { org, subject });
}

export async function getTask(taskId) {
  return withApi(async (client) => {
    const result = await client.query(
      'SELECT * FROM work.task_summary WHERE task_id = $1',
      [taskId],
    );
    return result.rows[0] ?? null;
  });
}

export async function getRun(runId, org = CFG.org) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT * FROM work.run WHERE id = $1 AND org_id = $2',
      [runId, org],
    );
    return result.rows[0] ?? null;
  }, { org });
}

export async function getOperations(runId) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT * FROM work.operation WHERE run_id = $1 AND org_id = $2 ORDER BY created_at',
      [runId, CFG.org],
    );
    return result.rows;
  });
}

export async function getBudget() {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.budget_account
       WHERE org_id = $1 AND account_key = $2 AND period_id = $3`,
      [CFG.org, CFG.accountKey, CFG.period],
    );
    return result.rows[0] ?? null;
  });
}

export async function getArtifactCount(taskId) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS count
       FROM work.artifact_version av
       JOIN work.artifact a ON a.id = av.artifact_id AND a.org_id = av.org_id
       WHERE a.task_id = $1 AND a.org_id = $2`,
      [taskId, CFG.org],
    );
    return result.rows[0].count;
  });
}

export async function getArtifactLogicalNames(taskId) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT DISTINCT a.logical_name
       FROM work.artifact a
       JOIN work.artifact_version av
         ON av.artifact_id = a.id AND av.org_id = a.org_id
       WHERE a.task_id = $1 AND a.org_id = $2
       ORDER BY a.logical_name`,
      [taskId, CFG.org],
    );
    return result.rows.map((row) => row.logical_name);
  });
}

export async function getOutboxStart(runId) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.outbox
       WHERE org_id = $1 AND aggregate_type = 'run' AND aggregate_id = $2
         AND payload->>'kind' = 'start_workflow'
       ORDER BY created_at DESC
       LIMIT 1`,
      [CFG.org, runId],
    );
    return result.rows[0] ?? null;
  });
}

export async function getAuditCount(runId) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS count FROM work.audit_event
       WHERE org_id = $1 AND target_id = $2`,
      [CFG.org, runId],
    );
    return result.rows[0].count;
  });
}

export async function getRunCountForTask(taskId) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT count(*)::int AS count FROM work.run WHERE task_id = $1 AND org_id = $2',
      [taskId, CFG.org],
    );
    return result.rows[0].count;
  });
}

export async function reconcileNotSent(operationId) {
  return withWorker(async (client) => {
    await client.query(
      `SELECT work.reconcile_operation($1, $2, 'not_sent', NULL, 0, 'price-v1', $3)`,
      [CFG.org, operationId, `evidence://not-sent/${operationId}`],
    );
  });
}

export async function reconcileSentSucceeded(operationId, billableCents, evidenceRef) {
  return withWorker(async (client) => {
    await client.query(
      `SELECT work.reconcile_operation($1, $2, 'sent_succeeded', NULL, $3, 'price-v1', $4)`,
      [CFG.org, operationId, billableCents, evidenceRef],
    );
  });
}

export async function getReservation(operationId, org = CFG.org) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.budget_reservation
       WHERE operation_id = $1 AND org_id = $2
       ORDER BY reservation_seq DESC LIMIT 1`,
      [operationId, org],
    );
    return result.rows[0] ?? null;
  }, { org });
}

export async function getOutboxForRun(runId, org = CFG.org) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.outbox
       WHERE org_id = $1 AND aggregate_type = 'run' AND aggregate_id = $2
       ORDER BY outbox_seq`,
      [org, runId],
    );
    return result.rows;
  }, { org });
}

export async function finishRunFailed(runId, reason = 'reconcile_closed') {
  return withWorker(async (client) => {
    await client.query('SELECT work.finish_run($1, $2, $3, $4)', [
      runId,
      CFG.org,
      'failed',
      reason,
    ]);
  });
}

export async function markDedupDeleted(clientRequestId) {
  return withAdmin(async (client) => {
    const result = await client.query(
      `UPDATE work.submission_dedup
       SET task_deleted = true
       WHERE org_id = $1 AND subject_id = $2 AND operation_type = 'task.submit'
         AND client_request_id = $3`,
      [CFG.org, CFG.subject, clientRequestId],
    );
    return result.rowCount;
  });
}

export async function countTasks() {
  return withAdmin(async (client) => {
    const result = await client.query(
      'SELECT count(*)::int AS count FROM work.task WHERE org_id = $1',
      [CFG.org],
    );
    return result.rows[0].count;
  });
}

export async function getDedup(clientRequestId) {
  return withAdmin(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.submission_dedup
       WHERE org_id = $1 AND subject_id = $2 AND operation_type = 'task.submit'
         AND client_request_id = $3`,
      [CFG.org, CFG.subject, clientRequestId],
    );
    return result.rows[0] ?? null;
  });
}

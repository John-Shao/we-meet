import { createHash } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { CFG, withWorker } from './db.mjs';

const providerCalls = new Map();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonRetryable(message, type) {
  return ApplicationFailure.create({ message, type, nonRetryable: true });
}

export function getProviderCalls(runId) {
  return providerCalls.get(runId) ?? 0;
}

export function resetProviderCalls() {
  providerCalls.clear();
}

export async function prepareRun(input) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT t.id AS task_id, t.state AS task_state, t.snapshot_id,
              s.manifest, s.price_version
       FROM work.task t
       JOIN work.capability_snapshot s
         ON s.id = t.snapshot_id AND s.org_id = t.org_id AND s.task_id = t.id
       WHERE t.id = $1 AND t.org_id = $2`,
      [input.taskId, input.orgId],
    );
    if (result.rowCount === 0) {
      throw nonRetryable('task/snapshot not found', 'TaskNotFound');
    }
    const row = result.rows[0];
    return {
      runId: input.runId,
      taskId: input.taskId,
      orgId: input.orgId,
      snapshotId: row.snapshot_id,
      priceVersion: row.price_version,
      faultMode: input.faultMode ?? 'none',
    };
  });
}

export async function acquireRun(runId, orgId) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT state, fence FROM work.acquire_run($1, $2)',
      [runId, orgId],
    );
    return result.rows[0];
  });
}

export async function createModelOperation(runId, orgId, logicalKey, requestHash) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT work.create_operation($1, $2, $3, $4, $5) AS operation_id',
      [runId, orgId, logicalKey, 'model', requestHash],
    );
    return { operationId: result.rows[0].operation_id };
  });
}

export async function authorizeOperation(operationId, orgId, policyEpoch) {
  return withWorker(async (client) => {
    await client.query('SELECT work.authorize_operation($1, $2, $3, $4)', [
      orgId,
      operationId,
      policyEpoch,
      'policy_auto',
    ]);
  });
}

export async function reserveBudget(orgId, operationId) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT work.reserve_budget($1, $2, $3, $4, $5) AS reservation_id',
      [orgId, CFG.accountKey, CFG.period, operationId, 100],
    );
    return { reservationId: result.rows[0].reservation_id };
  });
}

export async function claimDispatch(operationId, orgId, fence) {
  return withWorker(async (client) => {
    const result = await client.query(
      'SELECT work.claim_dispatch($1, $2, $3, $4) AS dispatch_attempt_id',
      [operationId, orgId, 'slice-worker', fence],
    );
    return result.rows[0].dispatch_attempt_id;
  });
}

export async function invokeModel(request) {
  const mode = request.faultMode ?? 'none';
  if (mode === 'claim_crash') {
    throw nonRetryable('simulated worker crash after claim', 'SimulatedCrash');
  }
  providerCalls.set(request.runId, getProviderCalls(request.runId) + 1);
  if (mode === 'provider_unknown') {
    await sleep(100);
    throw nonRetryable('provider accepted but no receipt', 'ProviderUnknownError');
  }
  if (mode === 'late_after_cancel') {
    await sleep(1500);
  } else {
    await sleep(50);
  }
  const content = `# Temporal R0a artifact\n\nRun: ${request.runId}\n`;
  const contentHash = `sha256:${sha256(content)}`;
  return {
    contentRef: `content://temporal/${contentHash.slice(7, 23)}`,
    contentHash,
    bytes: Buffer.byteLength(content, 'utf8'),
    mediaType: 'text/markdown',
    providerRequestId: `provider-${request.runId}`,
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: 'stop',
  };
}

export async function finishOperation(orgId, operationId, outcome, providerRequestId, receiptRef) {
  return withWorker(async (client) => {
    await client.query('SELECT work.finish_operation($1, $2, $3, $4, $5)', [
      orgId,
      operationId,
      outcome,
      providerRequestId,
      receiptRef,
    ]);
  });
}

export async function settleBudget(reservationId, amountCents, priceVersion, usage, settlementRevision) {
  return withWorker(async (client) => {
    await client.query('SELECT work.settle_budget($1, $2, $3, $4, $5)', [
      reservationId,
      amountCents,
      priceVersion,
      usage,
      settlementRevision,
    ]);
  });
}

export async function publishArtifact(
  orgId,
  taskId,
  runId,
  logicalName,
  contentRef,
  contentHash,
  bytes,
  mediaType,
  provenance,
) {
  return withWorker(async (client) => {
    const result = await client.query(
      `SELECT artifact_id, version_no
       FROM work.publish_artifact($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, taskId, runId, logicalName, contentRef, contentHash, bytes, mediaType, provenance],
    );
    return result.rows[0];
  });
}

export async function finishRun(request) {
  return withWorker(async (client) => {
    await client.query('SELECT work.finish_run($1, $2, $3, $4)', [
      request.runId,
      request.orgId,
      request.outcome,
      request.reason,
    ]);
  });
}

export async function markOperationUnknown(operationId, orgId, reason) {
  return withWorker(async (client) => {
    await client.query('SELECT work.mark_operation_unknown($1, $2, $3)', [
      orgId,
      operationId,
      reason,
    ]);
  });
}

export async function cancelOperation(operationId, orgId, actorSubjectId, reason) {
  return withWorker(async (client) => {
    await client.query('SELECT work.cancel_operation($1, $2, $3, $4)', [
      orgId,
      operationId,
      actorSubjectId,
      reason,
    ]);
  });
}

export async function waitRun(runId, orgId, reason) {
  return withWorker(async (client) => {
    await client.query('SELECT work.wait_run($1, $2, $3)', [orgId, runId, reason]);
  });
}

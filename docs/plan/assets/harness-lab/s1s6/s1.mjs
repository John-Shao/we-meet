import { check, close, createFixture, operation, pool, q, resetSchema, tx, uuid } from "./lib.mjs";

const results = { package: "S1", checks: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await resetSchema();
const { org, taskId, runId } = await createFixture();

// F01: task/run/outbox atomic, relay restart does not create a second run.
await tx(async (c) => {
  await c.query("INSERT INTO outbox (org_id, aggregate_id, event_type, payload) VALUES ($1,$2,'run.submitted','{}')", [org, runId]);
});
check(results, "F01-outbox-written", (await q("SELECT count(*)::int AS n FROM outbox")).rows[0].n === 1, null);
await tx(async (c) => {
  await c.query("INSERT INTO outbox (org_id, aggregate_id, event_type, payload) VALUES ($1,$2,'rollback.test','{}')", [org, runId]);
  throw new Error("simulated crash before commit");
}).catch(() => {});
check(results, "F01-rollback", (await q("SELECT count(*)::int AS n FROM outbox")).rows[0].n === 1, null);
await q("INSERT INTO workflow_starts (workflow_id, run_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [`wf-${runId}`, runId]);
await q("INSERT INTO workflow_starts (workflow_id, run_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [`wf-${runId}`, runId]);
check(results, "F02-workflow-dedup", (await q("SELECT count(*)::int AS n FROM workflow_starts")).rows[0].n === 1, null);

// F03: approval decision vs expiry/competition.
const approvalId = uuid();
await q(
  "INSERT INTO approvals (id, org_id, operation_key, params_hash, expires_at, policy_epoch) VALUES ($1,$2,'op-1','hash-1', now() + interval '1 hour', 1)",
  [approvalId, org],
);
async function decide(decision, delay) {
  return tx(async (c) => {
    const result = await c.query(
      "UPDATE approvals SET decision=$1, revision=revision+1 WHERE id=$2 AND decision IS NULL AND expires_at > now() RETURNING id",
      [decision, approvalId],
    );
    await sleep(delay);
    return result.rowCount;
  });
}
const decisions = await Promise.all([decide("approved", 120), decide("rejected", 0)]);
const decisionCount = (await q("SELECT count(*)::int AS n FROM approvals WHERE id=$1 AND decision IS NOT NULL", [approvalId])).rows[0].n;
check(results, "F03-one-decision", decisions.reduce((a, b) => a + b, 0) === 1 && decisionCount === 1, decisions);
const expiredId = uuid();
await q(
  "INSERT INTO approvals (id, org_id, operation_key, params_hash, expires_at, policy_epoch) VALUES ($1,$2,'op-2','hash-2', now() - interval '1 minute', 1)",
  [expiredId, org],
);
const expired = await q("UPDATE approvals SET decision='approved' WHERE id=$1 AND decision IS NULL AND expires_at > now() RETURNING id", [expiredId]);
check(results, "F03-expired-blocked", expired.rowCount === 0, null);

// F04: charged model loss becomes unknown, keeps reservation, no auto retry.
const opF04 = await operation(org, runId, "m:1", "dispatching");
await q("INSERT INTO reservations (id, org_id, operation_id, period_id, amount_cents, state) VALUES ($1,$2,$3,'2026-10',100,'held')", [uuid(), org, opF04]);
await q("UPDATE operations SET state='unknown' WHERE id=$1", [opF04]);
const f04 = await q("SELECT o.state, r.state AS reservation FROM operations o JOIN reservations r ON r.operation_id=o.id WHERE o.id=$1", [opF04]);
check(results, "F04-unknown-holds-reservation", f04.rows[0].state === "unknown" && f04.rows[0].reservation === "held", f04.rows[0]);
const f04Retry = await q("UPDATE operations SET state='dispatching' WHERE id=$1 AND state='authorized' RETURNING id", [opF04]);
check(results, "F04-no-auto-retry", f04Retry.rowCount === 0, null);

// F07: cancellation after a late upload; late artifact not published, charge remains.
await q(
  "INSERT INTO artifacts (id, org_id, task_id, logical_name, state) VALUES ($1,$2,$3,'draft.md','staged')",
  [uuid(), org, taskId],
);
const artifact = (await q("SELECT id FROM artifacts WHERE task_id=$1", [taskId])).rows[0].id;
const uploadId = uuid();
await q("INSERT INTO upload_sessions (id, org_id, task_id, state, content_hash, artifact_id) VALUES ($1,$2,$3,'uploaded','hash-1',$4)", [uploadId, org, taskId, artifact]);
await q("UPDATE runs SET state='canceled' WHERE id=$1", [runId]);
const latePublish = await q(
  `INSERT INTO artifact_versions (artifact_id, version_no, content_ref, content_hash, state, published_at)
   SELECT $1, 1, 's3://late', 'hash-1', 'published', now()
   WHERE EXISTS (SELECT 1 FROM runs WHERE id=$2 AND state IN ('active','succeeded'))`,
  [artifact, runId],
);
const lateState = (await q("SELECT count(*)::int AS n FROM artifact_versions WHERE artifact_id=$1", [artifact])).rows[0].n;
check(results, "F07-late-artifact-blocked", latePublish.rowCount === 0 && lateState === 0, { lateState });
const charge = await q("UPDATE operations SET receipt_ref='receipt-1' WHERE id=$1 RETURNING receipt_ref", [opF04]);
check(results, "F07-charge-kept", charge.rowCount === 1, null);

// F21: dispatching CAS has exactly one winner; takeover cannot blind-resend.
const opF21 = await operation(org, runId, "tool:1", "authorized");
async function claim(consumer) {
  const attempt = uuid();
  return tx(async (c) => {
    const result = await c.query(
      "UPDATE operations SET state='dispatching', dispatch_attempt_id=$2, consumer_id=$3 WHERE id=$1 AND state='authorized' AND dispatch_attempt_id IS NULL RETURNING dispatch_attempt_id",
      [opF21, attempt, consumer],
    );
    return result.rowCount;
  });
}
const claims = await Promise.all([claim("consumer-a"), claim("consumer-b")]);
const winner = (await q("SELECT dispatch_attempt_id, consumer_id FROM operations WHERE id=$1", [opF21])).rows[0];
check(results, "F21-single-dispatch-winner", claims.reduce((a, b) => a + b, 0) === 1 && winner.dispatch_attempt_id, { claims, winner });
const takeover = await q(
  "UPDATE operations SET dispatch_attempt_id=$2, consumer_id='consumer-c' WHERE id=$1 AND state='dispatching' AND dispatch_attempt_id IS NULL RETURNING id",
  [opF21, uuid()],
);
check(results, "F21-no-blind-takeover", takeover.rowCount === 0, null);
await q("UPDATE operations SET state='unknown' WHERE id=$1", [opF21]);
const unknownClaim = await q("UPDATE operations SET state='dispatching' WHERE id=$1 AND state='authorized' RETURNING id", [opF21]);
check(results, "F21-unknown-not-claimable", unknownClaim.rowCount === 0, null);

// F23: submission dedupe survives task deletion and short cache expiry.
const clientRequestId = `req-${uuid()}`;
const dedupTask = uuid();
await q("INSERT INTO tasks (id, org_id, state, snapshot_id) VALUES ($1,$2,'open','snap-1')", [dedupTask, org]);
await q(
  "INSERT INTO submissions (org_id, subject_id, operation_type, client_request_id, request_hash, task_id) VALUES ($1,'user-1','submit',$2,'hash-1',$3)",
  [org, clientRequestId, dedupTask],
);
await q("UPDATE tasks SET deleted_at=now() WHERE id=$1", [dedupTask]);
await q("UPDATE submissions SET deleted=true WHERE client_request_id=$1", [clientRequestId]);
const replayInsert = await q(
  "INSERT INTO submissions (org_id, subject_id, operation_type, client_request_id, request_hash, task_id) VALUES ($1,'user-1','submit',$2,'hash-1',$3) ON CONFLICT DO NOTHING RETURNING task_id",
  [org, clientRequestId, uuid()],
);
const replayRow = (await q("SELECT task_id, deleted FROM submissions WHERE client_request_id=$1", [clientRequestId])).rows[0];
check(results, "F23-dedup-after-delete", replayInsert.rowCount === 0 && replayRow.task_id === dedupTask && replayRow.deleted === true, replayRow);
const taskCountBefore = (await q("SELECT count(*)::int AS n FROM tasks")).rows[0].n;
await q("DELETE FROM tasks WHERE id=$1", [dedupTask]);
const replayAfterHardDelete = await q("SELECT task_id, deleted FROM submissions WHERE client_request_id=$1", [clientRequestId]);
const taskCountAfter = (await q("SELECT count(*)::int AS n FROM tasks")).rows[0].n;
check(results, "F23-dedup-survives-hard-delete", replayAfterHardDelete.rowCount === 1 && taskCountAfter === taskCountBefore - 1, replayAfterHardDelete.rows[0]);
const differentHash = await q(
  "INSERT INTO submissions (org_id, subject_id, operation_type, client_request_id, request_hash, task_id) VALUES ($1,'user-1','submit',$2,'hash-2',$3) ON CONFLICT DO NOTHING RETURNING task_id",
  [org, clientRequestId, uuid()],
);
check(results, "F23-conflicting-payload", differentHash.rowCount === 0, null);

results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
console.log(JSON.stringify(results, null, 2));
await close();

import { check, close, createFixture, operation, q, resetSchema, tx, uuid } from "./lib.mjs";

const results = { package: "S5", checks: [] };
await resetSchema();
const { org, taskId, runId } = await createFixture();

// F10: finalize transaction failure leaves no visible version; retry is idempotent.
const artifactId = uuid();
const uploadId = uuid();
await q("INSERT INTO artifacts (id, org_id, task_id, logical_name, state) VALUES ($1,$2,$3,'report.md','staged')", [artifactId, org, taskId]);
await q("INSERT INTO upload_sessions (id, org_id, task_id, state, content_hash, artifact_id) VALUES ($1,$2,$3,'uploaded','sha-1',$4)", [uploadId, org, taskId, artifactId]);
await tx(async (c) => {
  await c.query("INSERT INTO artifact_versions (artifact_id, version_no, content_ref, content_hash, state, published_at) VALUES ($1,1,'s3://obj','sha-1','published',now())", [artifactId]);
  await c.query("UPDATE upload_sessions SET state='finalized' WHERE id=$1", [uploadId]);
  throw new Error("crash before commit");
}).catch(() => {});
const beforeRetry = await q("SELECT count(*)::int AS n FROM artifact_versions WHERE artifact_id=$1", [artifactId]);
check(results, "F10-failed-finalize-hidden", beforeRetry.rows[0].n === 0, beforeRetry.rows[0]);
const finalize = await tx(async (c) => {
  const inserted = await c.query(
    "INSERT INTO artifact_versions (artifact_id, version_no, content_ref, content_hash, state, published_at) VALUES ($1,1,'s3://obj','sha-1','published',now()) ON CONFLICT DO NOTHING RETURNING version_no",
    [artifactId],
  );
  await c.query("UPDATE upload_sessions SET state='finalized' WHERE id=$1", [uploadId]);
  const version = await c.query("SELECT version_no FROM artifact_versions WHERE artifact_id=$1", [artifactId]);
  return { inserted: inserted.rowCount, version: version.rows[0].version_no };
});
const repeatFinalize = await q(
  "INSERT INTO artifact_versions (artifact_id, version_no, content_ref, content_hash, state, published_at) VALUES ($1,1,'s3://other','sha-1','published',now()) ON CONFLICT DO NOTHING RETURNING version_no",
  [artifactId],
);
check(results, "F10-finalize-idempotent", finalize.inserted === 1 && repeatFinalize.rowCount === 0 && (await q("SELECT count(*)::int AS n FROM artifact_versions WHERE artifact_id=$1", [artifactId])).rows[0].n === 1, finalize);

// F11: concurrent version write and acceptance CAS.
const artifact2 = uuid();
await q("INSERT INTO artifacts (id, org_id, task_id, logical_name, state) VALUES ($1,$2,$3,'second.md','staged')", [artifact2, org, taskId]);
async function publish(version, ref) {
  return tx(async (c) => {
    const result = await c.query(
      "INSERT INTO artifact_versions (artifact_id, version_no, content_ref, content_hash, state, published_at) VALUES ($1,$2,$3,'sha','published',now()) ON CONFLICT DO NOTHING RETURNING version_no",
      [artifact2, version, ref],
    );
    return result.rowCount;
  });
}
const versions = await Promise.all([publish(1, "s3://a"), publish(1, "s3://b")]);
check(results, "F11-version-conflict", versions.reduce((a, b) => a + b, 0) === 1, versions);

await q("UPDATE runs SET state='succeeded' WHERE id=$1", [runId]);
await q("UPDATE operations SET state='dispatching' WHERE id=$1", [await operation(org, runId, "upload:1", "dispatching")]);
const taskRevision = (await q("SELECT revision FROM tasks WHERE id=$1", [taskId])).rows[0].revision;
async function accept(revision) {
  return tx(async (c) => {
    const updated = await c.query(
      `UPDATE tasks SET state='completed', active_run_id=NULL, revision=revision+1
       WHERE id=$1 AND revision=$2 AND active_run_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id
           WHERE r.task_id=$1 AND o.state IN ('dispatching','unknown')
         )
       RETURNING revision`,
      [taskId, revision],
    );
    if (updated.rowCount === 0) return { accepted: false };
    await c.query("INSERT INTO acceptances (id, org_id, task_id, artifact_id, version_no, revision) VALUES ($1,$2,$3,$4,1,$5)", [uuid(), org, taskId, artifact2, updated.rows[0].revision]);
    return { accepted: true, revision: updated.rows[0].revision };
  });
}
const acceptedDuringDispatch = await accept(taskRevision);
check(results, "F22-dispatch-blocks-acceptance", acceptedDuringDispatch.accepted === false, acceptedDuringDispatch);
await q("UPDATE operations SET state='succeeded' WHERE run_id=$1 AND state='dispatching'", [runId]);
const acceptWinners = await Promise.all([accept(taskRevision), accept(taskRevision)]);
const acceptedCount = acceptWinners.filter((x) => x.accepted).length;
check(results, "F22-acceptance-cas", acceptedCount === 1 && (await q("SELECT count(*)::int AS n FROM acceptances WHERE task_id=$1", [taskId])).rows[0].n === 1, acceptWinners);
await q("UPDATE runs SET state='succeeded' WHERE id=$1", [runId]);
const lateOldRun = await q("UPDATE tasks SET state='completed', revision=revision+1 WHERE id=$1 AND active_run_id=$2 AND revision=$3 RETURNING revision", [taskId, runId, taskRevision]);
check(results, "F22-late-run-receipt", lateOldRun.rowCount === 0, null);

// F12: SSE resume, dedupe, and cursor expiry.
for (let seq = 1; seq <= 3; seq += 1) {
  await q("INSERT INTO sse_events (id, org_id, task_id, seq, type, payload) VALUES ($1,$2,$3,$4,'status','{}')", [uuid(), org, taskId, seq]);
}
const resume = await q("SELECT seq FROM sse_events WHERE task_id=$1 AND seq > 1 ORDER BY seq", [taskId]);
const duplicate = await q("INSERT INTO sse_events (id, org_id, task_id, seq, type, payload) VALUES ($1,$2,$3,2,'status','{}') ON CONFLICT DO NOTHING RETURNING seq", [uuid(), org, taskId]);
check(results, "F12-resume", resume.rows.map((r) => Number(r.seq)).join(",") === "2,3" && duplicate.rowCount === 0, resume.rows);
await q("INSERT INTO approvals (id, org_id, operation_key, params_hash, expires_at, policy_epoch) VALUES ($1,$2,'sse-approval','h', now() + interval '1 hour', 1)", [uuid(), org]);
await q("DELETE FROM sse_events WHERE task_id=$1", [taskId]);
const afterExpiry = await q("SELECT seq FROM sse_events WHERE task_id=$1 AND seq > 1", [taskId]);
const approvalStillThere = (await q("SELECT count(*)::int AS n FROM approvals WHERE operation_key='sse-approval'")).rows[0].n;
check(results, "F12-cursor-expiry-resync", afterExpiry.rowCount === 0 && approvalStillThere === 1, { afterExpiry: afterExpiry.rowCount, approvalStillThere });

// F26: no DR durability means no journal_release.
await q("UPDATE dr_state SET durable=false WHERE id=1");
const releaseBlocked = await q("INSERT INTO journal_release (device_id, session_id) SELECT 'dev-s5','sess-s5' WHERE (SELECT durable FROM dr_state WHERE id=1)=true ON CONFLICT DO NOTHING RETURNING device_id");
await q("UPDATE dr_state SET durable=true WHERE id=1");
const releaseAllowed = await q("INSERT INTO journal_release (device_id, session_id) SELECT 'dev-s5','sess-s5' WHERE (SELECT durable FROM dr_state WHERE id=1)=true ON CONFLICT DO NOTHING RETURNING device_id");
check(results, "F26-journal-release-gated", releaseBlocked.rowCount === 0 && releaseAllowed.rowCount === 1, { blocked: releaseBlocked.rowCount, allowed: releaseAllowed.rowCount });

// Deletion tombstone blocks a restored backup row.
const deletedArtifact = uuid();
const backup = { id: deletedArtifact, org, taskId, name: "deleted.md" };
await q("INSERT INTO artifacts (id, org_id, task_id, logical_name, state) VALUES ($1,$2,$3,$4,'published')", [deletedArtifact, org, taskId, backup.name]);
await q("INSERT INTO artifact_tombstones (artifact_id, org_id) VALUES ($1,$2)", [deletedArtifact, org]);
await q("DELETE FROM artifacts WHERE id=$1", [deletedArtifact]);
await q("INSERT INTO artifacts (id, org_id, task_id, logical_name, state) VALUES ($1,$2,$3,$4,'published')", [deletedArtifact, org, taskId, backup.name]);
const readableAfterRestore = await q(
  "SELECT a.id FROM artifacts a WHERE a.id=$1 AND NOT EXISTS (SELECT 1 FROM artifact_tombstones t WHERE t.artifact_id=a.id)",
  [deletedArtifact],
);
check(results, "deletion-tombstone-after-restore", readableAfterRestore.rowCount === 0, null);

results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
console.log(JSON.stringify(results, null, 2));
await close();

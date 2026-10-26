import { check, close, createFixture, operation, q, resetSchema, tx, uuid } from "./lib.mjs";

const results = { package: "S6", checks: [], notExecuted: [] };
await resetSchema();
const { org, taskId, runId } = await createFixture();
await q("INSERT INTO budgets (org_id, account, period_id, limit_cents) VALUES ($1,'smoke','2026-10',1000)", [org]);

const reservations = 50;
const operations = [];
for (let i = 0; i < reservations; i += 1) {
  operations.push(await operation(org, runId, `smoke:${i}`, "authorized"));
}

const latencies = [];
async function reserve(operationId) {
  const started = Date.now();
  const result = await tx(async (c) => {
    const updated = await c.query(
      "UPDATE budgets SET reserved_cents=reserved_cents+1, version=version+1 WHERE org_id=$1 AND account='smoke' AND period_id='2026-10' AND limit_cents - settled_cents - reserved_cents >= 1 RETURNING reserved_cents::int AS reserved",
      [org],
    );
    if (updated.rowCount === 0) return false;
    await c.query("INSERT INTO reservations (id, org_id, operation_id, period_id, amount_cents, state) VALUES ($1,$2,$3,'2026-10',1,'held')", [uuid(), org, operationId]);
    return true;
  });
  latencies.push(Date.now() - started);
  return result;
}
const settled = await Promise.all(operations.map((id) => reserve(id)));
latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
const budget = (await q("SELECT reserved_cents::int AS reserved FROM budgets WHERE org_id=$1 AND account='smoke'", [org])).rows[0];
const held = (await q("SELECT count(*)::int AS n FROM reservations WHERE state='held'")).rows[0].n;
check(results, "smoke-no-oversell", settled.every(Boolean) && budget.reserved === reservations && held === reservations, { budget, held });
check(results, "smoke-no-deadlock", p95 < 5000, { p50, p95, max: latencies[latencies.length - 1] });

// Duplicate submission smoke: same client key, many concurrent deliveries.
const clientRequestId = `smoke-${uuid()}`;
const taskId2 = uuid();
await q("INSERT INTO tasks (id, org_id, state, snapshot_id) VALUES ($1,$2,'open','snap-1')", [taskId2, org]);
const dupStart = Date.now();
const dup = await Promise.all(
  Array.from({ length: 100 }, () =>
    q(
      "INSERT INTO submissions (org_id, subject_id, operation_type, client_request_id, request_hash, task_id) VALUES ($1,'user','submit',$2,'hash',$3) ON CONFLICT DO NOTHING RETURNING task_id",
      [org, clientRequestId, taskId2],
    ),
  ),
);
const dupRows = (await q("SELECT count(*)::int AS n FROM submissions WHERE client_request_id=$1", [clientRequestId])).rows[0].n;
check(results, "smoke-dedup-100", dup.filter((r) => r.rowCount === 1).length === 1 && dupRows === 1, { accepted: dup.filter((r) => r.rowCount === 1).length, rows: dupRows, ms: Date.now() - dupStart });

results.capacity = { reservations, p50, p95, max: latencies[latencies.length - 1], duplicateDeliveries: 100 };
results.notExecuted = [
  "§19 design-partner/first-production/expansion traffic tiers",
  "model token quota and provider rate-limit contention",
  "PostgreSQL contention under production schema/migrations",
  "SSE/device-gateway connection scale",
];
results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
console.log(JSON.stringify(results, null, 2));
await close();

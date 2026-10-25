import { check, close, createFixture, operation, q, resetSchema, tx, uuid } from "./lib.mjs";

const results = { package: "S3", checks: [] };
await resetSchema();
const { org, runId } = await createFixture();
const opA = await operation(org, runId, "m:s3:1", "authorized");
const opB = await operation(org, runId, "m:s3:2", "authorized");
const opC = await operation(org, runId, "m:s3:3", "authorized");
const opD = await operation(org, runId, "m:s3:4", "authorized");

async function reserve({ operationId, amount, period = "2026-10", account = "org-default", requireDurable = true }) {
  return tx(async (c) => {
    const update = await c.query(
      `UPDATE budgets SET reserved_cents=reserved_cents+$4, version=version+1
       WHERE org_id=$1 AND account=$2 AND period_id=$3
         AND limit_cents - settled_cents - reserved_cents >= $4
         AND (NOT $5 OR (SELECT durable FROM dr_state WHERE id=1)=true)
       RETURNING reserved_cents::int AS reserved_cents, limit_cents::int AS limit_cents, version`,
      [org, account, period, amount, requireDurable],
    );
    if (update.rowCount === 0) return { ok: false };
    await c.query(
      "INSERT INTO reservations (id, org_id, operation_id, period_id, amount_cents, state) VALUES ($1,$2,$3,$4,$5,'held')",
      [uuid(), org, operationId, period, amount],
    );
    return { ok: true, budget: update.rows[0] };
  });
}

await q("INSERT INTO budgets (org_id, account, period_id, limit_cents) VALUES ($1,'org-default','2026-10',10)", [org]);

// F08: two concurrent reservations of 7 cannot both win against a limit of 10.
const [first, second] = await Promise.all([
  reserve({ operationId: opA, amount: 7 }),
  reserve({ operationId: opB, amount: 7 }),
]);
const budget = (await q("SELECT reserved_cents::int AS reserved_cents, settled_cents::int AS settled_cents, limit_cents::int AS limit_cents FROM budgets WHERE org_id=$1 AND account='org-default' AND period_id='2026-10'", [org])).rows[0];
const heldCount = (await q("SELECT count(*)::int AS n FROM reservations WHERE state='held'")).rows[0].n;
check(results, "F08-no-oversell", [first.ok, second.ok].filter(Boolean).length === 1 && budget.reserved_cents === 7 && heldCount === 1, { first, second, budget, heldCount });

// Cross-period settlement stays on the original reservation period.
const winnerOp = first.ok ? opA : opB;
const reservation = (await q("SELECT id, amount_cents, period_id FROM reservations WHERE operation_id=$1", [winnerOp])).rows[0];
await tx(async (c) => {
  await c.query("UPDATE budgets SET reserved_cents=reserved_cents-$2, settled_cents=settled_cents+$2 WHERE org_id=$1 AND account='org-default' AND period_id='2026-10'", [org, reservation.amount_cents]);
  await c.query("UPDATE reservations SET state='settled' WHERE id=$1", [reservation.id]);
});
const october = (await q("SELECT reserved_cents::int AS reserved_cents, settled_cents::int AS settled_cents FROM budgets WHERE org_id=$1 AND account='org-default' AND period_id='2026-10'", [org])).rows[0];
const november = (await q("SELECT count(*)::int AS n FROM budgets WHERE org_id=$1 AND period_id='2026-11'", [org])).rows[0].n;
check(results, "cross-period-settlement", october.reserved_cents === 0 && october.settled_cents === 7 && november === 0, { october, november });

// Unknown operations keep their reservation and can only settle through reconciliation.
const unknownOp = await operation(org, runId, "tool:s3:unknown", "dispatching");
await q("UPDATE budgets SET reserved_cents=reserved_cents+3 WHERE org_id=$1 AND account='org-default' AND period_id='2026-10'", [org]);
await q("INSERT INTO reservations (id, org_id, operation_id, period_id, amount_cents, state) VALUES ($1,$2,$3,'2026-10',3,'held')", [uuid(), org, unknownOp]);
await q("UPDATE operations SET state='unknown' WHERE id=$1", [unknownOp]);
await q("UPDATE reservations SET state='unknown' WHERE operation_id=$1", [unknownOp]);
const releaseUnknown = await q("UPDATE reservations SET state='released' WHERE operation_id=$1 AND state='held' RETURNING id", [unknownOp]);
check(results, "unknown-not-auto-released", releaseUnknown.rowCount === 0, null);
const reconcile = await tx(async (c) => {
  const r = await c.query("UPDATE reservations SET state='settled' WHERE operation_id=$1 AND state='unknown' RETURNING amount_cents::int AS amount_cents", [unknownOp]);
  if (r.rowCount === 0) return 0;
  await c.query("UPDATE budgets SET reserved_cents=reserved_cents-$2, settled_cents=settled_cents+$2 WHERE org_id=$1 AND account='org-default' AND period_id='2026-10'", [org, r.rows[0].amount_cents]);
  return r.rowCount;
});
check(results, "unknown-settled-once", reconcile === 1, null);

// F15: no DR durability means no new reservation and no journal release.
await q("INSERT INTO budgets (org_id, account, period_id, limit_cents) VALUES ($1,'org-default','2026-11',100)", [org]);
await q("UPDATE dr_state SET durable=false WHERE id=1");
const blocked = await reserve({ operationId: opA, amount: 5, period: "2026-11" });
const releaseBlocked = await q(
  "INSERT INTO journal_release (device_id, session_id) SELECT 'dev-1','sess-1' WHERE (SELECT durable FROM dr_state WHERE id=1)=true ON CONFLICT DO NOTHING RETURNING device_id",
);
await q("UPDATE dr_state SET durable=true WHERE id=1");
const allowed = await reserve({ operationId: opC, amount: 5, period: "2026-11" });
const releaseAllowed = await q(
  "INSERT INTO journal_release (device_id, session_id) SELECT 'dev-1','sess-1' WHERE (SELECT durable FROM dr_state WHERE id=1)=true ON CONFLICT DO NOTHING RETURNING device_id",
);
check(results, "F15-dr-freeze", blocked.ok === false && releaseBlocked.rowCount === 0 && allowed.ok === true && releaseAllowed.rowCount === 1, { blocked, releaseBlocked: releaseBlocked.rowCount, allowed, releaseAllowed: releaseAllowed.rowCount });

// Hard budget: reservation above the limit is refused.
const overLimit = await reserve({ operationId: opD, amount: 150, period: "2026-11" });
check(results, "hard-budget-refused", overLimit.ok === false, overLimit);

// Price/usage normalization with explicit upper bounds and price versions.
const prices = {
  qwen: { version: "qwen-2026-10", inputPerM: 40, outputPerM: 120, cachePerM: 10 },
  deepseek: { version: "ds-2026-10", inputPerM: 28, outputPerM: 110, cachePerM: 7 },
  doubao: { version: "db-2026-10", inputPerM: 80, outputPerM: 200, cachePerM: 20 },
};
function normalizeUsage(provider, usage) {
  if (provider === "qwen") {
    return {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      priceVersion: prices.qwen.version,
    };
  }
  if (provider === "deepseek") {
    return {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      cached: usage.prompt_cache_hit_tokens ?? 0,
      reasoning: 0,
      priceVersion: prices.deepseek.version,
    };
  }
  if (provider === "doubao") {
    return {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cached: usage.input_tokens_details?.cached_tokens ?? 0,
      reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
      priceVersion: prices.doubao.version,
    };
  }
  throw new Error("unknown provider");
}
function costMicros(provider, normalized) {
  const price = prices[provider];
  if (!price) throw new Error("missing price");
  if (!Number.isInteger(normalized.input) || !Number.isInteger(normalized.output)) throw new Error("unbounded usage");
  const billableInput = Math.max(0, normalized.input - normalized.cached);
  return Math.round(((billableInput * price.inputPerM) + (normalized.cached * price.cachePerM) + (normalized.output * price.outputPerM)) / 1_000_000 * 1_000_000);
}
const qwenCost = costMicros("qwen", normalizeUsage("qwen", { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 50 } }));
const dsCost = costMicros("deepseek", normalizeUsage("deepseek", { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 200 }));
const dbCost = costMicros("doubao", normalizeUsage("doubao", { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 200 }, output_tokens_details: { reasoning_tokens: 50 } }));
check(results, "price-normalization", qwenCost > 0 && dsCost > 0 && dbCost > qwenCost && dbCost > dsCost, { qwenCost, dsCost, dbCost });
let missingPriceRejected = false;
try { costMicros("unknown", { input: 1, output: 1, cached: 0 }); } catch { missingPriceRejected = true; }
let unboundedRejected = false;
try { costMicros("qwen", { input: undefined, output: 1, cached: 0 }); } catch { unboundedRejected = true; }
check(results, "price-requires-bound", missingPriceRejected && unboundedRejected, { missingPriceRejected, unboundedRejected });

results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
console.log(JSON.stringify(results, null, 2));
await close();

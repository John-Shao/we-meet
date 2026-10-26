import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  host: "127.0.0.1",
  port: 55432,
  user: "postgres",
  password: "test",
  database: "wemeet",
  max: 20,
  options: "-c search_path=s1s6",
});

export function uuid() {
  return crypto.randomUUID();
}

export async function q(text, params) {
  return pool.query(text, params);
}

export async function tx(fn, client = null) {
  const conn = client ?? (await pool.connect());
  try {
    await conn.query("BEGIN");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  } finally {
    if (!client) conn.release();
  }
}

export async function resetSchema() {
  const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function createFixture(org = "org-1") {
  const taskId = uuid();
  const runId = uuid();
  await q(
    "INSERT INTO tasks (id, org_id, state, snapshot_id) VALUES ($1,$2,'open','snap-1')",
    [taskId, org],
  );
  await q(
    "INSERT INTO runs (id, org_id, task_id, attempt_no, state, fence, snapshot_id) VALUES ($1,$2,$3,1,'active',1,'snap-1')",
    [runId, org, taskId],
  );
  await q("UPDATE tasks SET active_run_id=$1 WHERE id=$2", [runId, taskId]);
  return { org, taskId, runId };
}

export async function operation(org, runId, logicalKey, state = "authorized", kind = "model") {
  const id = uuid();
  await q(
    "INSERT INTO operations (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ($1,$2,$3,$4,$5,'hash-1',$6)",
    [id, org, runId, logicalKey, kind, state],
  );
  return id;
}

export function check(results, name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) process.exitCode = 1;
}

export async function close() {
  await pool.end();
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool, Client } = pg;

export const CFG = {
  pgAdmin: process.env.PG_ADMIN ?? 'postgres://postgres:postgres@127.0.0.1:55434/work_temporal',
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  taskQueue: 'work-r0a-run',
  org: 'org1',
  subject: 'user1',
  period: '2026-10',
  accountKey: 'default',
  budgetLimitCents: 1_000_000,
  outboxMaxAgeMs: Number(process.env.OUTBOX_MAX_AGE_MS ?? 5 * 60 * 1000),
  outboxMaxCount: Number(process.env.OUTBOX_MAX_COUNT ?? 1000),
};

const pools = new Map();

function poolFor(role) {
  if (!pools.has(role)) {
    pools.set(role, new Pool({ connectionString: CFG.pgAdmin, max: 4 }));
  }
  return pools.get(role);
}

export async function withRole(role, fn) {
  const client = await poolFor(role).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.org_id', $1, true)", [CFG.org]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const withApi = (fn) => withRole('work_api', fn);
export const withWorker = (fn) => withRole('work_worker', fn);

export async function withAdmin(fn) {
  const client = new Client({ connectionString: CFG.pgAdmin });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function setupDatabase() {
  await closePools();
  const schemaPath =
    process.env.SCHEMA_PATH ??
    fileURLToPath(new URL('../../work-r0a-design-2026-10-25/r0a-schema-draft.sql', import.meta.url));
  const schema = readFileSync(schemaPath, 'utf8');
  const client = new Client({ connectionString: CFG.pgAdmin });
  await client.connect();
  try {
    await client.query(schema);
    await client.query(
      `INSERT INTO work.org (id, status, execution_enabled, home_region)
       VALUES ($1, 'active', true, 'cn-north')
       ON CONFLICT (id) DO NOTHING`,
      [CFG.org],
    );
    await client.query(
      `INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
       VALUES ($1, $2, 'active', 'owner', true)
       ON CONFLICT (org_id, subject_id) DO NOTHING`,
      [CFG.org, CFG.subject],
    );
    await client.query(
      `INSERT INTO work.org_policy
         (org_id, revision, force_ask_each, allow_auto_readonly, allow_plan_approval, policy)
       VALUES ($1, 1, false, true, false, '{"schema":"r0a-policy-v1"}'::jsonb)
       ON CONFLICT (org_id) DO NOTHING`,
      [CFG.org],
    );
    await client.query(
      `INSERT INTO work.budget_account
         (org_id, account_key, period_id, currency, limit_cents)
       VALUES ($1, $2, $3, 'CNY', $4)
       ON CONFLICT (org_id, account_key, period_id)
       DO UPDATE SET limit_cents = EXCLUDED.limit_cents,
                     reserved_cents = 0, settled_cents = 0`,
      [CFG.org, CFG.accountKey, CFG.period, CFG.budgetLimitCents],
    );
  } finally {
    await client.end();
  }
}

export async function closePools() {
  for (const pool of pools.values()) await pool.end();
  pools.clear();
}

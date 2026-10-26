import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CFG, setupDatabase, closePools, withAdmin } from '../src/db.mjs';

const { Pool } = pg;
let pool;

test.before(async () => {
  await setupDatabase();
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO work.org (id, status, execution_enabled, home_region)
       VALUES ('org2', 'active', true, 'cn-north') ON CONFLICT DO NOTHING`,
    );
    await client.query(
      `INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
       VALUES ('org2', 'user2', 'active', 'owner', true) ON CONFLICT DO NOTHING`,
    );
    for (const [org, subject, hash] of [
      ['org1', 'user1', 'sha256:rls-org1'],
      ['org2', 'user2', 'sha256:rls-org2'],
    ]) {
      const input = await client.query(
        `INSERT INTO work.input_object
           (org_id, subject_id, purpose, content_ref, content_hash, bytes, media_type)
         VALUES ($1, $2, 'task_input', $3, $4, 128, 'application/json')
         RETURNING id`,
        [org, subject, `content://${org}/rls`, hash],
      );
      await client.query(
        `INSERT INTO work.task
           (org_id, owner_subject_id, state, permission_mode, title, input_id)
         VALUES ($1, $2, 'open', 'ask_each', $3, $4)`,
        [org, subject, `RLS ${org}`, input.rows[0].id],
      );
    }
  });
  pool = new Pool({ connectionString: CFG.pgAdmin, max: 1 });
});

test.after(async () => {
  if (pool) await pool.end();
  await closePools();
});

async function withOrg(org, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE work_api');
    await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
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

test('RLS tenant context stays correct when one pooled connection is reused', async () => {
  const first = await withOrg('org1', (client) =>
    client.query('SELECT count(*)::int AS count FROM work.task'),
  );
  assert.equal(first.rows[0].count, 1);
  const second = await withOrg('org2', (client) =>
    client.query('SELECT count(*)::int AS count FROM work.task'),
  );
  assert.equal(second.rows[0].count, 1);
  const back = await withOrg('org1', (client) =>
    client.query('SELECT count(*)::int AS count FROM work.task'),
  );
  assert.equal(back.rows[0].count, 1);
});

test('missing tenant context returns no rows', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE work_api');
    const result = await client.query('SELECT count(*)::int AS count FROM work.task');
    assert.equal(result.rows[0].count, 0);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

test('work_api cannot write fact tables directly', async () => {
  await assert.rejects(
    () =>
      withOrg('org1', (client) =>
        client.query(
          `INSERT INTO work.task
             (org_id, owner_subject_id, state, permission_mode, title, input_id)
           SELECT org_id, owner_subject_id, state, permission_mode, 'forbidden', input_id
           FROM work.task WHERE org_id = 'org1' LIMIT 1`,
        ),
      ),
    /permission denied/,
  );
});

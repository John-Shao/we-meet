import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const userToken = 'connector-user-token';
const internalToken = 'connector-internal-token';
const org = 'org-connector';
const subject = 'alice';
const connectionId = '22222222-2222-4222-8222-222222222222';
const grantId = '33333333-3333-4333-8333-333333333333';
const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  'postgresql://postgres:test@127.0.0.1:55438/work_connector_slice';
const appUrl =
  process.env.DATABASE_URL ||
  'postgresql://work_connector_app:app@127.0.0.1:55438/work_connector_slice';
const contentDir = path.join(root, 'content', 'test');
const env = {
  ...process.env,
  ADMIN_DATABASE_URL: adminUrl,
  DATABASE_URL: appUrl,
  USER_TOKEN: userToken,
  INTERNAL_TOKEN: internalToken,
  ORG_ID: org,
  SUBJECT_ID: subject,
  CONNECTION_ID: connectionId,
  GRANT_ID: grantId,
  CONTENT_DIR: contentDir,
};

function runInit() {
  execFileSync(process.execPath, ['slice.mjs', 'init'], {
    cwd: root,
    env,
    stdio: 'pipe',
  });
}

async function startApi() {
  const child = spawn(process.execPath, ['slice.mjs', 'serve'], {
    cwd: root,
    env: { ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`api_timeout:${stderr}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/LISTENING (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`api_exit:${code}:${stderr}`));
    });
  });
  return { child, port };
}

async function request(base, method, pathname, body, internal = false) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(internal
        ? { 'x-internal-token': internalToken }
        : { authorization: `Bearer ${userToken}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function intent(inputRef, projectId = 'alpha') {
  return {
    input_ref: inputRef,
    target: { kind: 'cloud', profile: 'text-v1' },
    connectors: [
      {
        connection_id: connectionId,
        grant_id: grantId,
        resource_selector: { project_id: projectId },
      },
    ],
    permission_mode: 'ask_each',
    output: { format: 'markdown', logical_name: 'connector-summary.md' },
  };
}

async function count(admin, sql, params = []) {
  const result = await admin.query(sql, params);
  return Number(result.rows[0].n);
}

test('connector scope and revocation', async (t) => {
  await fs.rm(contentDir, { recursive: true, force: true });
  runInit();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const api = await startApi();
  const base = `http://127.0.0.1:${api.port}`;
  let firstTask;
  let firstRun;

  try {
    await t.test('bootstrap exposes the connector grant', async () => {
      const bootstrap = await request(base, 'GET', '/work/v1/bootstrap');
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.body.org.id, org);
      const connections = await request(base, 'GET', '/work/v1/connector-connections');
      assert.equal(connections.status, 200);
      assert.equal(connections.body.length, 1);
      assert.equal(connections.body[0].provider, 'mock-docs');
      assert.equal(connections.body[0].status, 'active');
      assert.equal(connections.body[0].grants[0].resource_selector.project_id, 'alpha');
      assert.deepEqual(connections.body[0].grants[0].allowed_actions, ['docs.read']);
    });

    await t.test('preview and adapter reject out-of-scope project', async () => {
      const alpha = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:connector-alpha'),
      });
      assert.equal(alpha.status, 200);
      assert.equal(alpha.body.cost_upper_bound.amount_cents, 5);
      assert.equal(alpha.body.grant_revision, 1);

      const beta = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:connector-beta', 'beta'),
      });
      assert.equal(beta.status, 422);
      assert.equal(beta.body.code, 'scope_unavailable');

      const adapterAlpha = await request(
        base,
        'POST',
        '/internal/connector/invoke',
        {
          grant_id: grantId,
          action: 'docs.read',
          resource_selector: { project_id: 'alpha' },
        },
        true,
      );
      assert.equal(adapterAlpha.status, 200);
      assert.equal(adapterAlpha.body.documents.length, 2);
      assert.equal(adapterAlpha.body.credential_ref_visible, false);

      const adapterBeta = await request(
        base,
        'POST',
        '/internal/connector/invoke',
        {
          grant_id: grantId,
          action: 'docs.read',
          resource_selector: { project_id: 'beta' },
        },
        true,
      );
      assert.equal(adapterBeta.status, 403);
      assert.equal(adapterBeta.body.code, 'scope_unavailable');
    });

    await t.test('worker reads through the adapter and publishes an artifact', async () => {
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:connector-alpha'),
      });
      const submitted = await request(base, 'POST', '/work/v1/tasks', {
        client_request_id: crypto.randomUUID(),
        preview_hash: preview.body.preview_hash,
        intent: intent('input:connector-alpha'),
      });
      assert.equal(submitted.status, 202);
      firstTask = submitted.body.task;
      firstRun = submitted.body.run;

      const firstTick = await request(base, 'POST', '/internal/worker/tick', undefined, true);
      assert.equal(firstTick.status, 200);
      assert.equal(firstTick.body.actions[0].action, 'connector_prepared');
      const prepared = await request(base, 'GET', `/work/v1/runs/${firstRun.id}/operations`);
      assert.equal(prepared.body.items[0].state, 'authorized');
      const reserved = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(reserved.rows[0].reserved_cents), 5);
      assert.equal(Number(reserved.rows[0].settled_cents), 0);

      const secondTick = await request(base, 'POST', '/internal/worker/tick', undefined, true);
      assert.equal(secondTick.status, 200);
      assert.equal(secondTick.body.actions[0].action, 'connector_completed');

      const task = await request(base, 'GET', `/work/v1/tasks/${firstTask.id}`);
      assert.equal(task.body.state, 'awaiting_acceptance');
      assert.equal(task.body.active_run_id, null);
      const run = await request(base, 'GET', `/work/v1/runs/${firstRun.id}`);
      assert.equal(run.body.state, 'succeeded');
      const operations = await request(base, 'GET', `/work/v1/runs/${firstRun.id}/operations`);
      assert.equal(operations.body.items[0].state, 'succeeded');
      const account = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(account.rows[0].reserved_cents), 0);
      assert.equal(Number(account.rows[0].settled_cents), 3);

      const events = await request(base, 'GET', `/work/v1/tasks/${firstTask.id}/events`);
      const artifactEvent = events.body.find((event) => event.type === 'task.artifact.published');
      assert.ok(artifactEvent);
      const artifact = await request(
        base,
        'GET',
        `/work/v1/artifacts/${artifactEvent.payload.artifact_id}/versions/${artifactEvent.payload.version_no}`,
      );
      assert.equal(artifact.status, 200);
      assert.equal(artifact.body.state, 'published');
      await fs.access(path.join(contentDir, `${artifact.body.content_hash}.md`));

      const payload = {
        client_request_id: crypto.randomUUID(),
        expected_revision: task.body.revision,
        artifact_id: artifactEvent.payload.artifact_id,
        version_no: artifactEvent.payload.version_no,
      };
      const accepted = await request(base, 'POST', `/work/v1/tasks/${firstTask.id}/acceptances`, payload);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.task.state, 'completed');
      const duplicate = await request(base, 'POST', `/work/v1/tasks/${firstTask.id}/acceptances`, payload);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.acceptance.id, accepted.body.acceptance.id);
    });

    await t.test('grant refresh is allowed while active', async () => {
      const refreshed = await request(
        base,
        'POST',
        '/internal/connector/refresh',
        { grant_id: grantId },
        true,
      );
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.body.status, 'active');
      assert.equal(refreshed.body.revision, 2);
      const grants = await request(base, 'GET', '/work/v1/connector-grants');
      assert.equal(grants.body[0].revision, 2);
    });

    await t.test('revocation stops a prepared connector operation and releases budget', async () => {
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:connector-revoked'),
      });
      const submitted = await request(base, 'POST', '/work/v1/tasks', {
        client_request_id: crypto.randomUUID(),
        preview_hash: preview.body.preview_hash,
        intent: intent('input:connector-revoked'),
      });
      assert.equal(submitted.status, 202);
      const task = submitted.body.task;
      const run = submitted.body.run;

      const prepared = await request(base, 'POST', '/internal/worker/tick', undefined, true);
      assert.equal(prepared.body.actions[0].action, 'connector_prepared');
      const revoked = await request(
        base,
        'POST',
        `/work/v1/connector-grants/${grantId}/revoke`,
        { client_request_id: crypto.randomUUID() },
      );
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.status, 'revoked');
      assert.equal(revoked.body.revision, 3);

      const denied = await request(base, 'POST', '/internal/worker/tick', undefined, true);
      assert.equal(denied.status, 200);
      assert.equal(denied.body.actions[0].action, 'connector_revoked');

      const taskNow = await request(base, 'GET', `/work/v1/tasks/${task.id}`);
      assert.equal(taskNow.body.state, 'open');
      assert.equal(taskNow.body.active_run_id, null);
      assert.equal(taskNow.body.latest_run_id, run.id);
      const runNow = await request(base, 'GET', `/work/v1/runs/${run.id}`);
      assert.equal(runNow.body.state, 'failed');
      const operations = await request(base, 'GET', `/work/v1/runs/${run.id}/operations`);
      assert.equal(operations.body.items[0].state, 'canceled');
      const account = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(account.rows[0].reserved_cents), 0);
      assert.equal(Number(account.rows[0].settled_cents), 3);
      assert.equal(
        await count(admin, 'SELECT count(*)::int AS n FROM work.artifact WHERE task_id = $1', [
          task.id,
        ]),
        0,
      );

      // Run 已 failed，Operation 已 canceled，Task 处于安全静止；允许显式无成果完成。
      const completed = await request(base, 'POST', `/work/v1/tasks/${task.id}/acceptances`, {
        client_request_id: crypto.randomUUID(),
        expected_revision: taskNow.body.revision,
        completion_reason: 'connector grant revoked before read',
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.body.task.state, 'completed');
      assert.equal(completed.body.acceptance.artifact_id, null);
    });

    await t.test('revoked grant cannot be refreshed or used for a new task', async () => {
      const refresh = await request(
        base,
        'POST',
        '/internal/connector/refresh',
        { grant_id: grantId },
        true,
      );
      assert.equal(refresh.status, 409);
      assert.equal(refresh.body.code, 'scope_unavailable');

      const invoke = await request(
        base,
        'POST',
        '/internal/connector/invoke',
        {
          grant_id: grantId,
          action: 'docs.read',
          resource_selector: { project_id: 'alpha' },
        },
        true,
      );
      assert.equal(invoke.status, 403);
      assert.equal(invoke.body.code, 'scope_unavailable');

      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:connector-after-revoke'),
      });
      assert.equal(preview.status, 422);
      assert.equal(preview.body.code, 'scope_unavailable');
    });
  } finally {
    api.child.kill('SIGTERM');
    await admin.end();
  }
});

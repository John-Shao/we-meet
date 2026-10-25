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
const token = 'slice-dev-token';
const org = 'org-slice';
const subject = 'alice';
const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  'postgresql://postgres:test@127.0.0.1:55436/work_slice';
const appUrl =
  process.env.DATABASE_URL ||
  'postgresql://work_slice_app:app@127.0.0.1:55436/work_slice';
const contentDir = path.join(root, 'content', 'test');
const env = {
  ...process.env,
  ADMIN_DATABASE_URL: adminUrl,
  DATABASE_URL: appUrl,
  DEV_TOKEN: token,
  ORG_ID: org,
  SUBJECT_ID: subject,
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
    const timer = setTimeout(() => reject(new Error(`api_start_timeout:${stderr}`)), 10_000);
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
      reject(new Error(`api_exited:${code}:${stderr}`));
    });
  });
  return {
    port,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 2_000);
      });
    },
  };
}

async function request(base, method, pathname, body, extraHeaders = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...extraHeaders,
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

function intent(inputRef) {
  return {
    input_ref: inputRef,
    target: { kind: 'cloud', profile: 'text-v1' },
    permission_mode: 'ask_each',
    output: { format: 'markdown', logical_name: 'result.md' },
  };
}

async function count(admin, sql, params = []) {
  const result = await admin.query(sql, params);
  return Number(result.rows[0].n);
}

test('cloud task to acceptance vertical slice', async (t) => {
  runInit();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const api = await startApi();
  const base = `http://127.0.0.1:${api.port}`;
  let pendingApproval;
  let firstTask;
  let firstRun;

  try {
    await t.test('bootstrap exposes the server-bound org and modes', async () => {
      const health = await request(base, 'GET', '/healthz');
      assert.equal(health.status, 200);
      const bootstrap = await request(base, 'GET', '/work/v1/bootstrap');
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.body.subject_id, subject);
      assert.equal(bootstrap.body.org.id, org);
      assert.deepEqual(bootstrap.body.allowed_permission_modes, [
        'ask_each',
        'auto_readonly',
      ]);
      assert.deepEqual(bootstrap.body.execution_targets, [
        { kind: 'cloud', profile: 'text-v1' },
      ]);
    });

    await t.test('preview rejects unknown mode and returns a bounded cost', async () => {
      const bad = await request(base, 'POST', '/work/v1/task-previews', {
        intent: { ...intent('input:bad'), permission_mode: 'allow_all' },
      });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.code, 'permission_mode_unavailable');

      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:brief-1'),
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.effective_permission_mode, 'ask_each');
      assert.equal(preview.body.cost_upper_bound.amount_cents, 30);
      assert.ok(preview.body.preview_hash.startsWith('sha256:'));
      t.diagnostic(`preview ${preview.body.preview_hash}`);
      pendingApproval = preview.body;
    });

    await t.test('submit is idempotent and creates one active run', async () => {
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:brief-1'),
      });
      const clientRequestId = crypto.randomUUID();
      const payload = {
        client_request_id: clientRequestId,
        preview_hash: preview.body.preview_hash,
        intent: intent('input:brief-1'),
      };
      const first = await request(base, 'POST', '/work/v1/tasks', payload);
      assert.equal(first.status, 202);
      assert.equal(first.body.task.state, 'open');
      assert.equal(first.body.run.state, 'queued');
      assert.equal(first.body.task.active_run_id, first.body.run.id);
      assert.equal(first.body.task.latest_run_id, first.body.run.id);
      firstTask = first.body.task;
      firstRun = first.body.run;

      const duplicate = await request(base, 'POST', '/work/v1/tasks', payload);
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.task.id, firstTask.id);
      assert.equal(duplicate.body.run.id, firstRun.id);
      assert.equal(await count(admin, 'SELECT count(*)::int AS n FROM work.task'), 1);
      assert.equal(
        await count(admin, 'SELECT count(*)::int AS n FROM work.submission_dedup'),
        1,
      );
      assert.equal(
        await count(admin, 'SELECT count(*)::int AS n FROM work.budget_reservation'),
        0,
      );
    });

    await t.test('a second run and premature acceptance are rejected while active', async () => {
      const secondRun = await request(
        base,
        'POST',
        `/work/v1/tasks/${firstTask.id}/runs`,
        {
          client_request_id: crypto.randomUUID(),
          target: { kind: 'cloud', profile: 'text-v1' },
        },
      );
      assert.equal(secondRun.status, 409);
      assert.equal(secondRun.body.code, 'run_not_quiescent');

      const premature = await request(
        base,
        'POST',
        `/work/v1/tasks/${firstTask.id}/acceptances`,
        {
          client_request_id: crypto.randomUUID(),
          expected_revision: firstTask.revision,
          completion_reason: 'premature',
        },
      );
      assert.equal(premature.status, 409);
      assert.equal(premature.body.code, 'run_not_quiescent');
    });

    await t.test('worker reaches approval gate with two operations and a budget ledger', async () => {
      const tick = await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': token,
      });
      assert.equal(tick.status, 200);
      assert.equal(tick.body.actions[0].action, 'waiting_approval');

      const run = await request(base, 'GET', `/work/v1/runs/${firstRun.id}`);
      assert.equal(run.status, 200);
      assert.equal(run.body.state, 'waiting');
      assert.equal(run.body.wait_reason, 'approval');
      assert.equal(run.body.fence, 2);

      const operations = await request(
        base,
        'GET',
        `/work/v1/runs/${firstRun.id}/operations`,
      );
      assert.equal(operations.status, 200);
      const byKey = Object.fromEntries(
        operations.body.items.map((operation) => [
          operation.logical_key,
          operation.state,
        ]),
      );
      assert.equal(byKey['model:1'], 'succeeded');
      assert.equal(byKey['tool:1'], 'waiting_approval');

      const approvals = await request(base, 'GET', '/work/v1/approvals?status=pending');
      assert.equal(approvals.status, 200);
      assert.equal(approvals.body.items.length, 1);
      pendingApproval = approvals.body.items[0];
      assert.equal(pendingApproval.status, 'pending');

      const account = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(account.rows[0].reserved_cents), 10);
      assert.equal(Number(account.rows[0].settled_cents), 12);

      const premature = await request(
        base,
        'POST',
        `/work/v1/tasks/${firstTask.id}/acceptances`,
        {
          client_request_id: crypto.randomUUID(),
          expected_revision: (await request(base, 'GET', `/work/v1/tasks/${firstTask.id}`)).body
            .revision,
          completion_reason: 'still waiting',
        },
      );
      assert.equal(premature.status, 409);
    });

    await t.test('approval is revision/hash bound; wrong hash does not decide', async () => {
      const wrong = await request(
        base,
        'POST',
        `/work/v1/approvals/${pendingApproval.id}/decisions`,
        {
          client_request_id: crypto.randomUUID(),
          expected_revision: pendingApproval.revision,
          params_hash: 'sha256:wrong',
          decision: 'approved',
        },
      );
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.code, 'version_conflict');

      const approved = await request(
        base,
        'POST',
        `/work/v1/approvals/${pendingApproval.id}/decisions`,
        {
          client_request_id: crypto.randomUUID(),
          expected_revision: pendingApproval.revision,
          params_hash: pendingApproval.params_hash,
          decision: 'approved',
        },
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, 'approved');
      assert.equal(approved.body.revision, 1);
    });

    await t.test('worker publishes an artifact and clears active run', async () => {
      const tick = await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': token,
      });
      assert.equal(tick.status, 200);
      assert.equal(tick.body.actions[0].action, 'artifact_published');

      const task = await request(base, 'GET', `/work/v1/tasks/${firstTask.id}`);
      assert.equal(task.body.state, 'awaiting_acceptance');
      assert.equal(task.body.active_run_id, null);
      assert.equal(task.body.latest_run_id, firstRun.id);

      const run = await request(base, 'GET', `/work/v1/runs/${firstRun.id}`);
      assert.equal(run.body.state, 'succeeded');
      assert.equal(run.body.wait_reason, null);

      const operations = await request(
        base,
        'GET',
        `/work/v1/runs/${firstRun.id}/operations`,
      );
      assert.deepEqual(
        operations.body.items.map((operation) => operation.state),
        ['succeeded', 'succeeded'],
      );

      const account = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(account.rows[0].reserved_cents), 0);
      assert.equal(Number(account.rows[0].settled_cents), 15);

      const events = await request(
        base,
        'GET',
        `/work/v1/tasks/${firstTask.id}/events`,
      );
      const types = events.body.map((event) => event.type);
      assert.ok(types.includes('task.approval.requested'));
      assert.ok(types.includes('task.artifact.published'));
      const artifactEvent = events.body.find(
        (event) => event.type === 'task.artifact.published',
      );
      const artifact = await request(
        base,
        'GET',
        `/work/v1/artifacts/${artifactEvent.payload.artifact_id}/versions/${artifactEvent.payload.version_no}`,
      );
      assert.equal(artifact.status, 200);
      assert.equal(artifact.body.state, 'published');
      assert.equal(artifact.body.location, 'cloud');

      const content = await admin.query(
        `SELECT content_ref FROM work.artifact_version
         WHERE artifact_id = $1 AND version_no = $2`,
        [artifactEvent.payload.artifact_id, artifactEvent.payload.version_no],
      );
      await fs.access(
        path.join(contentDir, content.rows[0].content_ref.replace(/^content\//, '')),
      );
      assert.ok(
        await count(
          admin,
          'SELECT count(*)::int AS n FROM work.outbox WHERE aggregate_id = $1',
          [firstTask.id],
        ) > 0,
      );
    });

    await t.test('acceptance completes the task and is idempotent', async () => {
      const task = await request(base, 'GET', `/work/v1/tasks/${firstTask.id}`);
      const events = await request(
        base,
        'GET',
        `/work/v1/tasks/${firstTask.id}/events`,
      );
      const artifactEvent = events.body.find(
        (event) => event.type === 'task.artifact.published',
      );
      const payload = {
        client_request_id: crypto.randomUUID(),
        expected_revision: task.body.revision,
        artifact_id: artifactEvent.payload.artifact_id,
        version_no: artifactEvent.payload.version_no,
      };
      const accepted = await request(
        base,
        'POST',
        `/work/v1/tasks/${firstTask.id}/acceptances`,
        payload,
      );
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.task.state, 'completed');
      assert.equal(accepted.body.acceptance.artifact_id, artifactEvent.payload.artifact_id);

      const duplicate = await request(
        base,
        'POST',
        `/work/v1/tasks/${firstTask.id}/acceptances`,
        payload,
      );
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.acceptance.id, accepted.body.acceptance.id);
      assert.equal(
        await count(
          admin,
          'SELECT count(*)::int AS n FROM work.acceptance WHERE task_id = $1',
          [firstTask.id],
        ),
        1,
      );

      const finalEvents = await request(
        base,
        'GET',
        `/work/v1/tasks/${firstTask.id}/events`,
      );
      assert.ok(
        finalEvents.body.some((event) => event.type === 'task.acceptance.recorded'),
      );
      assert.ok(
        finalEvents.body.some(
          (event) =>
            event.type === 'task.state_changed' &&
            event.payload.to_state === 'completed',
        ),
      );
    });

    await t.test('rejecting the approval fails the run without completing the task', async () => {
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent('input:brief-2'),
      });
      const submitted = await request(base, 'POST', '/work/v1/tasks', {
        client_request_id: crypto.randomUUID(),
        preview_hash: preview.body.preview_hash,
        intent: intent('input:brief-2'),
      });
      assert.equal(submitted.status, 202);
      const taskId = submitted.body.task.id;
      const runId = submitted.body.run.id;
      await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': token,
      });
      const approvals = await request(base, 'GET', '/work/v1/approvals?status=pending');
      const approval = approvals.body.items.find((item) => item.task_id === taskId);
      assert.ok(approval);
      const rejected = await request(
        base,
        'POST',
        `/work/v1/approvals/${approval.id}/decisions`,
        {
          client_request_id: crypto.randomUUID(),
          expected_revision: approval.revision,
          params_hash: approval.params_hash,
          decision: 'rejected',
        },
      );
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.status, 'rejected');

      const task = await request(base, 'GET', `/work/v1/tasks/${taskId}`);
      assert.equal(task.body.state, 'open');
      assert.equal(task.body.active_run_id, null);
      const run = await request(base, 'GET', `/work/v1/runs/${runId}`);
      assert.equal(run.body.state, 'failed');
      const operations = await request(
        base,
        'GET',
        `/work/v1/runs/${runId}/operations`,
      );
      const tool = operations.body.items.find(
        (operation) => operation.logical_key === 'tool:1',
      );
      assert.equal(tool.state, 'canceled');
    });
  } finally {
    await api.close();
    await admin.end();
  }
});

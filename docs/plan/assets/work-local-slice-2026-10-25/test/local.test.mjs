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
const token = 'local-user-token';
const deviceToken = 'device-slice-token';
const deviceId = '11111111-1111-4111-8111-111111111111';
const org = 'org-local';
const subject = 'alice';
const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  'postgresql://postgres:test@127.0.0.1:55437/work_local_slice';
const appUrl =
  process.env.DATABASE_URL ||
  'postgresql://work_local_app:app@127.0.0.1:55437/work_local_slice';
const contentDir = path.join(root, 'content', 'test');
const env = {
  ...process.env,
  ADMIN_DATABASE_URL: adminUrl,
  DATABASE_URL: appUrl,
  USER_TOKEN: token,
  DEVICE_TOKEN: deviceToken,
  INTERNAL_TOKEN: 'local-internal-token',
  PERMIT_SECRET: 'local-slice-permit-secret',
  ORG_ID: org,
  SUBJECT_ID: subject,
  DEVICE_ID: deviceId,
  LEASE_SECONDS: '2',
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
  return { port, child };
}

async function stopAgent(agent) {
  if (!agent || agent.child.exitCode !== null) return;
  agent.child.kill('SIGTERM');
  await new Promise((resolve) => {
    agent.child.once('exit', resolve);
    setTimeout(resolve, 2_000);
  });
}

function startAgent(port, dropReceipt) {
  const child = spawn(process.execPath, ['device-agent.mjs'], {
    cwd: root,
    env: {
      ...env,
      API_URL: `http://127.0.0.1:${port}`,
      ROOT_DIR: path.join(contentDir, 'device-root'),
      STATE_FILE: path.join(contentDir, 'agent-state.json'),
      JOURNAL_FILE: path.join(contentDir, 'journal.json'),
      DROP_RECEIPT_ONCE: dropReceipt ? '1' : '0',
      POLL_MS: '50',
      HEARTBEAT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function waitFor(predicate, timeoutMs = 10_000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout:${label}`);
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

function intent(grantId, inputRef) {
  return {
    input_ref: inputRef,
    target: { kind: 'local', device_id: deviceId },
    workspace_grant_id: grantId,
    permission_mode: 'ask_each',
    output: { format: 'markdown', logical_name: 'device-result.md' },
  };
}

async function count(admin, sql, params = []) {
  const result = await admin.query(sql, params);
  return Number(result.rows[0].n);
}

test('local authorization and disconnected recovery', async (t) => {
  await fs.rm(contentDir, { recursive: true, force: true });
  runInit();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const api = await startApi();
  const base = `http://127.0.0.1:${api.port}`;
  let agent = startAgent(api.port, true);
  let task;
  let run;
  let grant;

  try {
    await t.test('device hello and workspace grant are explicit', async () => {
      await waitFor(() => agent.stdout.includes('HELLO'), 8_000, 'device_hello');
      const bootstrap = await request(base, 'GET', '/work/v1/bootstrap');
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.body.org.id, org);
      const grants = await request(base, 'GET', '/work/v1/workspace-grants');
      assert.equal(grants.status, 200);
      grant = await request(base, 'POST', '/work/v1/workspace-grants', {
        root_ref: 'workspace-root-ref',
        allowed_tools: ['workspace.write'],
      });
      assert.equal(grant.status, 201);
      assert.equal(grant.body.device_id, deviceId);
      assert.equal(grant.body.root_ref, 'workspace-root-ref');
      assert.ok(!JSON.stringify(grant.body).includes('C:\\'));
      // 让会话保持在线，但先停掉轮询，保证审批后能观察到 waiting/device。
      await stopAgent(agent);
    });

    await t.test('preview and submit use local target and grant', async () => {
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent(grant.body.id, 'input:local-1'),
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.effective_permission_mode, 'ask_each');
      assert.equal(preview.body.cost_upper_bound.amount_cents, 10);
      const submitted = await request(base, 'POST', '/work/v1/tasks', {
        client_request_id: crypto.randomUUID(),
        preview_hash: preview.body.preview_hash,
        intent: intent(grant.body.id, 'input:local-1'),
      });
      assert.equal(submitted.status, 202);
      task = submitted.body.task;
      run = submitted.body.run;
      assert.equal(task.state, 'open');
      assert.equal(run.state, 'queued');
      assert.equal(task.active_run_id, run.id);
      assert.equal(task.latest_run_id, run.id);
    });

    await t.test('approval moves the run to a device wait, not execution', async () => {
      const tick = await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': 'local-internal-token',
      });
      assert.equal(tick.status, 200);
      const approvals = await request(base, 'GET', '/work/v1/approvals?status=pending');
      const approval = approvals.body.items.find((item) => item.task_id === task.id);
      assert.ok(approval);
      const decided = await request(base, 'POST', `/work/v1/approvals/${approval.id}/decisions`, {
        client_request_id: crypto.randomUUID(),
        expected_revision: approval.revision,
        params_hash: approval.params_hash,
        decision: 'approved',
      });
      assert.equal(decided.status, 200);
      await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': 'local-internal-token',
      });
      const waiting = await request(base, 'GET', `/work/v1/runs/${run.id}`);
      assert.equal(waiting.body.state, 'waiting');
      assert.equal(waiting.body.wait_reason, 'device');
      agent = startAgent(api.port, true);
      await waitFor(() => agent.stdout.includes('HELLO'), 8_000, 'drop_agent_hello');
    });

    await t.test('agent executes, drops receipt, lease expiry becomes unknown', async () => {
      const resultFile = path.join(contentDir, 'device-root', 'device-result.md');
      await waitFor(
        async () => {
          try {
            await fs.access(resultFile);
            return true;
          } catch {
            return false;
          }
        },
        8_000,
        'device_file',
      );
      await waitFor(() => agent.stdout.includes('DROP_RECEIPT'), 8_000, 'drop_receipt');
      await waitFor(
        () => agent.child.exitCode !== null || agent.child.signalCode !== null,
        3_000,
        'drop_agent_exit',
      );

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const sweep = await request(base, 'POST', '/internal/worker/tick', undefined, {
        'x-internal-token': 'local-internal-token',
      });
      assert.equal(sweep.status, 200);
      const runNow = await request(base, 'GET', `/work/v1/runs/${run.id}`);
      assert.equal(runNow.body.state, 'waiting');
      assert.equal(runNow.body.wait_reason, 'reconcile');
      const ops = await request(base, 'GET', `/work/v1/runs/${run.id}/operations`);
      assert.equal(ops.body.items[0].state, 'unknown');
      const taskNow = await request(base, 'GET', `/work/v1/tasks/${task.id}`);
      assert.equal(taskNow.body.state, 'open');
      assert.equal(taskNow.body.active_run_id, run.id);
      const premature = await request(base, 'POST', `/work/v1/tasks/${task.id}/acceptances`, {
        client_request_id: crypto.randomUUID(),
        expected_revision: taskNow.body.revision,
        completion_reason: 'not reconciled',
      });
      assert.equal(premature.status, 409);
      assert.equal(await count(admin, 'SELECT count(*)::int AS n FROM work.device_receipt'), 0);
    });

    await t.test('reconnect replays journal and completes without re-execution', async () => {
      agent = startAgent(api.port, false);
      await waitFor(() => agent.stdout.includes('HELLO'), 8_000, 'reconnect_hello');
      await waitFor(
        async () => {
          const taskNow = await request(base, 'GET', `/work/v1/tasks/${task.id}`);
          return taskNow.status === 200 && taskNow.body.state === 'awaiting_acceptance';
        },
        10_000,
        'task_awaiting_after_reconcile',
      );
      const runNow = await request(base, 'GET', `/work/v1/runs/${run.id}`);
      assert.equal(runNow.body.state, 'succeeded');
      const taskNow = await request(base, 'GET', `/work/v1/tasks/${task.id}`);
      assert.equal(taskNow.body.active_run_id, null);
      assert.equal(taskNow.body.latest_run_id, run.id);
      const ops = await request(base, 'GET', `/work/v1/runs/${run.id}/operations`);
      assert.equal(ops.body.items[0].state, 'reconciled');
      const receipts = await count(
        admin,
        'SELECT count(*)::int AS n FROM work.device_receipt WHERE operation_id = $1',
        [ops.body.items[0].id],
      );
      assert.equal(receipts, 1);
      assert.equal(
        await count(admin, 'SELECT count(*)::int AS n FROM work.journal_release WHERE device_id = $1', [
          deviceId,
        ]),
        1,
      );
      assert.ok(agent.stdout.includes('REPLAY_RECEIPT'));
      assert.ok(!agent.stdout.includes('EXECUTED'));
      const content = await fs.readFile(
        path.join(contentDir, 'device-root', 'device-result.md'),
        'utf8',
      );
      assert.equal(content.split('Task:').length - 1, 1);

      const account = await admin.query(
        `SELECT reserved_cents, settled_cents FROM work.budget_account
         WHERE org_id = $1 AND account_key = 'default'`,
        [org],
      );
      assert.equal(Number(account.rows[0].reserved_cents), 0);
      assert.equal(Number(account.rows[0].settled_cents), 2);
    });

    await t.test('local-only artifact can be accepted idempotently', async () => {
      const taskNow = await request(base, 'GET', `/work/v1/tasks/${task.id}`);
      const events = await request(base, 'GET', `/work/v1/tasks/${task.id}/events`);
      const artifactEvent = events.body.find((event) => event.type === 'task.artifact.published');
      assert.ok(artifactEvent);
      const artifact = await request(
        base,
        'GET',
        `/work/v1/artifacts/${artifactEvent.payload.artifact_id}/versions/${artifactEvent.payload.version_no}`,
      );
      assert.equal(artifact.status, 200);
      assert.equal(artifact.body.location, 'local_only');
      assert.equal(artifact.body.content_url, null);

      const payload = {
        client_request_id: crypto.randomUUID(),
        expected_revision: taskNow.body.revision,
        artifact_id: artifactEvent.payload.artifact_id,
        version_no: artifactEvent.payload.version_no,
      };
      const accepted = await request(base, 'POST', `/work/v1/tasks/${task.id}/acceptances`, payload);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.task.state, 'completed');
      const duplicate = await request(base, 'POST', `/work/v1/tasks/${task.id}/acceptances`, payload);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.acceptance.id, accepted.body.acceptance.id);
      assert.equal(
        await count(admin, 'SELECT count(*)::int AS n FROM work.acceptance WHERE task_id = $1', [task.id]),
        1,
      );
    });

    await t.test('revoking the grant blocks a new local task', async () => {
      const revoked = await request(
        base,
        'POST',
        `/work/v1/workspace-grants/${grant.body.id}/revoke`,
        {},
      );
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.status, 'revoked');
      const preview = await request(base, 'POST', '/work/v1/task-previews', {
        intent: intent(grant.body.id, 'input:local-2'),
      });
      assert.equal(preview.status, 422);
      assert.equal(preview.body.code, 'scope_unavailable');
    });
  } finally {
    agent.child.kill('SIGTERM');
    api.child.kill('SIGTERM');
    await admin.end();
  }
});

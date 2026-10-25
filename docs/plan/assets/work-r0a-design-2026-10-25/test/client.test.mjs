import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkServer } from '../mock-server.mjs';
import {
  OPERATIONS,
  WorkApiError,
  createWorkClient,
} from '../r0a-client.mjs';

const app = createWorkServer();
const cookie = 'we_meet_session=test-session';
let baseUrl;
let csrf;

function client(overrides = {}) {
  return createWorkClient({
    baseUrl,
    cookie,
    csrfToken: csrf,
    ...overrides,
  });
}

async function reset() {
  const response = await fetch(`${baseUrl}/__test/reset`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 200);
}

async function raw(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

test.before(async () => {
  csrf = app.state.csrfToken;
  baseUrl = `http://127.0.0.1:${await app.listen()}`;
});

test.after(async () => {
  await app.close();
});

test.beforeEach(reset);

test('generated operation inventory matches the 20-path R0a subset', () => {
  assert.equal(OPERATIONS.length, 21);
  assert.equal(new Set(OPERATIONS.map((op) => op.operationId)).size, 21);
  assert.equal(new Set(OPERATIONS.map((op) => op.path)).size, 20);
  const submit = OPERATIONS.find((op) => op.operationId === 'submitTask');
  assert.equal(submit.method, 'POST');
  assert.equal(submit.successStatus, 202);
  assert.equal(submit.requestSchema, 'TaskSubmitRequest');
  assert.equal(submit.requiresCsrf, true);
  const stream = OPERATIONS.find((op) => op.operationId === 'streamTaskEvents');
  assert.equal(stream.stream, true);
  assert.equal(stream.successContentType, 'text/event-stream');
  assert.deepEqual(stream.headerParams, ['Last-Event-ID']);
});

test('golden path through the generated client', async () => {
  const api = client();
  const bootstrap = await api.getBootstrap();
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.csrf_token, csrf);
  assert.equal(bootstrap.data.org.id, 'org1');

  const templates = await api.listTemplates();
  assert.equal(templates.data.items.length, 3);

  const input = await api.createInput({
    body: {
      client_request_id: 'req-client-0001',
      goal: '写一份会员改版方案初稿',
      background: '背景：会员增长放缓。',
      media_type: 'text/markdown',
    },
  });
  assert.equal(input.status, 201);
  assert.ok(input.data.input_ref);

  const intent = {
    input_ref: input.data.input_ref,
    target: { kind: 'cloud', profile: 'text-v1' },
    template: { id: 'tpl-report', version: 1 },
    permission_mode: 'ask_each',
    output: { format: 'markdown', length: 'medium' },
  };
  const preview = await api.createTaskPreview({ body: { intent } });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.preview_hash);

  const submit = await api.submitTask({
    body: {
      client_request_id: 'req-client-task-0001',
      preview_hash: preview.data.preview_hash,
      intent,
    },
  });
  assert.equal(submit.status, 202);
  const taskId = submit.data.task.task_id;
  assert.equal(submit.data.task.display_state, 'queued');

  const detail = await api.getTask({ path: { taskId } });
  assert.equal(detail.data.summary.task_id, taskId);

  const page = await api.listTasks({ query: { view: 'all' } });
  assert.ok(page.data.items.some((item) => item.task_id === taskId));

  const stream = await api.streamTaskEvents({ path: { taskId } });
  assert.equal(stream.status, 200);
  const firstEvent = await stream.events.next();
  assert.equal(firstEvent.done, false);
  assert.equal(firstEvent.value.event, 'task.updated');
  assert.equal(firstEvent.value.data.task_id, taskId);
  assert.ok(firstEvent.value.id);

  const completion = await raw('POST', `/__test/tasks/${taskId}/complete`, {});
  assert.equal(completion.response.status, 200);

  const awaiting = await api.getTask({ path: { taskId } });
  assert.equal(awaiting.data.summary.display_state, 'awaiting_acceptance');
  const artifactId = awaiting.data.summary.latest_artifact.artifact_id;
  const versionNo = awaiting.data.summary.latest_artifact.version_no;

  const version = await api.getArtifactVersion({
    path: { artifactId, versionNo },
  });
  assert.equal(version.data.version_no, versionNo);

  const content = await api.getArtifactContent({
    path: { artifactId, versionNo },
  });
  assert.equal(content.status, 200);
  assert.equal(typeof content.data, 'string');
  assert.ok(content.data.includes('Mock artifact'));

  const untouched = await api.getTask({ path: { taskId } });
  assert.equal(untouched.data.summary.display_state, 'awaiting_acceptance');
});

test('client maps HTTP failures to WorkApiError with code and request id', async () => {
  const api = client();
  await assert.rejects(
    () => api.getTask({ path: { taskId: '00000000-0000-4000-8000-000000000000' } }),
    (error) => {
      assert.ok(error instanceof WorkApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'task_not_found');
      assert.equal(typeof error.requestId, 'string');
      return true;
    },
  );
});

test('missing or wrong CSRF fails client-side and server-side', async () => {
  const noToken = client({ csrfToken: null });
  await assert.rejects(
    () =>
      noToken.createInput({
        body: { client_request_id: 'req-client-0002', goal: 'x' },
      }),
    /CSRF token is required/,
  );

  const wrongToken = client({ csrfToken: 'wrong-token-000000' });
  await assert.rejects(
    () =>
      wrongToken.createInput({
        body: { client_request_id: 'req-client-0003', goal: 'x' },
      }),
    (error) => {
      assert.ok(error instanceof WorkApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'csrf_invalid');
      return true;
    },
  );
});

test('missing session is a 401 WorkApiError', async () => {
  const anonymous = createWorkClient({ baseUrl, csrfToken: csrf });
  await assert.rejects(
    () => anonymous.getBootstrap(),
    (error) => {
      assert.ok(error instanceof WorkApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'unauthorized');
      return true;
    },
  );
});

test('admin read endpoints stay within the mapped contract', async () => {
  const api = client();
  const overview = await api.getAdminOverview();
  assert.equal(overview.data.org_id, 'org1');
  assert.deepEqual(Object.keys(overview.data).sort(), [
    'audit_retention_days',
    'budget',
    'execution_enabled',
    'name',
    'org_id',
    'seats',
    'status',
  ]);

  const seats = await api.listSeats({ query: { limit: 1 } });
  assert.equal(seats.data.items.length, 1);
  assert.equal(seats.data.next_cursor, null);
  assert.deepEqual(Object.keys(seats.data.items[0]).sort(), [
    'revision',
    'role',
    'status',
    'subject_id',
    'work_seat',
  ]);

  const job = await api.createAuditExport({
    body: {
      client_request_id: 'req-export-0001',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-25T00:00:00Z',
      format: 'csv',
    },
  });
  assert.equal(job.status, 202);
  const fetched = await api.getAuditExport({ path: { exportId: job.data.id } });
  assert.equal(fetched.data.id, job.data.id);
});

test('path and body validation happens before the request', async () => {
  const api = client();
  await assert.rejects(() => api.getTask({}), /missing path parameter taskId/);
  await assert.rejects(() => api.submitTask({}), /request body is required/);
});

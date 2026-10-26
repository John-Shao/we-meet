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
  assert.equal(OPERATIONS.length, 23);
  assert.equal(new Set(OPERATIONS.map((op) => op.operationId)).size, 23);
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

async function submitted(api, suffix) {
  const input = await api.createInput({
    body: { client_request_id: `req-in-${suffix}`, goal: '整理季度复盘', media_type: 'text/markdown' },
  });
  const intent = {
    input_ref: input.data.input_ref,
    target: { kind: 'cloud', profile: 'text-v1' },
    template: null,
    permission_mode: 'ask_each',
    output: { format: 'markdown' },
  };
  const preview = await api.createTaskPreview({ body: { intent } });
  const submit = await api.submitTask({
    body: { client_request_id: `req-task-${suffix}`, preview_hash: preview.data.preview_hash, intent },
  });
  return submit.data.task;
}

test('default task title truncates by code point, never splitting surrogate pairs', async () => {
  const api = client();
  const goal = `${'😀'.repeat(19)}汉字尾巴`;
  const input = await api.createInput({
    body: { client_request_id: 'req-in-emoji-0001', goal, media_type: 'text/markdown' },
  });
  const intent = {
    input_ref: input.data.input_ref,
    target: { kind: 'cloud', profile: 'text-v1' },
    template: null,
    permission_mode: 'ask_each',
    output: { format: 'markdown' },
  };
  const preview = await api.createTaskPreview({ body: { intent } });
  const submit = await api.submitTask({
    body: { client_request_id: 'req-task-emoji-0001', preview_hash: preview.data.preview_hash, intent },
  });
  assert.equal(submit.data.task.title, `${'😀'.repeat(19)}汉`);
  assert.equal([...submit.data.task.title].length, 20);
});

test('updateTask edits title with revision check, idempotent replay and validation', async () => {
  const api = client();
  const task = await submitted(api, 'title-0001');
  const updated = await api.updateTask({
    path: { taskId: task.task_id },
    body: { client_request_id: 'req-title-0001', expected_revision: task.revision, title: '  Q3 复盘（定稿）  ' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.title, 'Q3 复盘（定稿）');
  assert.equal(updated.data.revision, task.revision + 1);

  const replay = await api.updateTask({
    path: { taskId: task.task_id },
    body: { client_request_id: 'req-title-0001', expected_revision: task.revision, title: 'Q3 复盘（定稿）' },
  });
  assert.equal(replay.data.revision, task.revision + 1);

  await assert.rejects(
    api.updateTask({
      path: { taskId: task.task_id },
      body: { client_request_id: 'req-title-0001', expected_revision: task.revision, title: '别的标题' },
    }),
    (error) => error instanceof WorkApiError && error.status === 409 && error.code === 'idempotency_key_conflict',
  );
  await assert.rejects(
    api.updateTask({
      path: { taskId: task.task_id },
      body: { client_request_id: 'req-title-0002', expected_revision: task.revision, title: '旧版本' },
    }),
    (error) => error.status === 409 && error.code === 'version_conflict' && error.data.current_revision === task.revision + 1,
  );
  for (const title of ['   ', 'x'.repeat(81), 'bad\u0007title']) {
    await assert.rejects(
      api.updateTask({
        path: { taskId: task.task_id },
        body: { client_request_id: `req-title-bad-${title.length}`, expected_revision: task.revision + 1, title },
      }),
      (error) => error.status === 422 && error.code === 'title_invalid',
    );
  }
  await assert.rejects(
    api.updateTask({
      path: { taskId: task.task_id },
      body: { client_request_id: 'req-title-0003', expected_revision: task.revision + 1, title: 'ok', goal: 'x' },
    }),
    (error) => error.status === 400,
  );
  const stream = await api.streamTaskEvents({ path: { taskId: task.task_id } });
  const seen = [];
  for await (const event of stream.events) {
    seen.push(event.data);
    if (event.data.type === 'task.updated') break;
  }
  const titleEvent = seen.find((event) => event.type === 'task.updated');
  assert.deepEqual(titleEvent.payload.fields, ['title']);
  assert.ok(!JSON.stringify(titleEvent).includes('Q3 复盘'));
});

test('content download sets safe attachment headers and writes a content-free audit row', async () => {
  const api = client();
  const task = await submitted(api, 'dl-0001');
  await raw('POST', `/__test/tasks/${task.task_id}/complete`, {});
  const detail = await api.getTask({ path: { taskId: task.task_id } });
  const { artifact_id: artifactId, version_no: versionNo } = detail.data.summary.latest_artifact;

  const inline = await api.getArtifactContent({ path: { artifactId, versionNo } });
  assert.equal(inline.headers['content-disposition'], undefined);
  assert.equal(app.state.auditLog.length, 0);

  const download = await api.getArtifactContent({
    path: { artifactId, versionNo },
    query: { disposition: 'attachment' },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.ok(
    download.headers["content-disposition"].startsWith(
      `attachment; filename="work-${artifactId.slice(0, 8)}-v${versionNo}.md"; filename*=UTF-8${"''"}`,
    ),
  );
  assert.equal(app.state.auditLog.length, 1);
  const row = app.state.auditLog[0];
  assert.equal(row.action, 'artifact.exported');
  assert.equal(row.version_no, versionNo);
  assert.ok(!JSON.stringify(row).includes('Mock artifact'));

  await assert.rejects(
    api.getArtifactContent({ path: { artifactId, versionNo }, query: { disposition: 'share' } }),
    (error) => error.status === 400,
  );
});

test('stale CSRF token is refreshed once via bootstrap, then surfaced', async () => {
  const rotate = await raw('POST', '/__test/rotate-csrf');
  assert.equal(rotate.response.status, 200);
  let refreshes = 0;
  const api = client({
    refreshCsrfToken: async () => {
      refreshes += 1;
      const boot = await createWorkClient({ baseUrl, cookie }).getBootstrap();
      return boot.data.csrf_token;
    },
  });
  const input = await api.createInput({
    body: { client_request_id: 'req-csrf-rot-01', goal: '轮换后提交', media_type: 'text/markdown' },
  });
  assert.equal(input.status, 201);
  assert.equal(refreshes, 1);

  const stuck = client({ refreshCsrfToken: async () => 'still-wrong-token-000' });
  await assert.rejects(
    stuck.createInput({ body: { client_request_id: 'req-csrf-rot-02', goal: 'x', media_type: 'text/markdown' } }),
    (error) => error.status === 403 && error.code === 'csrf_invalid',
  );
});

test('deleteTask requires a quiescent task, is idempotent and makes content unreadable', async () => {
  const api = client();
  const task = await submitted(api, 'del-0001');
  await assert.rejects(
    api.deleteTask({ path: { taskId: task.task_id }, query: { expected_revision: task.revision } }),
    (error) => error.status === 409 && error.code === 'run_not_quiescent',
  );
  await raw('POST', `/__test/tasks/${task.task_id}/complete`, {});
  const detail = await api.getTask({ path: { taskId: task.task_id } });
  const { artifact_id: artifactId, version_no: versionNo } = detail.data.summary.latest_artifact;
  const revision = detail.data.summary.revision;

  await assert.rejects(
    api.deleteTask({ path: { taskId: task.task_id }, query: { expected_revision: revision - 1 } }),
    (error) => error.status === 409 && error.code === 'version_conflict',
  );
  await assert.rejects(
    api.deleteTask({ path: { taskId: task.task_id } }),
    (error) => error.status === 400 && error.code === 'invalid_request',
  );
  const deleted = await api.deleteTask({ path: { taskId: task.task_id }, query: { expected_revision: revision } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.content_purge, 'scheduled');
  const again = await api.deleteTask({ path: { taskId: task.task_id }, query: { expected_revision: revision } });
  assert.deepEqual(again.data, deleted.data);

  await assert.rejects(api.getTask({ path: { taskId: task.task_id } }), (error) => error.status === 404);
  await assert.rejects(
    api.getArtifactContent({ path: { artifactId, versionNo } }),
    (error) => error.status === 404,
  );
  const page = await api.listTasks({ query: { view: 'all' } });
  assert.ok(!page.data.items.some((item) => item.task_id === task.task_id));
  const row = app.state.auditLog.find((entry) => entry.action === 'task.deleted');
  assert.equal(row.target_id, task.task_id);
  await assert.rejects(
    client({ csrfToken: 'wrong-token-0000000' }).deleteTask({
      path: { taskId: task.task_id },
      query: { expected_revision: revision },
    }),
    (error) => error.status === 403,
  );
});

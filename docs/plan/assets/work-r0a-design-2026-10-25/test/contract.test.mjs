import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkServer } from '../mock-server.mjs';

const app = createWorkServer();
const cookie = 'we_meet_session=test-session';
const csrf = 'test-csrf-token-123456';
let baseUrl;

async function request(method, path, { body, headers = {}, useCsrf = true } = {}) {
  const requestHeaders = { Cookie: cookie, ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (useCsrf && method !== 'GET') requestHeaders['X-CSRF-Token'] = csrf;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // SSE / plain text responses stay as text.
  }
  return { response, data, text };
}

async function createInput(goal, background = '', clientRequestId = 'req-input-0001') {
  const result = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: clientRequestId, goal, background, media_type: 'text/markdown' },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.data;
}

async function previewTask(inputRef, overrides = {}) {
  const intent = {
    input_ref: inputRef,
    target: { kind: 'cloud', profile: 'text-v1' },
    template: { id: 'tpl-report', version: 1 },
    permission_mode: 'ask_each',
    output: { format: 'markdown', length: 'medium' },
    ...overrides,
  };
  const result = await request('POST', '/work/v1/task-previews', {
    body: { intent },
    useCsrf: false,
  });
  return { result, intent };
}

async function createTask(goal = '写一份会员改版方案初稿', clientRequestId = 'req-task-0001') {
  const input = await createInput(goal, '背景：会员增长放缓。', `req-input-${clientRequestId}`);
  const { result: preview, intent } = await previewTask(input.input_ref);
  assert.equal(preview.response.status, 200, preview.text);
  const submit = await request('POST', '/work/v1/tasks', {
    body: {
      client_request_id: clientRequestId,
      preview_hash: preview.data.preview_hash,
      intent,
    },
  });
  assert.equal(submit.response.status, 202, submit.text);
  return {
    input,
    preview: preview.data,
    intent,
    submit: submit.data,
    taskId: submit.data.task.task_id,
    runId: submit.data.run.id,
  };
}

async function getTask(taskId) {
  const result = await request('GET', `/work/v1/tasks/${taskId}`);
  assert.equal(result.response.status, 200, result.text);
  return result.data;
}

async function completeTask(taskId) {
  const result = await request('POST', `/__test/tasks/${taskId}/complete`, { body: {} });
  assert.equal(result.response.status, 200, result.text);
  return result.data;
}

test.before(async () => {
  const port = await app.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await app.close();
});

test.beforeEach(async () => {
  const result = await request('POST', '/__test/reset');
  assert.equal(result.response.status, 200, result.text);
});

test('bootstrap, templates, session and CSRF', async () => {
  const bootstrap = await request('GET', '/work/v1/bootstrap');
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.data.csrf_token, csrf);
  assert.deepEqual(bootstrap.data.phases, ['R0a']);
  assert.deepEqual(bootstrap.data.allowed_permission_modes, ['ask_each', 'auto_readonly']);
  assert.equal(bootstrap.data.limits.max_goal_chars, 2000);
  assert.match(bootstrap.response.headers.get('set-cookie') ?? '', /we_meet_session=test-session/);

  const templates = await request('GET', '/work/v1/templates');
  assert.equal(templates.response.status, 200);
  assert.equal(templates.data.items.length, 3);
  assert.ok(templates.data.items.every((item) => item.content_hash.startsWith('sha256:')));

  const noCsrf = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: 'req-csrf-0001', goal: 'x' },
    useCsrf: false,
  });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.data.code, 'csrf_invalid');

  const noSession = await fetch(`${baseUrl}/work/v1/tasks`);
  assert.equal(noSession.status, 401);
  const unauthorized = await noSession.json();
  assert.equal(unauthorized.code, 'unauthorized');
  assert.equal(typeof unauthorized.retryable, 'boolean');
  assert.ok(unauthorized.correlation_id);

  const missing = await request('GET', '/work/v1/tasks/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.code, 'task_not_found');
});

test('input idempotency, preview, submit idempotency and R0a scope', async () => {
  const input = await createInput('写一份会员改版方案初稿', '背景：会员增长放缓。', 'req-input-1001');
  const duplicate = await createInput('写一份会员改版方案初稿', '背景：会员增长放缓。', 'req-input-1001');
  assert.equal(duplicate.input_ref, input.input_ref);

  const conflict = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: 'req-input-1001', goal: '不同的目标' },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.code, 'idempotency_key_conflict');

  const { result: preview, intent } = await previewTask(input.input_ref);
  assert.equal(preview.response.status, 200, preview.text);
  assert.ok(preview.data.boundary_summary.some((line) => line.includes('云端')));
  assert.ok(preview.data.boundary_summary.some((line) => line.includes('不访问本机')));
  assert.ok(preview.data.cost_upper_bound.amount_cents > 0);
  assert.equal(preview.data.effective_permission_mode, 'ask_each');

  const submit = await request('POST', '/work/v1/tasks', {
    body: {
      client_request_id: 'req-task-1001',
      preview_hash: preview.data.preview_hash,
      intent,
    },
  });
  assert.equal(submit.response.status, 202, submit.text);
  assert.equal(submit.data.task.display_state, 'queued');
  assert.equal(submit.data.run.state, 'queued');
  const taskId = submit.data.task.task_id;

  const duplicateSubmit = await request('POST', '/work/v1/tasks', {
    body: {
      client_request_id: 'req-task-1001',
      preview_hash: preview.data.preview_hash,
      intent,
    },
  });
  assert.equal(duplicateSubmit.response.status, 202);
  assert.equal(duplicateSubmit.data.task.task_id, taskId);

  const list = await request('GET', '/work/v1/tasks?view=running');
  assert.equal(list.response.status, 200);
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].task_id, taskId);

  const detail = await getTask(taskId);
  assert.equal(detail.goal, '写一份会员改版方案初稿');
  assert.equal(detail.background, '背景：会员增长放缓。');
  assert.equal(detail.template.id, 'tpl-report');
  assert.deepEqual(detail.summary.latest_run.state, 'queued');

  const suitePreview = await previewTask(input.input_ref, {
    suite: { id: 'suite-x', version: 1 },
  });
  assert.equal(suitePreview.result.response.status, 422);
  assert.equal(suitePreview.result.data.code, 'scope_unavailable');

  const planPreview = await previewTask(input.input_ref, {
    permission_mode: 'plan_then_run',
  });
  assert.equal(planPreview.result.response.status, 422);
  assert.equal(planPreview.result.data.code, 'permission_mode_unavailable');

  const stale = await request('POST', '/work/v1/tasks', {
    body: {
      client_request_id: 'req-task-1002',
      preview_hash: 'sha256:stale',
      intent,
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.code, 'preview_stale');
});

test('worker completion, artifact content, inbox and acceptance', async () => {
  const { taskId } = await createTask('写一份会员改版方案初稿', 'req-task-2001');
  const completed = await completeTask(taskId);
  assert.equal(completed.task.display_state, 'awaiting_acceptance');
  assert.equal(completed.task.pending_acceptance, true);
  assert.equal(completed.task.budget.settled_cents, 80);
  assert.equal(completed.task.budget.reserved_cents, 0);

  const inbox = await request('GET', '/work/v1/inbox');
  assert.equal(inbox.response.status, 200);
  assert.equal(inbox.data.items.length, 1);
  assert.equal(inbox.data.items[0].type, 'acceptance_required');
  assert.equal(inbox.data.items[0].task_id, taskId);

  const detail = await getTask(taskId);
  const artifactId = detail.summary.latest_artifact.artifact_id;
  const versionNo = detail.summary.latest_artifact.version_no;
  const version = await request('GET', `/work/v1/artifacts/${artifactId}/versions/${versionNo}`);
  assert.equal(version.response.status, 200);
  const content = await request('GET', new URL(version.data.content_url).pathname);
  assert.equal(content.response.status, 200);
  assert.match(content.text, /Mock artifact/);

  const accept = await request('POST', `/work/v1/tasks/${taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-2001',
      expected_revision: detail.summary.revision,
      artifact_id: artifactId,
      version_no: versionNo,
    },
  });
  assert.equal(accept.response.status, 200, accept.text);
  assert.equal(accept.data.task.display_state, 'completed');
  assert.equal(accept.data.acceptance.task_revision, detail.summary.revision + 1);

  const duplicate = await request('POST', `/work/v1/tasks/${taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-2002',
      expected_revision: detail.summary.revision + 1,
      artifact_id: artifactId,
      version_no: versionNo,
    },
  });
  assert.equal(duplicate.response.status, 409);

  const inboxAfter = await request('GET', '/work/v1/inbox');
  assert.equal(inboxAfter.data.items.length, 0);

  // Acceptance by completion reason is also a valid R0a path.
  const second = await createTask('只确认完成、不采纳文件', 'req-task-2002');
  await completeTask(second.taskId);
  const secondDetail = await getTask(second.taskId);
  const reasonAccept = await request('POST', `/work/v1/tasks/${second.taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-2003',
      expected_revision: secondDetail.summary.revision,
      completion_reason: 'no artifact required',
    },
  });
  assert.equal(reasonAccept.response.status, 200, reasonAccept.text);
  assert.equal(reasonAccept.data.task.display_state, 'completed');
  assert.equal(reasonAccept.data.acceptance.completion_reason, 'no artifact required');
});

test('user edit creates a new immutable version', async () => {
  const { taskId } = await createTask('写一份会员改版方案初稿', 'req-task-3001');
  await completeTask(taskId);
  const detail = await getTask(taskId);
  const artifactId = detail.summary.latest_artifact.artifact_id;

  const edit = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: {
      client_request_id: 'req-edit-3001',
      base_version_no: 1,
      media_type: 'text/markdown',
      content: '# 会员改版方案（用户编辑）\n',
    },
  });
  assert.equal(edit.response.status, 201, edit.text);
  assert.equal(edit.data.version_no, 2);
  assert.equal(edit.data.state, 'published');

  const content = await request('GET', new URL(edit.data.content_url).pathname);
  assert.match(content.text, /用户编辑/);

  const staleBase = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: {
      client_request_id: 'req-edit-3002',
      base_version_no: 1,
      content: 'stale base',
    },
  });
  assert.equal(staleBase.response.status, 409);
  assert.equal(staleBase.data.code, 'version_conflict');
});

test('cancel, retry and SSE recovery', async () => {
  const { taskId, runId } = await createTask('取消路径任务', 'req-task-4001');

  const cancel = await request('POST', `/work/v1/runs/${runId}/cancel`, {
    body: { client_request_id: 'req-cancel-4001', reason: 'user canceled' },
  });
  assert.equal(cancel.response.status, 202);
  assert.equal(cancel.data.state, 'cancel_requested');

  const cancelAgain = await request('POST', `/work/v1/runs/${runId}/cancel`, {
    body: { client_request_id: 'req-cancel-4002', reason: 'user canceled again' },
  });
  assert.equal(cancelAgain.response.status, 202);
  assert.equal(cancelAgain.data.state, 'cancel_requested');

  const finished = await request('POST', `/__test/tasks/${taskId}/finish-cancel`, { body: {} });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.data.task.display_state, 'run_canceled');

  const retry = await request('POST', `/work/v1/tasks/${taskId}/runs`, {
    body: { client_request_id: 'req-retry-4001', target: { kind: 'cloud', profile: 'text-v1' } },
  });
  assert.equal(retry.response.status, 202, retry.text);
  assert.equal(retry.data.run.attempt_no, 2);
  assert.equal(retry.data.task.display_state, 'queued');

  const firstStream = await request('GET', `/work/v1/tasks/${taskId}/events`);
  assert.equal(firstStream.response.status, 200);
  assert.match(firstStream.response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(firstStream.text, /task\.submitted/);
  const eventId = firstStream.text.match(/^id: (.+)$/m)?.[1];
  assert.ok(eventId);

  const reconnect = await request('GET', `/work/v1/tasks/${taskId}/events`, {
    headers: { 'Last-Event-ID': eventId },
  });
  assert.equal(reconnect.response.status, 200);
  assert.ok(!reconnect.text.includes(eventId));

  const expired = await request('GET', `/work/v1/tasks/${taskId}/events`, {
    headers: { 'Last-Event-ID': 'expired' },
  });
  assert.equal(expired.response.status, 409);
  assert.equal(expired.data.code, 'resync_required');
});

test('admin read-only and audit export', async () => {
  const overview = await request('GET', '/work/v1/admin/overview');
  assert.equal(overview.response.status, 200);
  assert.equal(overview.data.org_id, 'org1');
  assert.equal(overview.data.audit_retention_days, 365);
  assert.ok(!('goal' in overview.data));
  assert.ok(!('email' in overview.data));

  const seats = await request('GET', '/work/v1/admin/seats');
  assert.equal(seats.response.status, 200);
  assert.equal(seats.data.items.length, 1);

  const exportJob = await request('POST', '/work/v1/admin/audit-exports', {
    body: {
      client_request_id: 'req-audit-5001',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-25T23:59:59Z',
      format: 'csv',
    },
  });
  assert.equal(exportJob.response.status, 202, exportJob.text);
  assert.equal(exportJob.data.status, 'ready');

  const fetched = await request('GET', `/work/v1/admin/audit-exports/${exportJob.data.id}`);
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.data.id, exportJob.data.id);
});

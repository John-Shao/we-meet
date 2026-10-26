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

function currentPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function exportRequest(clientRequestId) {
  return {
    client_request_id: clientRequestId,
    range_from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    range_to: new Date().toISOString(),
    format: 'csv',
  };
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

  const previewNoCsrf = await request('POST', '/work/v1/task-previews', {
    body: { intent: {} },
    useCsrf: false,
  });
  assert.equal(previewNoCsrf.response.status, 403);
  assert.equal(previewNoCsrf.data.code, 'csrf_invalid');

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
  assert.ok(preview.data.token_upper_bound.amount_tokens > 0);
  assert.match(preview.data.token_upper_bound.note, /云厂商账单/);
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
  assert.equal(completed.task.quota.settled_tokens, 80);
  assert.equal(completed.task.quota.reserved_tokens, 0);

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

  const acceptReplay = await request('POST', `/work/v1/tasks/${taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-2001',
      expected_revision: detail.summary.revision,
      artifact_id: artifactId,
      version_no: versionNo,
    },
  });
  assert.equal(acceptReplay.response.status, 200, acceptReplay.text);
  assert.equal(acceptReplay.data.acceptance.id, accept.data.acceptance.id);

  const acceptKeyReuse = await request('POST', `/work/v1/tasks/${taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-2001',
      expected_revision: detail.summary.revision,
      completion_reason: 'different body',
    },
  });
  assert.equal(acceptKeyReuse.response.status, 409);
  assert.equal(acceptKeyReuse.data.code, 'idempotency_key_conflict');

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

  const editReplay = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: {
      client_request_id: 'req-edit-3001',
      base_version_no: 1,
      media_type: 'text/markdown',
      content: '# 会员改版方案（用户编辑）\n',
    },
  });
  assert.equal(editReplay.response.status, 201, editReplay.text);
  assert.equal(editReplay.data.version_no, 2);

  const editKeyReuse = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: { client_request_id: 'req-edit-3001', base_version_no: 2, content: 'other' },
  });
  assert.equal(editKeyReuse.response.status, 409);
  assert.equal(editKeyReuse.data.code, 'idempotency_key_conflict');

  const noBase = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: { client_request_id: 'req-edit-3003', content: 'no base' },
  });
  assert.equal(noBase.response.status, 400);
  assert.equal(noBase.data.code, 'invalid_request');

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

test('artifact versions are read-only after completion or a canceled latest run', async () => {
  const { taskId } = await createTask('成果只读路径', 'req-task-5001');
  await completeTask(taskId);
  const detail = await getTask(taskId);
  const artifactId = detail.summary.latest_artifact.artifact_id;
  const versionNo = detail.summary.latest_artifact.version_no;

  const earlyRetry = await request('POST', `/work/v1/tasks/${taskId}/runs`, {
    body: {
      client_request_id: 'req-retry-5001',
      expected_revision: detail.summary.revision,
      target: { kind: 'cloud', profile: 'text-v1' },
    },
  });
  assert.equal(earlyRetry.response.status, 409);
  assert.equal(earlyRetry.data.code, 'task_not_runnable');

  const accepted = await request('POST', `/work/v1/tasks/${taskId}/acceptances`, {
    body: {
      client_request_id: 'req-accept-5001',
      expected_revision: detail.summary.revision,
      artifact_id: artifactId,
      version_no: versionNo,
    },
  });
  assert.equal(accepted.response.status, 200, accepted.text);

  const afterCompletion = await request('POST', `/work/v1/artifacts/${artifactId}/versions`, {
    body: {
      client_request_id: 'req-version-5001',
      base_version_no: versionNo,
      content: 'after completion',
    },
  });
  assert.equal(afterCompletion.response.status, 409);
  assert.equal(afterCompletion.data.code, 'artifact_read_only');

  // Cancel-after-publish edge: the mock has no command for it, so set the DB-shaped
  // state that D1 covers in r0a-schema-smoke.sql.
  const second = await createTask('取消后只读路径', 'req-task-5002');
  await completeTask(second.taskId);
  const secondDetail = await getTask(second.taskId);
  const secondArtifact = secondDetail.summary.latest_artifact.artifact_id;
  const secondVersion = secondDetail.summary.latest_artifact.version_no;
  const task = app.state.tasks.get(second.taskId);
  const latestRun = task.runs.get(task.latestRunId);
  task.state = 'open';
  task.activeRunId = null;
  latestRun.state = 'canceled';
  latestRun.terminalReason = 'user_requested';

  const afterCancel = await request('POST', `/work/v1/artifacts/${secondArtifact}/versions`, {
    body: {
      client_request_id: 'req-version-5002',
      base_version_no: secondVersion,
      content: 'after cancel',
    },
  });
  assert.equal(afterCancel.response.status, 409);
  assert.equal(afterCancel.data.code, 'artifact_read_only');
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

  const canceledDetail = await getTask(taskId);
  const noTarget = await request('POST', `/work/v1/tasks/${taskId}/runs`, {
    body: {
      client_request_id: 'req-retry-no-target',
      expected_revision: canceledDetail.summary.revision,
    },
  });
  assert.equal(noTarget.response.status, 422);
  assert.equal(noTarget.data.code, 'execution_target_unavailable');

  const staleRetry = await request('POST', `/work/v1/tasks/${taskId}/runs`, {
    body: {
      client_request_id: 'req-retry-4000',
      expected_revision: canceledDetail.summary.revision - 1,
      target: { kind: 'cloud', profile: 'text-v1' },
    },
  });
  assert.equal(staleRetry.response.status, 409);
  assert.equal(staleRetry.data.code, 'version_conflict');

  const retryBody = {
    client_request_id: 'req-retry-4001',
    expected_revision: canceledDetail.summary.revision,
    target: { kind: 'cloud', profile: 'text-v1' },
  };
  const retry = await request('POST', `/work/v1/tasks/${taskId}/runs`, { body: retryBody });
  assert.equal(retry.response.status, 202, retry.text);
  assert.equal(retry.data.run.attempt_no, 2);
  assert.equal(retry.data.task.display_state, 'queued');

  const retryReplay = await request('POST', `/work/v1/tasks/${taskId}/runs`, { body: retryBody });
  assert.equal(retryReplay.response.status, 202, retryReplay.text);
  assert.equal(retryReplay.data.run.id, retry.data.run.id);

  const retryKeyReuse = await request('POST', `/work/v1/tasks/${taskId}/runs`, {
    body: { ...retryBody, reason: 'changed' },
  });
  assert.equal(retryKeyReuse.response.status, 409);
  assert.equal(retryKeyReuse.data.code, 'idempotency_key_conflict');

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

test('admin read comes from the directory projection and the token quota ledger', async () => {
  for (const [subject, member] of [
    ['user2', { role: 'admin', work_seat: true, status: 'active' }],
    ['user3', { role: 'member', work_seat: true, status: 'left' }],
    ['user4', { role: 'member', work_seat: true, status: 'active' }],
  ]) {
    const synced = await request('POST', '/__test/directory/sync-member', {
      body: { subject_id: subject, revision: 1, ...member },
    });
    assert.equal(synced.response.status, 200, synced.text);
  }

  const overview = await request('GET', '/work/v1/admin/overview');
  assert.equal(overview.response.status, 200, overview.text);
  assert.deepEqual(overview.data.seats, { total: 3, active: 3 });
  assert.equal(overview.data.quota.enforcement, 'soft');
  assert.equal(typeof overview.data.quota.limit_tokens, 'number');
  assert.equal(typeof overview.data.quota.settled_tokens, 'number');
  assert.equal(overview.data.quota_period_id, currentPeriod());
  assert.equal(typeof overview.data.run_cap_tokens, 'number');
  assert.equal(overview.data.org_revision, 0);
  assert.ok(!('goal' in overview.data));
  assert.ok(!('email' in overview.data));

  // keyset 分页与 work.list_seats 同构；总数不受分页影响。
  const page1 = await request('GET', '/work/v1/admin/seats?limit=1');
  assert.deepEqual(page1.data.items.map((seat) => seat.subject_id), ['user1']);
  assert.equal(page1.data.next_cursor, 'user1');
  const page2 = await request('GET', '/work/v1/admin/seats?limit=1&cursor=user1');
  assert.deepEqual(page2.data.items.map((seat) => seat.subject_id), ['user2']);
  assert.equal(page2.data.next_cursor, 'user2');
  const page3 = await request('GET', '/work/v1/admin/seats?limit=1&cursor=user2');
  assert.deepEqual(page3.data.items.map((seat) => seat.subject_id), ['user4']);
  assert.equal(page3.data.next_cursor, null);
  const resynced = await request('GET', '/work/v1/admin/overview');
  assert.deepEqual(resynced.data.seats, { total: 3, active: 3 });

  // 修订号回退是适配器/程序错误：公开面只说服务降级，不暴露目录细节。
  const stale = await request('POST', '/__test/directory/sync-member', {
    body: { subject_id: 'user2', role: 'owner', work_seat: true, status: 'active', revision: 1 },
  });
  assert.equal(stale.response.status, 503, stale.text);
  assert.equal(stale.data.code, 'service_degraded');

  // 非管理员读治理信息与创建导出作业都被拒。
  await request('POST', '/__test/subject', { body: { subject_id: 'user4' } });
  const forbiddenRead = await request('GET', '/work/v1/admin/overview');
  assert.equal(forbiddenRead.response.status, 403, forbiddenRead.text);
  assert.equal(forbiddenRead.data.code, 'admin_access_denied');
  const seatsDenied = await request('GET', '/work/v1/admin/seats');
  assert.equal(seatsDenied.data.code, 'admin_access_denied');
  const exportDenied = await request('POST', '/work/v1/admin/audit-exports', {
    body: exportRequest('req-audit-denied'),
  });
  assert.equal(exportDenied.response.status, 403);
  assert.equal(exportDenied.data.code, 'admin_access_denied');
});

test('directory projection gates new work before any task state is written', async () => {
  await request('POST', '/__test/directory/sync-member', {
    body: { subject_id: 'user9', role: 'member', work_seat: false, status: 'active', revision: 1 },
  });
  await request('POST', '/__test/subject', { body: { subject_id: 'user9' } });
  const noSeat = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: 'req-input-noseat', goal: '写一份方案', background: '', media_type: 'text/markdown' },
  });
  assert.equal(noSeat.response.status, 403, noSeat.text);
  assert.equal(noSeat.data.code, 'work_seat_required');

  await request('POST', '/__test/directory/sync-member', {
    body: { subject_id: 'user10', role: 'viewer', work_seat: true, status: 'active', revision: 1 },
  });
  await request('POST', '/__test/subject', { body: { subject_id: 'user10' } });
  const viewer = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: 'req-input-viewer', goal: '写一份方案', background: '', media_type: 'text/markdown' },
  });
  assert.equal(viewer.data.code, 'work_seat_required');

  await request('POST', '/__test/subject', { body: { subject_id: 'user1' } });
  const paused = await request('POST', '/__test/directory/sync-org', {
    body: { name: '试点组织', status: 'active', execution_enabled: false, revision: 1 },
  });
  assert.equal(paused.response.status, 200, paused.text);
  const orgBlocked = await request('POST', '/work/v1/inputs', {
    body: { client_request_id: 'req-input-paused', goal: '写一份方案', background: '', media_type: 'text/markdown' },
  });
  assert.equal(orgBlocked.response.status, 403, orgBlocked.text);
  assert.equal(orgBlocked.data.code, 'org_execution_unavailable');
});

test('audit export is asynchronous and its download token is one-time', async () => {
  const { taskId } = await createTask();
  assert.ok(taskId);
  // 先跑完再删除：删除会写审计行，导出必须读得到它（只有元数据，不含正文）。
  await request('POST', `/__test/tasks/${taskId}/complete`, { body: {} });
  const detail = await request('GET', `/work/v1/tasks/${taskId}`);
  const removed = await request('DELETE',
    `/work/v1/tasks/${taskId}?expected_revision=${detail.data.summary.revision}`);
  assert.equal(removed.response.status, 200, removed.text);
  const rangeTo = new Date().toISOString();
  const rangeFrom = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const created = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-5001', range_from: rangeFrom, range_to: rangeTo, format: 'csv' },
  });
  assert.equal(created.response.status, 202, created.text);
  assert.equal(created.data.status, 'queued');
  assert.equal(created.data.download_available, false);
  assert.equal(created.data.row_count, null);
  assert.deepEqual(Object.keys(created.data).sort(), [
    'bytes', 'download_available', 'downloaded_at', 'error_code', 'expires_at', 'format', 'id',
    'range_from', 'range_to', 'ready_at', 'requested_at', 'requested_by', 'row_count', 'status',
  ]);

  const replay = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-5001', range_from: rangeFrom, range_to: rangeTo, format: 'csv' },
  });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.data.id, created.data.id);
  const conflict = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-5001', range_from: rangeFrom, range_to: rangeTo, format: 'json' },
  });
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.data.code, 'idempotency_key_conflict');

  for (const bad of [
    { range_from: rangeTo, range_to: rangeFrom },
    { range_from: new Date(Date.now() - 500 * 86_400_000).toISOString(), range_to: rangeFrom },
    { range_from: rangeFrom, range_to: new Date(Date.now() + 86_400_000).toISOString() },
  ]) {
    const invalid = await request('POST', '/work/v1/admin/audit-exports', {
      body: { client_request_id: 'req-audit-range', ...bad, format: 'csv' },
    });
    assert.equal(invalid.response.status, 422, invalid.text);
    assert.equal(invalid.data.code, 'audit_export_range_invalid');
  }

  const pending = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}`);
  assert.equal(pending.data.status, 'queued');
  const earlyTicket = await request('POST',
    `/work/v1/admin/audit-exports/${created.data.id}/download-ticket`, { body: {} });
  assert.equal(earlyTicket.response.status, 409, earlyTicket.text);
  assert.equal(earlyTicket.data.code, 'audit_export_not_ready');

  const run = await request('POST', '/__test/export-worker/run', { body: {} });
  assert.equal(run.response.status, 200, run.text);
  const ready = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}`);
  assert.equal(ready.data.status, 'ready');
  assert.equal(ready.data.download_available, true);
  assert.ok(ready.data.row_count >= 1);
  assert.ok(!('content_ref' in ready.data));

  const ticket = await request('POST',
    `/work/v1/admin/audit-exports/${created.data.id}/download-ticket`, { body: { ttl_seconds: 300 } });
  assert.equal(ticket.response.status, 200, ticket.text);
  assert.match(ticket.data.token, /^[0-9a-f]{48}$/);
  const content = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}/content`, {
    headers: { 'X-Download-Token': ticket.data.token },
  });
  assert.equal(content.response.status, 200, content.text);
  assert.equal(content.response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(content.response.headers.get('cache-control'), 'no-store');
  assert.match(content.data, /^action,actor_subject_id,target_type,target_id,created_at/);
  assert.ok(!content.data.includes('写一份会员改版方案初稿'));

  const reuse = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}/content`, {
    headers: { 'X-Download-Token': ticket.data.token },
  });
  assert.equal(reuse.response.status, 403, reuse.text);
  assert.equal(reuse.data.code, 'download_token_invalid');
  const noToken = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}/content`);
  assert.equal(noToken.response.status, 403);
  assert.equal(noToken.data.code, 'download_token_invalid');
  const reissue = await request('POST',
    `/work/v1/admin/audit-exports/${created.data.id}/download-ticket`, { body: {} });
  assert.equal(reissue.response.status, 409, reissue.text);
  assert.equal(reissue.data.code, 'audit_export_already_downloaded');
  const afterDownload = await request('GET', `/work/v1/admin/audit-exports/${created.data.id}`);
  assert.equal(afterDownload.data.download_available, false);
  assert.ok(afterDownload.data.downloaded_at);
});

test('audit export failure, expired content and expired ticket are distinguishable', async () => {
  const rangeTo = new Date().toISOString();
  const rangeFrom = new Date(Date.now() - 10 * 86_400_000).toISOString();

  const failed = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-fail', range_from: rangeFrom, range_to: rangeTo, format: 'json' },
  });
  const failRun = await request('POST', '/__test/export-worker/run', {
    body: { fail_with: 'content_store_unavailable' },
  });
  assert.equal(failRun.response.status, 200, failRun.text);
  const failedJob = await request('GET', `/work/v1/admin/audit-exports/${failed.data.id}`);
  assert.equal(failedJob.data.status, 'failed');
  assert.equal(failedJob.data.error_code, 'content_store_unavailable');
  const stillFailed = await request('GET', `/work/v1/admin/audit-exports/${failed.data.id}`);
  assert.equal(stillFailed.data.status, 'failed');

  const expiring = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-expire', range_from: rangeFrom, range_to: rangeTo, format: 'csv' },
  });
  await request('POST', '/__test/export-worker/run', { body: { ttl_seconds: 300 } });
  const expired = await request('POST', `/__test/export/${expiring.data.id}/expire`, { body: {} });
  assert.equal(expired.response.status, 200, expired.text);
  assert.equal(expired.data.status, 'expired');
  assert.equal(expired.data.download_available, false);
  const ticketAfterExpiry = await request('POST',
    `/work/v1/admin/audit-exports/${expiring.data.id}/download-ticket`, { body: {} });
  assert.equal(ticketAfterExpiry.response.status, 410, ticketAfterExpiry.text);
  assert.equal(ticketAfterExpiry.data.code, 'audit_export_expired');

  const fresh = await request('POST', '/work/v1/admin/audit-exports', {
    body: { client_request_id: 'req-audit-ticket-expire', range_from: rangeFrom, range_to: rangeTo, format: 'csv' },
  });
  await request('POST', '/__test/export-worker/run', { body: {} });
  const ticket = await request('POST',
    `/work/v1/admin/audit-exports/${fresh.data.id}/download-ticket`, { body: { ttl_seconds: 60 } });
  assert.equal(ticket.response.status, 200, ticket.text);
  await request('POST', `/__test/export/${fresh.data.id}/expire-ticket`, { body: {} });
  const late = await request('GET', `/work/v1/admin/audit-exports/${fresh.data.id}/content`, {
    headers: { 'X-Download-Token': ticket.data.token },
  });
  assert.equal(late.response.status, 410, late.text);
  assert.equal(late.data.code, 'download_token_expired');

  const missing = await request('GET', '/work/v1/admin/audit-exports/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.code, 'audit_export_not_found');
});

// ---------------------------------------------------------------------------
// D-08: provider access config (write-only secrets) and token usage
// ---------------------------------------------------------------------------
async function actAs(subjectId, member) {
  if (member) {
    const synced = await request('POST', '/__test/directory/sync-member', {
      body: { subject_id: subjectId, revision: 1, ...member },
    });
    assert.equal(synced.response.status, 200, synced.text);
  }
  const switched = await request('POST', '/__test/subject', { body: { subject_id: subjectId } });
  assert.equal(switched.response.status, 200, switched.text);
}

async function createStsCredential(provider = 'aliyun') {
  const created = await request('POST', '/work/v1/admin/provider-credentials', {
    body: { provider, mode: 'sts_role', role_ref: `acs:ram::123456:role/${provider}-work` },
  });
  assert.equal(created.response.status, 201, created.text);
  return created.data;
}

async function createManagedCredential(provider, apiKey) {
  const created = await request('POST', '/work/v1/admin/provider-credentials', {
    body: { provider, mode: 'managed_key', api_key: apiKey },
  });
  assert.equal(created.response.status, 201, created.text);
  return created.data;
}

function configBody(provider, credentialId, expectedRevision, model = 'qwen3.8-flash') {
  return {
    provider,
    model,
    region: 'cn-beijing',
    endpoint: 'https://dashscope.aliyuncs.com',
    credential_mode: 'sts_role',
    credential_id: credentialId,
    expected_revision: expectedRevision,
  };
}

test('provider config is owner-only, versioned and never echoes a secret', async () => {
  await actAs('user2', { role: 'admin', work_seat: true, status: 'active' });
  const deniedCreate = await request('POST', '/work/v1/admin/provider-credentials', {
    body: { provider: 'aliyun', mode: 'sts_role', role_ref: 'acs:ram::1:role/x' },
  });
  assert.equal(deniedCreate.response.status, 403, deniedCreate.text);
  assert.equal(deniedCreate.data.code, 'admin_access_denied');
  const deniedSet = await request('PUT', '/work/v1/admin/provider-config', {
    body: configBody('aliyun', '00000000-0000-4000-8000-000000000000', 0),
  });
  assert.equal(deniedSet.response.status, 403, deniedSet.text);

  await actAs('user1');
  const before = await request('GET', '/work/v1/admin/provider-config');
  assert.equal(before.response.status, 404);
  assert.equal(before.data.code, 'not_found');

  const sts = await createStsCredential();
  assert.deepEqual(Object.keys(sts).sort(), [
    'created_at', 'credential_id', 'fingerprint', 'key_version', 'mode', 'provider', 'rotated_at', 'state',
  ]);
  const duplicate = await request('POST', '/work/v1/admin/provider-credentials', {
    body: { provider: 'aliyun', mode: 'sts_role', role_ref: 'acs:ram::1:role/other' },
  });
  assert.equal(duplicate.response.status, 409, duplicate.text);
  assert.equal(duplicate.data.code, 'version_conflict');

  const set1 = await request('PUT', '/work/v1/admin/provider-config', {
    body: configBody('aliyun', sts.credential_id, 0),
  });
  assert.equal(set1.response.status, 200, set1.text);
  assert.equal(set1.data.revision, 1);
  assert.equal(set1.data.credential.state, 'active');
  assert.ok(!('api_key' in set1.data.credential));
  assert.ok(!set1.text.includes('role_ref'));

  const stale = await request('PUT', '/work/v1/admin/provider-config', {
    body: configBody('aliyun', sts.credential_id, 0),
  });
  assert.equal(stale.response.status, 409, stale.text);
  assert.equal(stale.data.code, 'version_conflict');

  const rotateSts = await request('POST',
    `/work/v1/admin/provider-credentials/${sts.credential_id}/rotate`, { body: { api_key: 'sk-sts-not-allowed' } });
  assert.equal(rotateSts.response.status, 400, rotateSts.text);
  assert.equal(rotateSts.data.code, 'invalid_request');

  const managed = await createManagedCredential('deepseek', 'sk-deepseek-test-0001');
  assert.match(managed.fingerprint, /^sha256:/);
  const set2 = await request('PUT', '/work/v1/admin/provider-config', {
    body: {
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash-1017',
      region: 'cn-beijing',
      endpoint: 'https://api.deepseek.com',
      credential_mode: 'managed_key',
      credential_id: managed.credential_id,
      expected_revision: 1,
    },
  });
  assert.equal(set2.response.status, 200, set2.text);
  assert.equal(set2.data.revision, 2);
  assert.ok(!set2.text.includes('sk-deepseek-test-0001'));

  const rotated = await request('POST',
    `/work/v1/admin/provider-credentials/${managed.credential_id}/rotate`,
    { body: { api_key: 'sk-deepseek-test-0002' } });
  assert.equal(rotated.response.status, 200, rotated.text);
  assert.equal(rotated.data.key_version, 2);
  assert.notEqual(rotated.data.fingerprint, managed.fingerprint);
  const current = await request('GET', '/work/v1/admin/provider-config');
  assert.equal(current.data.credential.key_version, 2);

  const revoked = await request('POST',
    `/work/v1/admin/provider-credentials/${managed.credential_id}/revoke`, { body: { reason: 'lost key' } });
  assert.equal(revoked.response.status, 200, revoked.text);
  const afterRevoke = await request('GET', '/work/v1/admin/provider-config');
  assert.equal(afterRevoke.data.credential.state, 'revoked');
  const setWithRevoked = await request('PUT', '/work/v1/admin/provider-config', {
    body: {
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash-1017',
      region: 'cn-beijing',
      endpoint: 'https://api.deepseek.com',
      credential_mode: 'managed_key',
      credential_id: managed.credential_id,
      expected_revision: 2,
    },
  });
  assert.equal(setWithRevoked.response.status, 422, setWithRevoked.text);
  assert.equal(setWithRevoked.data.code, 'provider_not_configured');

  const replacement = await createManagedCredential('deepseek', 'sk-deepseek-test-0003');
  const set3 = await request('PUT', '/work/v1/admin/provider-config', {
    body: {
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash-1017',
      region: 'cn-beijing',
      endpoint: 'https://api.deepseek.com',
      credential_mode: 'managed_key',
      credential_id: replacement.credential_id,
      expected_revision: 2,
    },
  });
  assert.equal(set3.response.status, 200, set3.text);
  assert.equal(set3.data.revision, 3);

  const noCsrf = await request('PUT', '/work/v1/admin/provider-config', {
    body: configBody('aliyun', sts.credential_id, 3), useCsrf: false,
  });
  assert.equal(noCsrf.response.status, 403, noCsrf.text);
  assert.equal(noCsrf.data.code, 'csrf_invalid');

  const revokeConfig = await request('POST', '/work/v1/admin/provider-config/revoke', {
    body: { reason: 'demo paused' },
  });
  assert.equal(revokeConfig.response.status, 200, revokeConfig.text);
  assert.deepEqual(revokeConfig.data, { org_id: 'org1', state: 'revoked' });
  const afterConfigRevoke = await request('GET', '/work/v1/admin/provider-config');
  assert.equal(afterConfigRevoke.response.status, 404);
});

test('token usage is visible to the user and aggregated by model for admins', async () => {
  const sts = await createStsCredential();
  const configured = await request('PUT', '/work/v1/admin/provider-config', {
    body: configBody('aliyun', sts.credential_id, 0),
  });
  assert.equal(configured.response.status, 200, configured.text);

  const first = await createTask('写一份用量统计验证稿', 'req-usage-0001');
  await request('POST', `/__test/tasks/${first.taskId}/complete`, { body: {} });
  const second = await createTask('写一份用量统计验证稿二', 'req-usage-0002');
  await request('POST', `/__test/tasks/${second.taskId}/complete`, { body: {} });

  const today = new Date().toISOString().slice(0, 10);
  const mine = await request('GET', `/work/v1/me/usage?from=${today}&to=${today}`);
  assert.equal(mine.response.status, 200, mine.text);
  assert.match(mine.data.note, /云厂商账单/);
  assert.deepEqual(mine.data.items, [
    {
      provider: 'aliyun',
      model: 'qwen3.8-flash',
      usage_date: today,
      input_tokens: 100,
      output_tokens: 60,
      cached_input_tokens: 0,
      run_count: 2,
    },
  ]);

  const org = await request('GET', `/work/v1/admin/usage?from=${today}&to=${today}`);
  assert.equal(org.response.status, 200, org.text);
  assert.deepEqual(org.data.items, [
    {
      provider: 'aliyun',
      model: 'qwen3.8-flash',
      input_tokens: 100,
      output_tokens: 60,
      cached_input_tokens: 0,
      run_count: 2,
    },
  ]);

  const badRange = await request('GET', `/work/v1/me/usage?from=${today}&to=2020-01-01`);
  assert.equal(badRange.response.status, 400, badRange.text);
  assert.equal(badRange.data.code, 'invalid_request');

  await actAs('user4', { role: 'member', work_seat: true, status: 'active' });
  const denied = await request('GET', `/work/v1/admin/usage?from=${today}&to=${today}`);
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.data.code, 'admin_access_denied');
});

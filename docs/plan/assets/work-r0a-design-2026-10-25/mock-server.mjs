/**
 * R0a contract mock server.
 *
 * Purpose: exercise the R0a OpenAPI subset without PostgreSQL, Temporal or a
 * real model provider. State is in memory and reset between tests.
 *
 * Security shape mirrors the design:
 *   - HttpOnly cookie session (mock uses a fixed test cookie).
 *   - CSRF double-submit header on mutations.
 *   - No content in errors, events or logs.
 *   - R0a rejects suite/connectors/plan mode and non-allowlisted tools.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SESSION_COOKIE = 'we_meet_session=test-session';
const CSRF_TOKEN = 'test-csrf-token-123456';
const PRICE_VERSION = 'price-v1';
const ALLOWED_TOOLS = ['model_call', 'read_builtin_template', 'write_artifact_draft'];
const BLOCKING_STATES = new Set([
  'prepared',
  'waiting_approval',
  'authorized',
  'dispatching',
  'unknown',
  'unresolved',
]);
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'canceled']);

function now() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function createTemplates() {
  return [
    {
      id: 'tpl-report',
      version: 1,
      name: '方案 / 报告',
      description: '面向决策的方案或报告初稿，包含背景、方案、风险与下一步。',
      output_format: 'markdown',
      sections: ['背景与目标', '方案', '风险', '下一步'],
      content_hash: 'sha256:tpl-report-v1',
    },
    {
      id: 'tpl-plan',
      version: 1,
      name: '计划 / 清单',
      description: '把目标拆成可执行步骤、负责人、依赖与验收标准。',
      output_format: 'markdown',
      sections: ['目标', '步骤', '依赖', '验收'],
      content_hash: 'sha256:tpl-plan-v1',
    },
    {
      id: 'tpl-summary',
      version: 1,
      name: '总结 / 纪要',
      description: '把输入整理成结构化总结，突出结论、依据与待办。',
      output_format: 'markdown',
      sections: ['结论', '依据', '待办'],
      content_hash: 'sha256:tpl-summary-v1',
    },
  ];
}

function createState() {
  return {
    org: { id: 'org1', name: '试点组织', role: 'owner', work_seat: true },
    subjectId: 'user1',
    csrfToken: CSRF_TOKEN,
    templates: createTemplates(),
    inputs: new Map(),
    inputDedup: new Map(),
    inputByHash: new Map(),
    previews: new Map(),
    tasks: new Map(),
    taskDedup: new Map(),
    auditExports: new Map(),
  };
}

function resetState(state) {
  state.inputs.clear();
  state.inputDedup.clear();
  state.inputByHash.clear();
  state.previews.clear();
  state.tasks.clear();
  state.taskDedup.clear();
  state.auditExports.clear();
}

function fail(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.extra = extra;
  throw error;
}

function requireSession(req) {
  const cookie = req.headers.cookie ?? '';
  if (!cookie.split(';').map((v) => v.trim()).includes(SESSION_COOKIE)) {
    fail(401, 'unauthorized', '会话无效或已过期');
  }
}

function requireCsrf(req, state) {
  if (req.headers['x-csrf-token'] !== state.csrfToken) {
    fail(403, 'csrf_invalid', 'CSRF token 缺失或不匹配');
  }
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error('body too large'), { status: 400, code: 'invalid_request' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error.status ?? 500;
  const code = error.code ?? 'service_degraded';
  const retryable = status >= 500 || code === 'preview_stale';
  const recovery =
    error.extra?.recovery_action ??
    (code === 'preview_stale'
      ? 're_preview'
      : code === 'version_conflict' || code === 'run_not_quiescent'
        ? 'refresh'
        : null);
  sendJson(res, status, {
    code,
    message: error.message,
    retryable,
    correlation_id: uuid(),
    current_revision: error.extra?.current_revision ?? null,
    recovery_action: recovery,
  });
}

function parsePagination(url) {
  const rawCursor = url.searchParams.get('cursor');
  const rawLimit = url.searchParams.get('limit');
  const offset = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(400, 'invalid_pagination', 'cursor 或 limit 非法');
  }
  return { offset, limit };
}

function paginate(items, { offset, limit }) {
  return {
    items: items.slice(offset, offset + limit),
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}

function runView(run) {
  if (!run) return null;
  return {
    id: run.id,
    task_id: run.taskId,
    attempt_no: run.attemptNo,
    state: run.state,
    wait_reason: run.waitReason,
    terminal_reason: run.terminalReason,
    control_revision: run.controlRevision,
    runtime_version: run.runtimeVersion,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function operationView(op) {
  return {
    id: op.id,
    run_id: op.runId,
    logical_key: op.logicalKey,
    kind: op.kind,
    state: op.state,
    request_hash: op.requestHash,
    provider_request_id: op.providerRequestId,
    receipt_ref: op.receiptRef,
    revision: op.revision,
    created_at: op.createdAt,
    updated_at: op.updatedAt,
  };
}

function displayState(task) {
  if (['completed', 'canceled', 'archived', 'awaiting_acceptance'].includes(task.state)) {
    return task.state;
  }
  const run = task.latestRunId ? task.runs.get(task.latestRunId) : null;
  if (!run) return 'open';
  if (run.state === 'queued') return 'queued';
  if (run.state === 'cancel_requested') return 'canceling';
  if (run.state === 'canceled') return 'run_canceled';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'active' || run.state === 'waiting') {
    if (run.waitReason === 'budget') return 'budget_exhausted';
    if ([...task.operations.values()].some((op) => ['unknown', 'unresolved'].includes(op.state))) {
      return 'reconciling';
    }
    return 'running';
  }
  return 'open';
}

function latestArtifact(task) {
  const artifacts = [...task.artifacts.values()];
  if (artifacts.length === 0) return null;
  const artifact = artifacts[0];
  const version = artifact.versions[artifact.versions.length - 1] ?? null;
  return { artifact, version };
}

function summary(task) {
  const latestRun = task.latestRunId ? task.runs.get(task.latestRunId) : null;
  const artifactInfo = latestArtifact(task);
  const blocking = [...task.operations.values()].filter((op) => BLOCKING_STATES.has(op.state)).length;
  return {
    task_id: task.id,
    title: task.title,
    display_state: displayState(task),
    task_state: task.state,
    permission_mode: task.permissionMode,
    active_run_id: task.activeRunId,
    latest_run_id: task.latestRunId,
    latest_run: runView(latestRun),
    latest_artifact: artifactInfo
      ? {
          artifact_id: artifactInfo.artifact.id,
          version_no: artifactInfo.version.versionNo,
          content_hash: artifactInfo.version.contentHash,
        }
      : null,
    revision: task.revision,
    pending_acceptance: task.state === 'awaiting_acceptance',
    blocking_operations: blocking,
    budget: {
      currency: task.budget.currency,
      reserved_cents: task.budget.reservedCents,
      settled_cents: task.budget.settledCents,
    },
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function taskDetail(task) {
  return {
    summary: summary(task),
    input_ref: task.inputRef,
    goal: task.goal,
    background: task.background || null,
    template: task.template,
    snapshot: task.snapshot,
  };
}

function addEvent(task, type, payload, runId = null) {
  const event = {
    eventId: uuid(),
    taskId: task.id,
    runId,
    seq: task.events.length + 1,
    schemaVersion: 'work-event-v1',
    occurredAt: now(),
    type,
    payload,
  };
  task.events.push(event);
  task.updatedAt = event.occurredAt;
  return event;
}

function findTaskForRun(state, runId) {
  for (const task of state.tasks.values()) {
    const run = task.runs.get(runId);
    if (run) return { task, run };
  }
  return null;
}

function findArtifact(state, artifactId) {
  for (const task of state.tasks.values()) {
    const artifact = task.artifacts.get(artifactId);
    if (artifact) return { task, artifact };
  }
  return null;
}

function versionView(req, artifact, version) {
  const base = `http://${req.headers.host}`;
  return {
    artifact_id: artifact.id,
    version_no: version.versionNo,
    logical_name: artifact.logicalName,
    media_type: version.mediaType,
    bytes: version.bytes,
    content_hash: version.contentHash,
    state: 'published',
    content_url: `${base}/work/v1/artifacts/${artifact.id}/versions/${version.versionNo}/content`,
    created_at: version.createdAt,
    published_at: version.publishedAt,
  };
}

function inputView(input) {
  return {
    input_ref: input.inputRef,
    content_hash: input.contentHash,
    bytes: input.bytes,
    media_type: input.mediaType,
    expires_at: input.expiresAt,
  };
}

function validateInput(state, inputRef) {
  const input = state.inputs.get(inputRef);
  if (!input) fail(422, 'input_not_found', 'input_ref 不存在或不可见');
  return input;
}

function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object') fail(400, 'invalid_request', 'intent 必填');
  if (!intent.input_ref) fail(400, 'invalid_request', 'input_ref 必填');
  if (!intent.target || intent.target.kind !== 'cloud' || intent.target.profile !== 'text-v1') {
    fail(422, 'execution_target_unavailable', 'R0a 只支持 cloud/text-v1');
  }
  if (!['ask_each', 'auto_readonly'].includes(intent.permission_mode)) {
    fail(422, 'permission_mode_unavailable', 'R0a 只支持 ask_each/auto_readonly');
  }
  if (intent.suite) fail(422, 'scope_unavailable', 'R0a 不支持 suite');
  if (Array.isArray(intent.connectors) && intent.connectors.length > 0) {
    fail(422, 'scope_unavailable', 'R0a 不支持 connectors');
  }
  if (!intent.output || intent.output.format !== 'markdown') {
    fail(422, 'output_unsupported', 'R0a 只支持 Markdown 文本成果');
  }
  return {
    input_ref: intent.input_ref,
    target: intent.target,
    template: intent.template ?? null,
    permission_mode: intent.permission_mode,
    output: intent.output,
    suite: null,
    connectors: [],
  };
}

function makePreview(state, intent) {
  const normalized = normalizeIntent(intent);
  const input = validateInput(state, normalized.input_ref);
  let template = null;
  if (normalized.template) {
    template = state.templates.find(
      (item) => item.id === normalized.template.id && item.version === normalized.template.version,
    );
    if (!template) fail(422, 'template_unavailable', '模板不存在或版本不可用');
  }
  const effectiveMode = normalized.permission_mode;
  const intentHash = sha256(stableStringify(normalized));
  const cost = Math.min(500, 100 + Math.ceil((input.goal.length + (input.background?.length ?? 0)) / 200) * 10);
  const previewHash = sha256(
    stableStringify({
      intentHash,
      inputHash: input.contentHash,
      templateHash: template?.content_hash ?? null,
      effectiveMode,
      priceVersion: PRICE_VERSION,
    }),
  );
  const preview = {
    previewHash,
    intentHash,
    effectiveMode,
    inputHash: input.contentHash,
    expiresAt: Date.now() + 10 * 60 * 1000,
    cost,
    template,
  };
  state.previews.set(previewHash, preview);
  return {
    preview_hash: previewHash,
    effective_permission_mode: effectiveMode,
    allowed_permission_modes: ['ask_each', 'auto_readonly'],
    boundary_summary: [
      '执行位置：云端（cloud/text-v1）',
      '数据：仅本次输入的文本；不访问本机、连接器或项目',
      '权限：本次任务内模型生成；无外部写动作',
      '成果：Markdown，保存到任务，可编辑并采纳',
      `预算上限：¥${(cost / 100).toFixed(2)}（${PRICE_VERSION}）`,
    ],
    cost_upper_bound: { amount_cents: cost, currency: 'CNY', price_version: PRICE_VERSION },
    unavailable_reasons: [],
    expires_at: new Date(preview.expiresAt).toISOString(),
  };
}

function createTask(state, intent, preview) {
  const input = validateInput(state, intent.input_ref);
  const taskId = uuid();
  const runId = uuid();
  const title = intent.output?.required_sections?.length
    ? `${input.goal.slice(0, 20)}`
    : input.goal.slice(0, 20);
  const task = {
    id: taskId,
    title: title || '未命名任务',
    goal: input.goal,
    background: input.background ?? '',
    inputRef: input.inputRef,
    template: preview.template,
    permissionMode: preview.effectiveMode,
    state: 'open',
    activeRunId: runId,
    latestRunId: runId,
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    snapshot: {
      snapshot_id: uuid(),
      snapshot_hash: `sha256:r0a-${sha256(input.contentHash).slice(0, 16)}`,
      tool_allowlist: [...ALLOWED_TOOLS],
      model_route: { provider: 'mock', model: 'mock-text-v1' },
      price_version: PRICE_VERSION,
    },
    runs: new Map(),
    operations: new Map(),
    artifacts: new Map(),
    acceptance: null,
    events: [],
    budget: { currency: 'CNY', reservedCents: 0, settledCents: 0 },
  };
  const run = {
    id: runId,
    taskId,
    attemptNo: 1,
    state: 'queued',
    waitReason: null,
    terminalReason: null,
    controlRevision: 0,
    runtimeVersion: 'mock-pi-1.4.0',
    createdAt: now(),
    updatedAt: now(),
  };
  task.runs.set(runId, run);
  addEvent(task, 'task.submitted', {
    task_id: taskId,
    run_id: runId,
    state: 'open',
    permission_mode: task.permissionMode,
  }, runId);
  state.tasks.set(taskId, task);
  return task;
}

function completeTaskForTest(state, task) {
  const run = task.latestRunId ? task.runs.get(task.latestRunId) : null;
  if (!run) fail(404, 'run_not_found', '任务没有运行');
  if (TERMINAL_RUN_STATES.has(run.state)) fail(409, 'run_not_active', '运行已终态');
  run.state = 'active';
  run.controlRevision += 1;
  run.updatedAt = now();
  const opId = uuid();
  const op = {
    id: opId,
    runId: run.id,
    logicalKey: 'model:step-1',
    kind: 'model',
    state: 'authorized',
    requestHash: 'sha256:mock-model-1',
    providerRequestId: null,
    receiptRef: null,
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  task.operations.set(opId, op);
  task.budget.reservedCents = 100;
  addEvent(task, 'operation.authorized', { operation_id: opId, decision_source: 'policy_auto' }, run.id);
  op.state = 'dispatching';
  op.revision += 1;
  op.updatedAt = now();
  addEvent(task, 'operation.dispatching', { operation_id: opId }, run.id);
  op.state = 'succeeded';
  op.providerRequestId = 'mock-provider-request-1';
  op.receiptRef = 'mock-receipt-1';
  op.revision += 1;
  op.updatedAt = now();
  task.budget.reservedCents = 0;
  task.budget.settledCents += 80;
  addEvent(task, 'operation.finished', { operation_id: opId, outcome: 'succeeded' }, run.id);

  const artifactId = uuid();
  const content = `# ${task.title}\n\nMock artifact for contract tests.\n`;
  const artifact = {
    id: artifactId,
    taskId: task.id,
    logicalName: 'draft.md',
    versions: [],
    latestVersionNo: 0,
  };
  const version = {
    versionNo: 1,
    content,
    contentHash: `sha256:${sha256(content)}`,
    bytes: Buffer.byteLength(content),
    mediaType: 'text/markdown',
    createdAt: now(),
    publishedAt: now(),
  };
  artifact.versions.push(version);
  artifact.latestVersionNo = 1;
  task.artifacts.set(artifactId, artifact);
  task.revision += 1;
  addEvent(task, 'artifact.published', {
    artifact_id: artifactId,
    version_no: 1,
    content_hash: version.contentHash,
  }, run.id);

  run.state = 'succeeded';
  run.controlRevision += 1;
  run.updatedAt = now();
  task.state = 'awaiting_acceptance';
  task.activeRunId = null;
  task.latestRunId = run.id;
  task.revision += 1;
  addEvent(task, 'task.awaiting_acceptance', { task_id: task.id, run_id: run.id }, run.id);
  return { task, artifactId, versionNo: 1 };
}

function finishCancelForTest(state, task) {
  const run = task.latestRunId ? task.runs.get(task.latestRunId) : null;
  if (!run) fail(404, 'run_not_found', '任务没有运行');
  if (!TERMINAL_RUN_STATES.has(run.state)) {
    if (run.state !== 'cancel_requested') {
      run.state = 'cancel_requested';
      run.controlRevision += 1;
      run.updatedAt = now();
    }
    for (const op of task.operations.values()) {
      if (!['succeeded', 'failed', 'canceled', 'reconciled', 'unresolved'].includes(op.state)) {
        op.state = 'canceled';
        op.revision += 1;
        op.updatedAt = now();
      }
    }
    run.state = 'canceled';
    run.controlRevision += 1;
    run.updatedAt = now();
    task.activeRunId = null;
    task.latestRunId = run.id;
    task.state = 'open';
    task.revision += 1;
    addEvent(task, 'run.canceled', { run_id: run.id, reason: 'user canceled' }, run.id);
  }
  return task;
}

function sendSseEvents(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  if (events.length === 0) res.write(': connected\n\n');
  for (const event of events) {
    res.write(`id: ${event.eventId}\n`);
    res.write('event: task.updated\n');
    res.write(
      `data: ${JSON.stringify({
        event_id: event.eventId,
        task_id: event.taskId,
        run_id: event.runId,
        seq: event.seq,
        schema_version: event.schemaVersion,
        occurred_at: event.occurredAt,
        type: event.type,
        payload: event.payload,
      })}\n\n`,
    );
  }
  res.end();
}

async function handle(req, res, state) {
  requireSession(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/work/v1/bootstrap') {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}; HttpOnly; SameSite=Lax; Path=/`);
    return sendJson(res, 200, {
      subject_id: state.subjectId,
      org: state.org,
      permissions: ['work.task.create', 'work.artifact.read'],
      phases: ['R0a'],
      execution_targets: [{ kind: 'cloud', profile: 'text-v1' }],
      allowed_permission_modes: ['ask_each', 'auto_readonly'],
      limits: {
        max_goal_chars: 2000,
        max_background_chars: 4000,
        max_artifact_bytes: 262144,
        max_active_runs: 1,
      },
      csrf_token: state.csrfToken,
    });
  }

  if (method === 'GET' && pathname === '/work/v1/templates') {
    return sendJson(res, 200, { items: state.templates });
  }

  if (method === 'POST' && pathname === '/work/v1/inputs') {
    requireCsrf(req, state);
    const body = await readJson(req);
    if (!body.client_request_id || body.client_request_id.length < 8) {
      fail(400, 'invalid_request', 'client_request_id 至少 8 字符');
    }
    if (!body.goal || body.goal.length > 2000) fail(422, 'input_too_large', 'goal 长度非法');
    if (body.background && body.background.length > 4000) {
      fail(422, 'input_too_large', 'background 长度非法');
    }
    const content = JSON.stringify({ goal: body.goal, background: body.background ?? '' });
    const contentHash = `sha256:${sha256(content)}`;
    const previous = state.inputDedup.get(body.client_request_id);
    if (previous) {
      if (previous.contentHash !== contentHash) {
        fail(409, 'idempotency_key_conflict', '同一 client_request_id 的输入不同');
      }
      return sendJson(res, 201, inputView(state.inputs.get(previous.inputRef)));
    }
    let input = state.inputByHash.get(contentHash);
    if (!input) {
      input = {
        inputRef: uuid(),
        content,
        goal: body.goal,
        background: body.background ?? '',
        contentHash,
        bytes: Buffer.byteLength(content),
        mediaType: body.media_type ?? 'text/markdown',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      state.inputs.set(input.inputRef, input);
      state.inputByHash.set(contentHash, input);
    }
    state.inputDedup.set(body.client_request_id, { contentHash, inputRef: input.inputRef });
    return sendJson(res, 201, inputView(input));
  }

  if (method === 'POST' && pathname === '/work/v1/task-previews') {
    const body = await readJson(req);
    return sendJson(res, 200, makePreview(state, body.intent));
  }

  if (method === 'POST' && pathname === '/work/v1/tasks') {
    requireCsrf(req, state);
    const body = await readJson(req);
    if (!body.client_request_id || body.client_request_id.length < 8) {
      fail(400, 'invalid_request', 'client_request_id 至少 8 字符');
    }
    const preview = state.previews.get(body.preview_hash);
    if (!preview || preview.expiresAt <= Date.now()) {
      fail(409, 'preview_stale', '预览已过期或不存在');
    }
    const intent = normalizeIntent(body.intent);
    const intentHash = sha256(stableStringify(intent));
    if (intentHash !== preview.intentHash) {
      fail(409, 'preview_stale', '提交意图与预览不一致');
    }
    const requestHash = sha256(stableStringify({ previewHash: body.preview_hash, intentHash }));
    const previous = state.taskDedup.get(body.client_request_id);
    if (previous) {
      if (previous.requestHash !== requestHash) {
        fail(409, 'idempotency_key_conflict', '同一 client_request_id 的任务请求不同');
      }
      const task = state.tasks.get(previous.taskId);
      return sendJson(res, 202, { task: summary(task), run: runView(task.runs.get(previous.runId)) }, {
        Location: `/work/v1/tasks/${task.id}`,
      });
    }
    const task = createTask(state, intent, preview);
    const runId = task.latestRunId;
    state.taskDedup.set(body.client_request_id, {
      requestHash,
      taskId: task.id,
      runId,
    });
    return sendJson(res, 202, { task: summary(task), run: runView(task.runs.get(runId)) }, {
      Location: `/work/v1/tasks/${task.id}`,
    });
  }

  if (method === 'GET' && pathname === '/work/v1/tasks') {
    const view = url.searchParams.get('view') ?? 'all';
    const allowed = ['pending', 'running', 'awaiting_acceptance', 'completed', 'all'];
    if (!allowed.includes(view)) fail(400, 'invalid_view', 'view 非法');
    const page = parsePagination(url);
    const tasks = [...state.tasks.values()]
      .filter((task) => {
        if (view === 'all') return true;
        const display = displayState(task);
        if (view === 'pending') return ['failed', 'reconciling', 'run_canceled'].includes(display);
        if (view === 'running') {
          return ['queued', 'running', 'canceling', 'budget_exhausted'].includes(display);
        }
        return display === view;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(summary);
    return sendJson(res, 200, paginate(tasks, page));
  }

  let match;
  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)\/runs$/)) && method === 'POST') {
    requireCsrf(req, state);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    if (!['open', 'awaiting_acceptance'].includes(task.state)) {
      fail(409, 'task_not_runnable', '任务状态不可重试');
    }
    if (task.activeRunId) fail(409, 'task_has_active_run', '任务已有活动运行');
    const latest = task.latestRunId ? task.runs.get(task.latestRunId) : null;
    if (latest && !TERMINAL_RUN_STATES.has(latest.state)) {
      fail(409, 'run_not_quiescent', '最近运行未终态');
    }
    const attemptNo = Math.max(...[...task.runs.values()].map((r) => r.attemptNo)) + 1;
    const runId = uuid();
    const run = {
      id: runId,
      taskId: task.id,
      attemptNo,
      state: 'queued',
      waitReason: null,
      terminalReason: null,
      controlRevision: 0,
      runtimeVersion: 'mock-pi-1.4.0',
      createdAt: now(),
      updatedAt: now(),
    };
    task.runs.set(runId, run);
    task.activeRunId = runId;
    task.latestRunId = runId;
    task.state = 'open';
    task.revision += 1;
    addEvent(task, 'run.retried', { run_id: runId, attempt_no: attemptNo }, runId);
    return sendJson(res, 202, { task: summary(task), run: runView(run) });
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)\/events$/)) && method === 'GET') {
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    const lastId = req.headers['last-event-id'];
    if (lastId === 'expired') {
      fail(409, 'resync_required', '事件游标已过期，请重取任务快照', {
        recovery_action: 'resync',
      });
    }
    let events = task.events;
    if (lastId) {
      const index = task.events.findIndex((event) => event.eventId === lastId);
      if (index < 0) {
        fail(409, 'resync_required', '事件游标不存在，请重取任务快照', {
          recovery_action: 'resync',
        });
      }
      events = task.events.slice(index + 1);
    }
    return sendSseEvents(res, events);
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)\/acceptances$/)) && method === 'POST') {
    requireCsrf(req, state);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    const body = await readJson(req);
    if (body.expected_revision !== task.revision) {
      fail(409, 'version_conflict', '任务 revision 已变化', { current_revision: task.revision });
    }
    if (!['open', 'awaiting_acceptance'].includes(task.state)) {
      fail(409, 'task_not_acceptable', '任务状态不可采纳');
    }
    if (task.activeRunId) fail(409, 'run_not_quiescent', '任务仍有活动运行');
    const latest = task.latestRunId ? task.runs.get(task.latestRunId) : null;
    if (latest && !TERMINAL_RUN_STATES.has(latest.state)) {
      fail(409, 'run_not_quiescent', '最近运行未终态');
    }
    const blocking = [...task.operations.values()].some((op) => BLOCKING_STATES.has(op.state));
    if (blocking) fail(409, 'run_not_quiescent', '存在未核对动作');
    if (!body.artifact_id && !body.completion_reason) {
      fail(422, 'acceptance_requires_artifact_or_reason', '必须采纳版本或提供完成理由');
    }
    if (body.artifact_id) {
      const artifact = task.artifacts.get(body.artifact_id);
      const version = artifact?.versions.find((v) => v.versionNo === body.version_no);
      if (!artifact || !version) fail(422, 'artifact_not_published', '成果版本不可采纳');
    }
    task.state = 'completed';
    task.revision += 1;
    const acceptance = {
      id: uuid(),
      task_id: task.id,
      artifact_id: body.artifact_id ?? null,
      version_no: body.version_no ?? null,
      completion_reason: body.completion_reason ?? null,
      actor_subject_id: state.subjectId,
      task_revision: task.revision,
      created_at: now(),
    };
    task.acceptance = acceptance;
    addEvent(task, 'task.completed', { task_id: task.id, acceptance_id: acceptance.id }, latest?.id ?? null);
    return sendJson(res, 200, { acceptance, task: summary(task) });
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)$/)) && method === 'GET') {
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    return sendJson(res, 200, taskDetail(task));
  }

  if ((match = pathname.match(/^\/work\/v1\/runs\/([0-9a-f-]+)\/operations$/)) && method === 'GET') {
    const found = findTaskForRun(state, match[1]);
    if (!found) fail(404, 'run_not_found', '运行不存在');
    const page = parsePagination(url);
    const items = [...found.task.operations.values()]
      .filter((op) => op.runId === found.run.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(operationView);
    return sendJson(res, 200, paginate(items, page));
  }

  if ((match = pathname.match(/^\/work\/v1\/runs\/([0-9a-f-]+)\/cancel$/)) && method === 'POST') {
    requireCsrf(req, state);
    const found = findTaskForRun(state, match[1]);
    if (!found) fail(404, 'run_not_found', '运行不存在');
    const { task, run } = found;
    if (!TERMINAL_RUN_STATES.has(run.state) && run.state !== 'cancel_requested') {
      run.state = 'cancel_requested';
      run.controlRevision += 1;
      run.updatedAt = now();
      task.revision += 1;
      addEvent(task, 'run.cancel_requested', { run_id: run.id, reason: 'user canceled' }, run.id);
    }
    return sendJson(res, 202, runView(run));
  }

  if ((match = pathname.match(/^\/work\/v1\/runs\/([0-9a-f-]+)$/)) && method === 'GET') {
    const found = findTaskForRun(state, match[1]);
    if (!found) fail(404, 'run_not_found', '运行不存在');
    return sendJson(res, 200, runView(found.run));
  }

  if (method === 'GET' && pathname === '/work/v1/inbox') {
    const page = parsePagination(url);
    const items = [];
    for (const task of state.tasks.values()) {
      const display = displayState(task);
      let type = null;
      if (display === 'awaiting_acceptance') type = 'acceptance_required';
      else if (display === 'failed') type = 'failed';
      else if (display === 'reconciling') type = 'reconciling';
      if (type) {
        items.push({
          task_id: task.id,
          type,
          title: task.title,
          display_state: display,
          updated_at: task.updatedAt,
        });
      }
    }
    items.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return sendJson(res, 200, paginate(items, page));
  }

  if ((match = pathname.match(/^\/work\/v1\/artifacts\/([0-9a-f-]+)\/versions$/)) && method === 'POST') {
    requireCsrf(req, state);
    const found = findArtifact(state, match[1]);
    if (!found) fail(404, 'artifact_not_found', '成果不存在');
    const { task, artifact } = found;
    const body = await readJson(req);
    if (!body.client_request_id || body.client_request_id.length < 8) {
      fail(400, 'invalid_request', 'client_request_id 至少 8 字符');
    }
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 262144) {
      fail(422, 'artifact_too_large', '成果正文超过 R0a 限制');
    }
    const base = body.base_version_no ?? 0;
    if (base !== artifact.latestVersionNo) {
      fail(409, 'version_conflict', 'base_version_no 不是最新版本');
    }
    const mediaType = body.media_type ?? 'text/markdown';
    if (!['text/markdown', 'text/plain'].includes(mediaType)) {
      fail(422, 'media_type_unsupported', 'R0a 只支持文本成果');
    }
    const version = {
      versionNo: artifact.latestVersionNo + 1,
      content: body.content,
      contentHash: `sha256:${sha256(body.content)}`,
      bytes: Buffer.byteLength(body.content),
      mediaType,
      createdAt: now(),
      publishedAt: now(),
    };
    artifact.versions.push(version);
    artifact.latestVersionNo = version.versionNo;
    task.revision += 1;
    addEvent(task, 'artifact.published', {
      artifact_id: artifact.id,
      version_no: version.versionNo,
      content_hash: version.contentHash,
    }, task.latestRunId);
    return sendJson(res, 201, versionView(req, artifact, version));
  }

  if ((match = pathname.match(/^\/work\/v1\/artifacts\/([0-9a-f-]+)\/versions\/(\d+)\/content$/)) && method === 'GET') {
    const found = findArtifact(state, match[1]);
    if (!found) fail(404, 'artifact_not_found', '成果不存在');
    const version = found.artifact.versions.find((v) => v.versionNo === Number(match[2]));
    if (!version) fail(404, 'version_not_found', '成果版本不存在');
    res.writeHead(200, {
      'Content-Type': `${version.mediaType}; charset=utf-8`,
      'Cache-Control': 'no-store',
    });
    return res.end(version.content);
  }

  if ((match = pathname.match(/^\/work\/v1\/artifacts\/([0-9a-f-]+)\/versions\/(\d+)$/)) && method === 'GET') {
    const found = findArtifact(state, match[1]);
    if (!found) fail(404, 'artifact_not_found', '成果不存在');
    const version = found.artifact.versions.find((v) => v.versionNo === Number(match[2]));
    if (!version) fail(404, 'version_not_found', '成果版本不存在');
    return sendJson(res, 200, versionView(req, found.artifact, version));
  }

  if (method === 'GET' && pathname === '/work/v1/admin/overview') {
    const settled = [...state.tasks.values()].reduce((sum, task) => sum + task.budget.settledCents, 0);
    return sendJson(res, 200, {
      org_id: state.org.id,
      name: state.org.name,
      status: 'active',
      execution_enabled: true,
      seats: { total: 1, active: 1 },
      budget: {
        currency: 'CNY',
        limit_cents: 10000,
        reserved_cents: 0,
        settled_cents: settled,
      },
      audit_retention_days: 365,
    });
  }

  if (method === 'GET' && pathname === '/work/v1/admin/seats') {
    const page = parsePagination(url);
    return sendJson(res, 200, paginate([{
      subject_id: state.subjectId,
      role: 'owner',
      work_seat: true,
      status: 'active',
      revision: 0,
    }], page));
  }

  if (method === 'POST' && pathname === '/work/v1/admin/audit-exports') {
    requireCsrf(req, state);
    const body = await readJson(req);
    if (!body.client_request_id || !body.from || !body.to || !['csv', 'json'].includes(body.format)) {
      fail(400, 'invalid_request', '审计导出参数非法');
    }
    const id = uuid();
    const exportJob = {
      id,
      status: 'ready',
      requested_at: now(),
      ready_at: now(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      download_url: `http://${req.headers.host}/__test/audit/${id}`,
    };
    state.auditExports.set(id, exportJob);
    return sendJson(res, 202, exportJob);
  }

  if ((match = pathname.match(/^\/work\/v1\/admin\/audit-exports\/([0-9a-f-]+)$/)) && method === 'GET') {
    const exportJob = state.auditExports.get(match[1]);
    if (!exportJob) fail(404, 'audit_export_not_found', '导出作业不存在');
    return sendJson(res, 200, exportJob);
  }

  if (method === 'POST' && pathname === '/__test/reset') {
    resetState(state);
    return sendJson(res, 200, { ok: true });
  }

  if ((match = pathname.match(/^\/__test\/tasks\/([0-9a-f-]+)\/complete$/)) && method === 'POST') {
    requireCsrf(req, state);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    const result = completeTaskForTest(state, task);
    return sendJson(res, 200, {
      task: summary(result.task),
      artifact_id: result.artifactId,
      version_no: result.versionNo,
    });
  }

  if ((match = pathname.match(/^\/__test\/tasks\/([0-9a-f-]+)\/finish-cancel$/)) && method === 'POST') {
    requireCsrf(req, state);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    return sendJson(res, 200, { task: summary(finishCancelForTest(state, task)) });
  }

  fail(404, 'not_found', '接口不存在');
}

export function createWorkServer() {
  const state = createState();
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, state);
    } catch (error) {
      if (res.headersSent) return res.end();
      sendError(res, error);
    }
  });
  return {
    server,
    state,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createWorkServer();
  const port = await app.listen();
  console.log(`work-r0a mock listening on http://127.0.0.1:${port}`);
}

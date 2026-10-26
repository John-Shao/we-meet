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
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ERROR_CATALOG = JSON.parse(readFileSync(new URL('./error-codes.json', import.meta.url), 'utf8'));

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

function seatRows(state) {
  return [...state.members.values()]
    .filter((member) => member.status !== 'left')
    .map((member) => ({ ...member }))
    .sort((a, b) => (a.subject_id < b.subject_id ? -1 : 1));
}

function sendText(res, text, contentType, headers = {}) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function currentPeriodId(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function memberOf(state, subjectId) {
  return state.members.get(subjectId) ?? null;
}

// 管理读（方案 B）与提交门控都只看目录投影，与 D1 的 assert_org_admin /
// work_seat_required 一一对应。
function requireAdmin(state) {
  const actor = memberOf(state, state.subjectId);
  if (!actor || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) {
    fail(403, 'admin_access_denied', '仅组织管理员可以访问治理信息');
  }
  return actor;
}

function requireEntitlement(state) {
  if (state.org.status !== 'active' || !state.org.execution_enabled) {
    fail(403, 'org_execution_unavailable', '组织已暂停工作执行');
  }
  const actor = memberOf(state, state.subjectId);
  if (!actor || actor.status !== 'active' || !actor.work_seat || actor.role === 'viewer') {
    fail(403, 'work_seat_required', '当前账号没有可用的工作席位');
  }
  return actor;
}

function exportView(job) {
  return {
    id: job.id,
    status: job.status,
    format: job.format,
    range_from: job.rangeFrom,
    range_to: job.rangeTo,
    requested_by: job.requestedBy,
    requested_at: job.requestedAt,
    ready_at: job.readyAt,
    expires_at: job.expiresAt,
    row_count: job.rowCount,
    bytes: job.bytes,
    error_code: job.errorCode,
    download_available:
      job.status === 'ready' &&
      !job.downloadedAt &&
      job.expiresAt !== null &&
      Date.parse(job.expiresAt) > Date.now(),
    downloaded_at: job.downloadedAt,
  };
}

function findExport(state, id) {
  const job = state.auditExports.get(id);
  if (!job) fail(404, 'audit_export_not_found', '导出作业不存在或不属于当前组织');
  return job;
}

// 与 D1 get_audit_export 的惰性过期一致：读到已过期的 ready 作业就落为 expired。
function expireIfNeeded(job) {
  if (job.status === 'ready' && job.expiresAt !== null && Date.parse(job.expiresAt) <= Date.now()) {
    job.status = 'expired';
    job.expiresAt = null;
    job.tokenHash = null;
    job.tokenExpiresAt = null;
  }
  return job;
}

function auditRowsInRange(state, job) {
  const from = Date.parse(job.rangeFrom);
  const to = Date.parse(job.rangeTo);
  return state.auditLog
    .filter((entry) => {
      const at = Date.parse(entry.at ?? '');
      return Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(at) && at >= from && at <= to;
    })
    .map((entry) => ({
      action: entry.action,
      actor_subject_id: entry.actor_subject_id ?? '',
      target_type: entry.target_type ?? 'task',
      target_id: entry.target_id ?? '',
      created_at: entry.at,
    }));
}

function renderExportBody(job, rows) {
  if (job.format === 'json') {
    return JSON.stringify({
      org_id: 'org1',
      range_from: job.rangeFrom,
      range_to: job.rangeTo,
      rows,
    });
  }
  const head = 'action,actor_subject_id,target_type,target_id,created_at';
  const lines = [head, ...rows.map((r) => [r.action, r.actor_subject_id, r.target_type, r.target_id, r.created_at].join(','))];
  return lines.join('\n');
}

// 参考实现里的导出 worker：领取 queued 作业，把审计元数据写入 Content Store，
// 库里只留引用与哈希（对齐 work.claim_audit_export / complete_audit_export）。
function runExportWorker(state, options = {}) {
  const ttlSeconds = options.ttl_seconds ?? 86400;
  const processed = [];
  for (const job of state.auditExports.values()) {
    if (job.status !== 'queued') continue;
    job.status = 'running';
    job.leaseOwner = options.worker_id ?? 'export-worker-test';
    job.leaseUntil = new Date(Date.now() + 600 * 1000).toISOString();
    if (options.fail_with) {
      job.status = 'failed';
      job.errorCode = options.fail_with;
      processed.push(exportView(job));
      continue;
    }
    const rows = auditRowsInRange(state, job);
    const body = renderExportBody(job, rows);
    job.rows = rows;
    job.body = body;
    job.contentRef = `content://org1/audit-${job.id}.${job.format}`;
    job.contentHash = `sha256:${sha256(body)}`;
    job.bytes = Buffer.byteLength(body);
    job.rowCount = rows.length;
    job.status = 'ready';
    job.readyAt = now();
    job.expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    job.leaseOwner = null;
    job.leaseUntil = null;
    processed.push(exportView(job));
  }
  return processed;
}

function issueTicketFor(state, job, actor, ttlSeconds) {
  if (job.status === 'expired') fail(410, 'audit_export_expired', '导出内容已过期');
  if (job.status !== 'ready') fail(409, 'audit_export_not_ready', '导出作业尚未就绪');
  if (job.expiresAt !== null && Date.parse(job.expiresAt) <= Date.now()) {
    expireIfNeeded(job);
    fail(410, 'audit_export_expired', '导出内容已过期');
  }
  if (job.downloadedAt) {
    fail(409, 'audit_export_already_downloaded', '导出文件已下载过，一次性凭证不重复发放');
  }
  const token = crypto.randomBytes(24).toString('hex');
  job.tokenHash = sha256(token);
  job.tokenExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  state.auditLog.push({
    action: 'audit_export.ticket_issued',
    actor_subject_id: actor.subject_id,
    target_type: 'audit_export',
    target_id: job.id,
    at: now(),
  });
  return token;
}

function createState() {
  return {
    org: {
      id: 'org1',
      name: '试点组织',
      status: 'active',
      execution_enabled: true,
      home_region: 'cn-north',
      revision: 0,
      audit_retention_days: 365,
    },
    subjectId: 'user1',
    members: new Map([
      ['user1', {
        subject_id: 'user1', role: 'owner', work_seat: true, status: 'active', revision: 0,
      }],
    ]),
    budget: { currency: 'CNY', limitCents: 10000, periodId: currentPeriodId() },
    csrfToken: CSRF_TOKEN,
    templates: createTemplates(),
    inputs: new Map(),
    inputDedup: new Map(),
    inputByHash: new Map(),
    previews: new Map(),
    tasks: new Map(),
    taskDedup: new Map(),
    auditExports: new Map(),
    auditLog: [],
    deletedTasks: new Map(),
  };
}

function resetState(state) {
  state.csrfToken = CSRF_TOKEN;
  state.org = {
    id: 'org1',
    name: '试点组织',
    status: 'active',
    execution_enabled: true,
    home_region: 'cn-north',
    revision: 0,
    audit_retention_days: 365,
  };
  state.subjectId = 'user1';
  state.members = new Map([
    ['user1', { subject_id: 'user1', role: 'owner', work_seat: true, status: 'active', revision: 0 }],
  ]);
  state.budget = { currency: 'CNY', limitCents: 10000, periodId: currentPeriodId() };
  state.auditLog.length = 0;
  state.deletedTasks.clear();
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

function requireClientRequestId(body) {
  if (typeof body.client_request_id !== 'string' || body.client_request_id.length < 8) {
    fail(400, 'invalid_request', 'client_request_id 至少 8 字符');
  }
}

// Same key + same body returns the stored response; same key + different body is a conflict.
function replayed(state, key, body) {
  const previous = state.taskDedup.get(key);
  if (!previous) return null;
  if (previous.requestHash !== sha256(stableStringify(body))) {
    fail(409, 'idempotency_key_conflict', '同一 client_request_id 的请求内容不同');
  }
  return previous.response;
}

function remember(state, key, body, status, payload) {
  state.taskDedup.set(key, { requestHash: sha256(stableStringify(body)), response: { status, payload } });
  return { status, payload };
}

function contentDisposition(task, artifact, version) {
  const ext = version.mediaType === 'text/plain' ? 'txt' : 'md';
  const ascii = `work-${artifact.id.slice(0, 8)}-v${version.versionNo}.${ext}`;
  const label = (task.title || 'work')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${label}-v${version.versionNo}.${ext}`)}`;
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
  const status = error.status ?? 503;
  const code = error.code ?? 'service_degraded';
  const entry = ERROR_CATALOG.public[code];
  const retryable = entry ? entry.retryable : status >= 500;
  const recovery = error.extra?.recovery_action ?? entry?.recovery_action ?? null;
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
  const title = [...input.goal.trim()].slice(0, 20).join('');
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
    addEvent(task, 'run.canceled', { run_id: run.id, reason: 'user_requested' }, run.id);
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
      org: {
        id: state.org.id,
        name: state.org.name,
        role: memberOf(state, state.subjectId)?.role ?? 'viewer',
        work_seat: memberOf(state, state.subjectId)?.work_seat ?? false,
      },
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
    requireEntitlement(state);
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
    requireCsrf(req, state);
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
    const body = await readJson(req);
    requireClientRequestId(body);
    const key = `retry:${task.id}:${body.client_request_id}`;
    const prior = replayed(state, key, body);
    if (prior) return sendJson(res, prior.status, prior.payload);
    if (!Number.isInteger(body.expected_revision) || body.expected_revision < 0) {
      fail(400, 'invalid_request', 'expected_revision 必填');
    }
    if (!body.target || body.target.kind !== 'cloud' || body.target.profile !== 'text-v1') {
      fail(422, 'execution_target_unavailable', 'R0a 只支持 cloud/text-v1');
    }
    if (body.expected_revision !== task.revision) {
      fail(409, 'version_conflict', '任务 revision 已变化', { current_revision: task.revision });
    }
    if (task.activeRunId) fail(409, 'task_has_active_run', '任务已有活动运行');
    const latest = task.latestRunId ? task.runs.get(task.latestRunId) : null;
    if (task.state !== 'open' || !latest || !['failed', 'canceled'].includes(latest.state)) {
      fail(409, 'task_not_runnable', '任务状态不可重试');
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
    const out = remember(state, key, body, 202, { task: summary(task), run: runView(run) });
    return sendJson(res, out.status, out.payload);
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
    requireClientRequestId(body);
    const key = `accept:${task.id}:${body.client_request_id}`;
    const prior = replayed(state, key, body);
    if (prior) return sendJson(res, prior.status, prior.payload);
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
    const out = remember(state, key, body, 200, { acceptance, task: summary(task) });
    return sendJson(res, out.status, out.payload);
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)$/)) && method === 'GET') {
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    return sendJson(res, 200, taskDetail(task));
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)$/)) && method === 'DELETE') {
    requireCsrf(req, state);
    const previous = state.deletedTasks.get(match[1]);
    if (previous) return sendJson(res, 200, previous);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    const expected = url.searchParams.get('expected_revision');
    if (expected === null || !/^\d+$/.test(expected)) {
      fail(400, 'invalid_request', 'expected_revision 必填');
    }
    if (Number(expected) !== task.revision) {
      fail(409, 'version_conflict', '任务 revision 已变化', { current_revision: task.revision });
    }
    const blocking = [...task.operations.values()].some((op) => BLOCKING_STATES.has(op.state));
    const latest = task.latestRunId ? task.runs.get(task.latestRunId) : null;
    if (task.activeRunId || blocking || (latest && !TERMINAL_RUN_STATES.has(latest.state))) {
      fail(409, 'run_not_quiescent', '任务仍在运行或有未核对动作，取消并等待结束后再删除');
    }
    const receipt = { task_id: task.id, deleted_at: now(), content_purge: 'scheduled' };
    state.tasks.delete(task.id);
    state.deletedTasks.set(task.id, receipt);
    state.auditLog.push({
      action: 'task.deleted',
      actor_subject_id: state.subjectId,
      target_id: task.id,
      artifacts: task.artifacts.size,
      at: receipt.deleted_at,
    });
    return sendJson(res, 200, receipt);
  }

  if ((match = pathname.match(/^\/work\/v1\/tasks\/([0-9a-f-]+)$/)) && method === 'PATCH') {
    requireCsrf(req, state);
    const task = state.tasks.get(match[1]);
    if (!task) fail(404, 'task_not_found', '任务不存在');
    const body = await readJson(req);
    const extra = Object.keys(body).filter(
      (key) => !['client_request_id', 'expected_revision', 'title'].includes(key),
    );
    if (extra.length > 0) fail(400, 'invalid_request', `不允许的字段：${extra.join(',')}`);
    if (typeof body.client_request_id !== 'string' || body.client_request_id.length < 8) {
      fail(400, 'invalid_request', 'client_request_id 至少 8 字符');
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!title || [...title].length > 80 || /[\u0000-\u001f\u007f]/.test(title)) {
      fail(422, 'title_invalid', '标题需 1–80 字符且不含控制字符');
    }
    const dedupKey = `title:${task.id}:${body.client_request_id}`;
    const previous = state.taskDedup.get(dedupKey);
    if (previous) {
      if (previous.title !== title) fail(409, 'idempotency_key_conflict', '同一请求键的内容不同');
      return sendJson(res, 200, summary(task));
    }
    if (body.expected_revision !== task.revision) {
      fail(409, 'version_conflict', '任务 revision 已变化', { current_revision: task.revision });
    }
    if (task.state === 'archived') fail(409, 'task_archived', '已归档任务不可编辑');
    task.title = title;
    task.revision += 1;
    task.updatedAt = now();
    state.taskDedup.set(dedupKey, { title });
    addEvent(task, 'task.updated', { task_id: task.id, fields: ['title'] }, null);
    return sendJson(res, 200, summary(task));
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
      addEvent(task, 'run.cancel_requested', { run_id: run.id, reason: 'user_requested' }, run.id);
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
    requireClientRequestId(body);
    const key = `version:${artifact.id}:${body.client_request_id}`;
    const prior = replayed(state, key, body);
    if (prior) return sendJson(res, prior.status, prior.payload);
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 262144) {
      fail(422, 'artifact_too_large', '成果正文超过 R0a 限制');
    }
    const latestRun = task.latestRunId ? task.runs.get(task.latestRunId) : null;
    if (
      !['open', 'awaiting_acceptance'].includes(task.state)
      || (latestRun && ['failed', 'canceled'].includes(latestRun.state))
    ) {
      fail(409, 'artifact_read_only', '任务已结束或最近运行未成功，成果只读');
    }
    if (task.activeRunId) fail(409, 'run_not_quiescent', '任务仍有活动运行');
    if (!Number.isInteger(body.base_version_no) || body.base_version_no < 1) {
      fail(400, 'invalid_request', 'base_version_no 必填且 ≥1');
    }
    if (body.base_version_no !== artifact.latestVersionNo) {
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
    const out = remember(state, key, body, 201, versionView(req, artifact, version));
    return sendJson(res, out.status, out.payload);
  }

  if ((match = pathname.match(/^\/work\/v1\/artifacts\/([0-9a-f-]+)\/versions\/(\d+)\/content$/)) && method === 'GET') {
    const found = findArtifact(state, match[1]);
    if (!found) fail(404, 'artifact_not_found', '成果不存在');
    const version = found.artifact.versions.find((v) => v.versionNo === Number(match[2]));
    if (!version) fail(404, 'version_not_found', '成果版本不存在');
    const disposition = url.searchParams.get('disposition') ?? 'inline';
    if (!['inline', 'attachment'].includes(disposition)) {
      fail(400, 'invalid_request', 'disposition 只能是 inline 或 attachment');
    }
    const headers = {
      'Content-Type': `${version.mediaType}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (disposition === 'attachment') {
      headers['Content-Disposition'] = contentDisposition(found.task, found.artifact, version);
      state.auditLog.push({
        action: 'artifact.exported',
        actor_subject_id: state.subjectId,
        target_id: found.artifact.id,
        version_no: version.versionNo,
        content_hash: version.contentHash,
        at: now(),
      });
    }
    res.writeHead(200, headers);
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
    requireAdmin(state);
    const cents = [...state.tasks.values()].reduce(
      (acc, task) => {
        acc.settled += task.budget.settledCents;
        acc.reserved += task.budget.reservedCents ?? 0;
        return acc;
      },
      { settled: 0, reserved: 0 },
    );
    const seats = seatRows(state);
    return sendJson(res, 200, {
      org_id: state.org.id,
      name: state.org.name,
      status: state.org.status,
      execution_enabled: state.org.execution_enabled,
      seats: {
        total: seats.length,
        active: seats.filter((seat) => seat.status === 'active' && seat.work_seat).length,
      },
      budget: {
        currency: state.budget.currency,
        limit_cents: state.budget.limitCents,
        reserved_cents: cents.reserved,
        settled_cents: cents.settled,
      },
      budget_period_id: state.budget.periodId,
      org_revision: state.org.revision,
      audit_retention_days: state.org.audit_retention_days,
    });
  }

  if (method === 'GET' && pathname === '/work/v1/admin/seats') {
    requireAdmin(state);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? 20 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      fail(400, 'invalid_pagination', 'limit 需在 1..100');
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && cursor.trim() === '') fail(400, 'invalid_pagination', 'cursor 不能为空串');
    // keyset 分页与 work.list_seats 一致：按 subject_id 升序，cursor 是上一页最后一个 subject_id。
    const ordered = seatRows(state).filter((seat) => !cursor || seat.subject_id > cursor);
    const items = ordered.slice(0, limit);
    return sendJson(res, 200, {
      items,
      next_cursor: ordered.length > limit ? items[items.length - 1].subject_id : null,
    });
  }

  if (method === 'POST' && pathname === '/work/v1/admin/audit-exports') {
    requireCsrf(req, state);
    const actor = requireAdmin(state);
    const body = await readJson(req);
    requireClientRequestId(body);
    if (!['csv', 'json'].includes(body.format)) fail(400, 'invalid_request', 'format 只能是 csv 或 json');
    const rangeFrom = body.range_from;
    const rangeTo = body.range_to;
    const fromMs = Date.parse(rangeFrom ?? '');
    const toMs = Date.parse(rangeTo ?? '');
    const invalidRange = !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      fromMs >= toMs ||
      toMs > Date.now() + 60_000 ||
      toMs - fromMs > 92 * 86_400_000 ||
      fromMs < Date.now() - state.org.audit_retention_days * 86_400_000;
    if (invalidRange) fail(422, 'audit_export_range_invalid', '导出时间范围非法');
    const requestHash = sha256(JSON.stringify([body.client_request_id, rangeFrom, rangeTo, body.format]));
    const existing = [...state.auditExports.values()]
      .find((job) => job.clientRequestId === body.client_request_id);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        fail(409, 'idempotency_key_conflict', '同一 client_request_id 携带了不同参数');
      }
      return sendJson(res, 202, exportView(expireIfNeeded(existing)));
    }
    const job = {
      id: uuid(),
      clientRequestId: body.client_request_id,
      requestHash,
      status: 'queued',
      format: body.format,
      rangeFrom,
      rangeTo,
      requestedBy: actor.subject_id,
      requestedAt: now(),
      readyAt: null,
      expiresAt: null,
      rowCount: null,
      bytes: null,
      errorCode: null,
      contentRef: null,
      contentHash: null,
      body: null,
      leaseOwner: null,
      leaseUntil: null,
      tokenHash: null,
      tokenExpiresAt: null,
      downloadedAt: null,
    };
    state.auditExports.set(job.id, job);
    state.auditLog.push({
      action: 'audit_export.requested',
      actor_subject_id: actor.subject_id,
      target_type: 'audit_export',
      target_id: job.id,
      at: now(),
    });
    return sendJson(res, 202, exportView(job));
  }

  if ((match = pathname.match(/^\/work\/v1\/admin\/audit-exports\/([0-9a-f-]+)$/)) && method === 'GET') {
    requireAdmin(state);
    return sendJson(res, 200, exportView(expireIfNeeded(findExport(state, match[1]))));
  }

  if ((match = pathname.match(/^\/work\/v1\/admin\/audit-exports\/([0-9a-f-]+)\/download-ticket$/)) && method === 'POST') {
    requireCsrf(req, state);
    const actor = requireAdmin(state);
    const job = expireIfNeeded(findExport(state, match[1]));
    const options = await readJson(req);
    const ttl = options.ttl_seconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) fail(400, 'invalid_request', 'ttl_seconds 需在 60..900');
    const token = issueTicketFor(state, job, actor, ttl);
    return sendJson(res, 200, {
      token,
      expires_at: job.tokenExpiresAt,
      format: job.format,
      row_count: job.rowCount,
      bytes: job.bytes,
    });
  }

  if ((match = pathname.match(/^\/work\/v1\/admin\/audit-exports\/([0-9a-f-]+)\/content$/)) && method === 'GET') {
    const actor = requireAdmin(state);
    const job = expireIfNeeded(findExport(state, match[1]));
    const token = req.headers['x-download-token'];
    if (typeof token !== 'string' || !/^[0-9a-f]{16,128}$/.test(token)) {
      fail(403, 'download_token_invalid', '缺少或非法的一次性下载凭证');
    }
    if (!job.tokenHash || job.tokenHash !== sha256(token)) {
      fail(403, 'download_token_invalid', '下载凭证无效或已被使用');
    }
    if (Date.parse(job.tokenExpiresAt) <= Date.now()) {
      job.tokenHash = null;
      job.tokenExpiresAt = null;
      fail(410, 'download_token_expired', '下载凭证已过期');
    }
    if (job.downloadedAt) fail(403, 'download_token_invalid', '下载凭证已使用');
    job.downloadedAt = now();
    job.tokenHash = null;
    state.auditLog.push({
      action: 'audit_export.downloaded',
      actor_subject_id: actor.subject_id,
      target_type: 'audit_export',
      target_id: job.id,
      at: now(),
    });
    return sendText(res, job.body, job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="work-audit-${job.id.slice(0, 8)}.${job.format}"`,
    });
  }

  if (method === 'POST' && pathname === '/__test/directory/sync-org') {
    requireCsrf(req, state);
    const body = await readJson(req);
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision <= state.org.revision) {
      // D1 把投影修订号回退当作内部错误，公开面统一映射 service_degraded。
      fail(503, 'service_degraded', '目录投影修订号必须递增');
    }
    if (!['active', 'suspended', 'archived'].includes(body.status)) {
      fail(400, 'invalid_request', 'org status 非法');
    }
    state.org = {
      ...state.org,
      name: body.name ?? state.org.name,
      status: body.status,
      execution_enabled: body.execution_enabled ?? false,
      home_region: body.home_region ?? state.org.home_region,
      revision,
      audit_retention_days: body.audit_retention_days ?? state.org.audit_retention_days,
    };
    return sendJson(res, 200, { ...state.org });
  }

  if (method === 'POST' && pathname === '/__test/directory/sync-member') {
    requireCsrf(req, state);
    const body = await readJson(req);
    if (!body.subject_id) fail(400, 'invalid_request', 'subject_id 必填');
    const existing = memberOf(state, body.subject_id);
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || (existing && revision <= existing.revision)) {
      fail(503, 'service_degraded', '成员投影修订号必须递增');
    }
    const role = body.role ?? existing?.role ?? 'viewer';
    const status = body.status ?? existing?.status ?? 'active';
    if (!['owner', 'admin', 'member', 'viewer'].includes(role)) fail(400, 'invalid_request', 'role 非法');
    if (!['invited', 'active', 'suspended', 'left'].includes(status)) fail(400, 'invalid_request', 'status 非法');
    const member = {
      subject_id: body.subject_id,
      role,
      work_seat: body.work_seat ?? existing?.work_seat ?? false,
      status,
      revision,
    };
    state.members.set(member.subject_id, member);
    return sendJson(res, 200, member);
  }

  if (method === 'POST' && pathname === '/__test/subject') {
    requireCsrf(req, state);
    const body = await readJson(req);
    if (!body.subject_id) fail(400, 'invalid_request', 'subject_id 必填');
    state.subjectId = body.subject_id;
    return sendJson(res, 200, { ok: true, subject_id: state.subjectId });
  }

  if (method === 'POST' && pathname === '/__test/export-worker/run') {
    requireCsrf(req, state);
    const options = await readJson(req);
    return sendJson(res, 200, { jobs: runExportWorker(state, options) });
  }

  if ((match = pathname.match(/^\/__test\/export\/([0-9a-f-]+)\/expire$/)) && method === 'POST') {
    requireCsrf(req, state);
    const job = findExport(state, match[1]);
    if (job.status !== 'ready') fail(409, 'audit_export_not_ready', '只有就绪作业可以过期');
    job.status = 'expired';
    job.expiresAt = null;
    job.tokenHash = null;
    job.tokenExpiresAt = null;
    return sendJson(res, 200, exportView(job));
  }

  if ((match = pathname.match(/^\/__test\/export\/([0-9a-f-]+)\/expire-ticket$/)) && method === 'POST') {
    requireCsrf(req, state);
    const job = findExport(state, match[1]);
    if (!job.tokenHash) fail(409, 'audit_export_not_ready', '尚未发放下载凭证');
    job.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/__test/reset') {
    resetState(state);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/__test/rotate-csrf') {
    state.csrfToken = `rotated-${uuid()}`;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createWorkServer();
  const port = await app.listen();
  console.log(`work-r0a mock listening on http://127.0.0.1:${port}`);
}

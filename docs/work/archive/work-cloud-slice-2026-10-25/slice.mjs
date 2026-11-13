import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.resolve(__dirname, '../work-ddl-draft-2026-10-25.sql');

const cfg = {
  adminDatabaseUrl:
    process.env.ADMIN_DATABASE_URL ||
    'postgresql://postgres:test@127.0.0.1:55436/work_slice',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://work_slice_app:app@127.0.0.1:55436/work_slice',
  devToken: process.env.DEV_TOKEN || 'slice-dev-token',
  orgId: process.env.ORG_ID || 'org-slice',
  subjectId: process.env.SUBJECT_ID || 'alice',
  contentDir: path.resolve(
    process.env.CONTENT_DIR || path.join(__dirname, 'content'),
  ),
  port: process.env.PORT !== undefined ? Number(process.env.PORT) : 8877,
  priceVersion: 'price-v1',
  resolverVersion: 'slice-v1',
  periodId: '2026-10',
  budgetLimitCents: 1000,
  modelReserveCents: 20,
  modelCostCents: 12,
  toolReserveCents: 10,
  toolCostCents: 3,
  previewTtlMs: 10 * 60 * 1000,
  runtimeVersion: 'slice-runtime-v1',
};

const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.currentRevision = extra.current_revision ?? null;
    this.recoveryAction = extra.recovery_action ?? null;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(canonical(value));
  return crypto.createHash('sha256').update(text).digest('hex');
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapDbError(error) {
  const message = String(error?.message || '').split('\n')[0];
  if (error instanceof ApiError) return error;
  if (error?.code === '23505') {
    return new ApiError(409, 'version_conflict', message);
  }
  if (error?.code === 'P0002') {
    return new ApiError(404, 'invalid_request', message);
  }
  if (
    message.includes('budget_exhausted') ||
    message.includes('operation_has_active_reservation')
  ) {
    return new ApiError(409, 'budget_exhausted', message);
  }
  if (
    message.includes('task_has_active_run') ||
    message.includes('task_has_unresolved_operation') ||
    message.includes('run_not_quiescent') ||
    message.includes('run_not_current') ||
    message.includes('run_not_queued') ||
    message.includes('run_has_unresolved_operation') ||
    message.includes('invalid_transition')
  ) {
    return new ApiError(409, 'run_not_quiescent', message);
  }
  if (
    message.includes('snapshot_not_in_task') ||
    message.includes('artifact_not_published') ||
    message.includes('invalid_request')
  ) {
    return new ApiError(422, 'invalid_request', message);
  }
  if (message.includes('operation_not_reservable')) {
    return new ApiError(422, 'invalid_request', message);
  }
  return new ApiError(500, 'service_degraded', message);
}

async function withAppTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [cfg.orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDbError(error);
  } finally {
    client.release();
  }
}

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: cfg.adminDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function initDb() {
  const ddl = await fs.readFile(DDL_PATH, 'utf8');
  await withAdmin(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE usename = 'work_slice_app' AND pid <> pg_backend_pid()`,
    );
    await client.query('DROP SCHEMA IF EXISTS work CASCADE');
    await client.query('DROP ROLE IF EXISTS work_slice_app');
    await client.query(
      "CREATE ROLE work_slice_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS",
    );
    await client.query(ddl);
    await client.query(`
      GRANT USAGE ON SCHEMA work TO work_slice_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA work TO work_slice_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA work TO work_slice_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA work TO work_slice_app;
    `);
    await client.query(
      `INSERT INTO work.org (id, status, execution_enabled, home_region)
       VALUES ($1, 'active', true, 'cn-north')
       ON CONFLICT (id) DO UPDATE SET status = 'active', execution_enabled = true`,
      [cfg.orgId],
    );
    await client.query(
      `INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
       VALUES ($1, $2, 'active', 'owner', true)
       ON CONFLICT (org_id, subject_id)
       DO UPDATE SET status = 'active', role = 'owner', work_seat = true`,
      [cfg.orgId, cfg.subjectId],
    );
    await client.query(
      `INSERT INTO work.org_policy
         (org_id, revision, force_ask_each, allow_auto_readonly, allow_plan_approval, policy)
       VALUES ($1, 1, false, true, false, '{"schema":"org-policy-v1"}'::jsonb)
       ON CONFLICT (org_id) DO UPDATE SET
         revision = 1, force_ask_each = false,
         allow_auto_readonly = true, allow_plan_approval = false`,
      [cfg.orgId],
    );
    await client.query(
      `INSERT INTO work.budget_account
         (org_id, account_key, period_id, currency, limit_cents)
       VALUES ($1, 'default', $2, 'CNY', $3)
       ON CONFLICT (org_id, account_key, period_id)
       DO UPDATE SET currency = 'CNY', limit_cents = EXCLUDED.limit_cents,
                     reserved_cents = 0, settled_cents = 0`,
      [cfg.orgId, cfg.periodId, cfg.budgetLimitCents],
    );
  });
  await fs.rm(cfg.contentDir, { recursive: true, force: true });
  await fs.mkdir(cfg.contentDir, { recursive: true });
  console.log('INIT_OK');
}

async function getPolicy(client) {
  const result = await client.query(
    `SELECT revision, force_ask_each, allow_auto_readonly, allow_plan_approval
     FROM work.org_policy WHERE org_id = $1`,
    [cfg.orgId],
  );
  if (!result.rowCount) {
    throw new ApiError(503, 'service_degraded', 'org_policy_missing', {
      retryable: true,
    });
  }
  return result.rows[0];
}

function normalizeIntent(input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'invalid_request', 'intent_required');
  }
  const intent = {
    input_ref: input.input_ref,
    target: input.target,
    suite: input.suite ?? null,
    supplemental_skills: input.supplemental_skills ?? [],
    connectors: input.connectors ?? [],
    permission_mode: input.permission_mode ?? 'ask_each',
    output: input.output ?? { format: 'markdown', logical_name: 'result.md' },
  };
  if (
    typeof intent.input_ref !== 'string' ||
    intent.input_ref.length === 0 ||
    intent.input_ref.length > 2000
  ) {
    throw new ApiError(422, 'invalid_request', 'input_ref_invalid');
  }
  if (!intent.target || intent.target.kind !== 'cloud') {
    throw new ApiError(422, 'scope_unavailable', 'r0a_requires_cloud_target');
  }
  if (intent.target.device_id) {
    throw new ApiError(422, 'scope_unavailable', 'cloud_target_has_no_device');
  }
  if (intent.suite || intent.supplemental_skills.length || intent.connectors.length) {
    throw new ApiError(422, 'scope_unavailable', 'r0a_has_no_suite_or_connectors');
  }
  if (!['ask_each', 'auto_readonly', 'plan_then_run'].includes(intent.permission_mode)) {
    throw new ApiError(
      422,
      'permission_mode_unavailable',
      'unknown_permission_mode',
    );
  }
  if (!['markdown', 'txt', 'csv', 'json'].includes(intent.output?.format)) {
    throw new ApiError(422, 'invalid_request', 'unsupported_output_format');
  }
  if (intent.output.logical_name && !/^[\w.-]{1,120}$/.test(intent.output.logical_name)) {
    throw new ApiError(422, 'invalid_request', 'invalid_logical_name');
  }
  return intent;
}

function effectiveMode(policy, intent) {
  if (policy.force_ask_each && intent.permission_mode !== 'ask_each') {
    throw new ApiError(
      422,
      'permission_mode_unavailable',
      'organization_forces_ask_each',
    );
  }
  if (intent.permission_mode === 'auto_readonly' && !policy.allow_auto_readonly) {
    throw new ApiError(
      422,
      'permission_mode_unavailable',
      'auto_readonly_not_allowed',
    );
  }
  if (intent.permission_mode === 'plan_then_run' && !policy.allow_plan_approval) {
    throw new ApiError(
      422,
      'permission_mode_unavailable',
      'plan_approval_not_allowed',
    );
  }
  return intent.permission_mode;
}

function previewHash(intent, policyRevision) {
  return `sha256:${sha256({
    org_id: cfg.orgId,
    policy_revision: policyRevision,
    price_version: cfg.priceVersion,
    resolver_version: cfg.resolverVersion,
    intent: {
      input_ref: intent.input_ref,
      target: intent.target,
      suite: intent.suite,
      supplemental_skills: intent.supplemental_skills,
      connectors: intent.connectors,
      permission_mode: intent.permission_mode,
      output: intent.output,
    },
  })}`;
}

function preview(intentInput, policy) {
  const intent = normalizeIntent(intentInput);
  const mode = effectiveMode(policy, intent);
  return {
    preview_hash: previewHash({ ...intent, permission_mode: mode }, policy.revision),
    effective_permission_mode: mode,
    allowed_permission_modes: allowedModes(policy),
    boundary_summary: [
      '执行目标：云端隔离 Runtime',
      '模型路由：faux-r0a（切片模拟，无真实供应商调用）',
      '工具：仅 artifact.markdown；写入前需要审批',
      '数据：仅提交 input_ref，不上传原始文件',
      '预算上界：模型 20 + 工具 10 分（CNY）',
    ],
    cost_upper_bound: {
      amount_cents: cfg.modelReserveCents + cfg.toolReserveCents,
      currency: 'CNY',
      price_version: cfg.priceVersion,
    },
    unavailable_reasons: [],
    expires_at: new Date(Date.now() + cfg.previewTtlMs).toISOString(),
  };
}

function allowedModes(policy) {
  if (policy.force_ask_each) return ['ask_each'];
  const modes = ['ask_each'];
  if (policy.allow_auto_readonly) modes.push('auto_readonly');
  if (policy.allow_plan_approval) modes.push('plan_then_run');
  return modes;
}

async function bootstrap() {
  return withAppTx(async (client) => {
    const org = await client.query(
      `SELECT id, home_region FROM work.org WHERE id = $1`,
      [cfg.orgId],
    );
    const member = await client.query(
      `SELECT subject_id, role, work_seat FROM work.member
       WHERE org_id = $1 AND subject_id = $2`,
      [cfg.orgId, cfg.subjectId],
    );
    const policy = await getPolicy(client);
    return {
      subject_id: cfg.subjectId,
      org: {
        id: org.rows[0].id,
        name: 'Work Slice Org',
        role: member.rows[0]?.role ?? 'member',
        work_seat: member.rows[0]?.work_seat ?? false,
      },
      permissions: ['work.task.create', 'work.task.accept', 'work.approval.decide'],
      phases: ['R0a'],
      execution_targets: [{ kind: 'cloud', profile: 'text-v1' }],
      allowed_permission_modes: allowedModes(policy),
      limits: {
        max_supplemental_skills: 0,
        max_active_runs: 3,
        max_input_bytes: 1048576,
      },
    };
  });
}

async function submitTask(body) {
  if (
    typeof body?.client_request_id !== 'string' ||
    body.client_request_id.length < 8
  ) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  if (typeof body.preview_hash !== 'string' || !body.preview_hash) {
    throw new ApiError(400, 'invalid_request', 'preview_hash_required');
  }
  const intent = normalizeIntent(body.intent);
  const requestHash = sha256(body);
  return withAppTx(async (client) => {
    const policy = await getPolicy(client);
    const mode = effectiveMode(policy, intent);
    const expectedPreview = previewHash(
      { ...intent, permission_mode: mode },
      policy.revision,
    );
    if (body.preview_hash !== expectedPreview) {
      throw new ApiError(409, 'preview_stale', 'preview_hash_mismatch');
    }
    const dedup = await client.query(
      `INSERT INTO work.submission_dedup
         (org_id, subject_id, operation_type, client_request_id, request_hash, result_state)
       VALUES ($1, $2, 'task_submit', $3, $4, 'accepted')
       ON CONFLICT DO NOTHING
       RETURNING client_request_id`,
      [cfg.orgId, cfg.subjectId, body.client_request_id, requestHash],
    );
    if (!dedup.rowCount) {
      const existing = await client.query(
        `SELECT request_hash, task_id, task_deleted
         FROM work.submission_dedup
         WHERE org_id = $1 AND subject_id = $2
           AND operation_type = 'task_submit' AND client_request_id = $3`,
        [cfg.orgId, cfg.subjectId, body.client_request_id],
      );
      if (!existing.rowCount) {
        throw new ApiError(503, 'service_degraded', 'dedup_not_visible', {
          retryable: true,
        });
      }
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, 'idempotency_conflict', 'payload_mismatch');
      }
      return loadTaskRun(client, existing.rows[0].task_id);
    }

    const taskId = uuid();
    const snapshotId = uuid();
    const workflowId = `slice-${taskId}`;
    const snapshotHash = `sha256:${sha256({
      resolver_version: cfg.resolverVersion,
      intent,
      permission_mode: mode,
    })}`;
    await client.query(
      `INSERT INTO work.task
         (id, org_id, owner_subject_id, state, permission_mode, revision)
       VALUES ($1, $2, $3, 'open', $4, 0)`,
      [taskId, cfg.orgId, cfg.subjectId, mode],
    );
    await client.query(
      `INSERT INTO work.capability_snapshot
         (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
          model_route, scope_caps, price_version, manifest)
       VALUES ($1, $2, $3, $4, $5, ARRAY['model.text','artifact.markdown']::text[],
               '{"provider":"faux","model":"faux-r0a"}'::jsonb,
               '{"connectors":[]}'::jsonb, $6, $7::jsonb)`,
      [
        snapshotId,
        cfg.orgId,
        taskId,
        cfg.resolverVersion,
        snapshotHash,
        cfg.priceVersion,
        JSON.stringify({ intent, permission_mode: mode }),
      ],
    );
    await client.query(
      `UPDATE work.task SET snapshot_id = $1 WHERE id = $2 AND org_id = $3`,
      [snapshotId, taskId, cfg.orgId],
    );
    const runResult = await client.query(
      `SELECT work.create_run($1, $2, $3, $4, $5) AS run_id`,
      [taskId, cfg.orgId, snapshotId, workflowId, cfg.runtimeVersion],
    );
    await client.query(
      `UPDATE work.submission_dedup SET task_id = $1
       WHERE org_id = $2 AND subject_id = $3
         AND operation_type = 'task_submit' AND client_request_id = $4`,
      [taskId, cfg.orgId, cfg.subjectId, body.client_request_id],
    );
    return loadTaskRun(client, taskId, runResult.rows[0].run_id);
  });
}

async function loadTaskRun(client, taskId, runId = null) {
  const task = await getTask(client, taskId);
  let run;
  if (runId) {
    run = await getRun(client, runId);
  } else if (task.latest_run_id) {
    run = await getRun(client, task.latest_run_id);
  }
  return { task, run };
}

async function getTask(client, taskId) {
  const result = await client.query(
    `SELECT id, owner_subject_id, state, permission_mode, active_run_id,
            latest_run_id, revision, created_at, updated_at
     FROM work.task
     WHERE id = $1 AND org_id = $2 AND owner_subject_id = $3`,
    [taskId, cfg.orgId, cfg.subjectId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'task_not_found');
  return mapTask(result.rows[0]);
}

function mapTask(row) {
  return {
    id: row.id,
    owner_subject_id: row.owner_subject_id,
    state: row.state,
    permission_mode: row.permission_mode,
    active_run_id: row.active_run_id,
    latest_run_id: row.latest_run_id,
    revision: Number(row.revision),
    created_at: nowIso(row.created_at),
    updated_at: nowIso(row.updated_at),
  };
}

async function getRun(client, runId) {
  const result = await client.query(
    `SELECT r.id, r.task_id, r.attempt_no, r.state, r.wait_reason,
            r.terminal_reason, r.snapshot_id, r.fence, r.control_revision,
            r.runtime_version, r.created_at, r.updated_at
     FROM work.run r
     JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
     WHERE r.id = $1 AND r.org_id = $2 AND t.owner_subject_id = $3`,
    [runId, cfg.orgId, cfg.subjectId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'run_not_found');
  const row = result.rows[0];
  return {
    id: row.id,
    task_id: row.task_id,
    attempt_no: row.attempt_no,
    state: row.state,
    wait_reason: row.wait_reason,
    terminal_reason: row.terminal_reason,
    snapshot_id: row.snapshot_id,
    target: { kind: 'cloud', profile: 'text-v1' },
    fence: Number(row.fence),
    control_revision: Number(row.control_revision),
    runtime_version: row.runtime_version,
    created_at: nowIso(row.created_at),
    updated_at: nowIso(row.updated_at),
  };
}

async function listTasks(client, state) {
  const params = [cfg.orgId, cfg.subjectId];
  let sql = `SELECT id, owner_subject_id, state, permission_mode, active_run_id,
                    latest_run_id, revision, created_at, updated_at
             FROM work.task
             WHERE org_id = $1 AND owner_subject_id = $2`;
  if (state) {
    params.push(state);
    sql += ` AND state = $3`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 50`;
  const result = await client.query(sql, params);
  return { items: result.rows.map(mapTask), next_cursor: null };
}

async function listOperations(client, runId) {
  await getRun(client, runId);
  const result = await client.query(
    `SELECT id, run_id, logical_key, kind, state, request_hash,
            provider_request_id, receipt_ref, revision, created_at
     FROM work.operation
     WHERE org_id = $1 AND run_id = $2
     ORDER BY created_at, logical_key`,
    [cfg.orgId, runId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    run_id: row.run_id,
    logical_key: row.logical_key,
    kind: row.kind,
    state: row.state,
    request_hash: row.request_hash,
    provider_request_id: row.provider_request_id,
    receipt_ref: row.receipt_ref,
    revision: Number(row.revision),
    created_at: nowIso(row.created_at),
  }));
}

async function listApprovals(client, status) {
  const params = [cfg.orgId, cfg.subjectId];
  let sql = `SELECT a.id, a.params_hash, a.scope, a.risk, a.expires_at,
                    a.status, a.revision, o.id AS operation_id, o.run_id,
                    r.task_id
             FROM work.approval a
             JOIN work.approval_operation ao ON ao.approval_id = a.id
             JOIN work.operation o ON o.id = ao.operation_id
             JOIN work.run r ON r.id = o.run_id
             JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
             WHERE a.org_id = $1 AND t.owner_subject_id = $2`;
  if (status) {
    params.push(status);
    sql += ` AND a.status = $3`;
  }
  sql += ` ORDER BY a.created_at DESC LIMIT 50`;
  const result = await client.query(sql, params);
  return result.rows.map(mapApproval);
}

function mapApproval(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    run_id: row.run_id,
    target_type: 'operation',
    operation_id: row.operation_id,
    plan_version_id: null,
    params_hash: row.params_hash,
    scope: row.scope,
    risk: row.risk,
    expires_at: nowIso(row.expires_at),
    status: row.status,
    revision: Number(row.revision),
  };
}

async function getApprovalForUpdate(client, approvalId) {
  const base = await client.query(
    `SELECT r.task_id, o.run_id, o.id AS operation_id
     FROM work.approval a
     JOIN work.approval_operation ao ON ao.approval_id = a.id
     JOIN work.operation o ON o.id = ao.operation_id
     JOIN work.run r ON r.id = o.run_id
     WHERE a.id = $1 AND a.org_id = $2`,
    [approvalId, cfg.orgId],
  );
  if (!base.rowCount) throw new ApiError(404, 'invalid_request', 'approval_not_found');
  const refs = base.rows[0];
  await client.query(`SELECT id FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
    refs.task_id,
    cfg.orgId,
  ]);
  await client.query(`SELECT id FROM work.run WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
    refs.run_id,
    cfg.orgId,
  ]);
  await client.query(
    `SELECT id FROM work.operation WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [refs.operation_id, cfg.orgId],
  );
  const result = await client.query(
    `SELECT a.id, a.params_hash, a.scope, a.risk, a.expires_at, a.status,
            a.revision, a.policy_epoch, o.id AS operation_id, o.run_id, r.task_id
     FROM work.approval a
     JOIN work.approval_operation ao ON ao.approval_id = a.id
     JOIN work.operation o ON o.id = ao.operation_id
     JOIN work.run r ON r.id = o.run_id
     WHERE a.id = $1 AND a.org_id = $2
     FOR UPDATE OF a`,
    [approvalId, cfg.orgId],
  );
  return result.rows[0];
}

async function decideApproval(approvalId, body) {
  if (
    typeof body?.client_request_id !== 'string' ||
    body.client_request_id.length < 8
  ) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  if (!['approved', 'rejected'].includes(body.decision)) {
    throw new ApiError(422, 'invalid_request', 'invalid_decision');
  }
  return withAppTx(async (client) => {
    const approval = await getApprovalForUpdate(client, approvalId);
    if (approval.task_id == null) {
      throw new ApiError(404, 'invalid_request', 'approval_not_found');
    }
    if (approval.status !== 'pending') {
      throw new ApiError(409, 'version_conflict', 'approval_not_pending', {
        current_revision: Number(approval.revision),
      });
    }
    if (Number(body.expected_revision) !== Number(approval.revision)) {
      throw new ApiError(409, 'version_conflict', 'approval_revision_mismatch', {
        current_revision: Number(approval.revision),
      });
    }
    if (body.params_hash !== approval.params_hash) {
      throw new ApiError(409, 'version_conflict', 'approval_params_changed');
    }
    if (new Date(approval.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE work.approval SET status = 'expired', revision = revision + 1
         WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        [approvalId, cfg.orgId],
      );
      throw new ApiError(409, 'approval_expired', 'approval_expired');
    }
    await client.query(
      `INSERT INTO work.approval_decision
         (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        approvalId,
        cfg.orgId,
        body.decision,
        cfg.subjectId,
        approval.params_hash,
        Number(approval.policy_epoch),
      ],
    );
    const updated = await client.query(
      `UPDATE work.approval SET status = $1, revision = revision + 1
       WHERE id = $2 AND org_id = $3 AND status = 'pending'
       RETURNING status, revision`,
      [body.decision, approvalId, cfg.orgId],
    );
    if (!updated.rowCount) {
      throw new ApiError(409, 'version_conflict', 'approval_race_lost');
    }
    await appendEvent(
      client,
      approval.task_id,
      approval.run_id,
      'task.approval.decided',
      {
        approval_id: approvalId,
        decision: body.decision,
        actor_subject_id: cfg.subjectId,
        revision: Number(updated.rows[0].revision),
      },
    );
    if (body.decision === 'rejected') {
      await client.query(
        `UPDATE work.operation SET state = 'canceled', revision = revision + 1
         WHERE id = $1 AND org_id = $2 AND state = 'waiting_approval'`,
        [approval.operation_id, cfg.orgId],
      );
      const runUpdate = await client.query(
        `UPDATE work.run
         SET state = 'active', wait_reason = NULL,
             control_revision = control_revision + 1, updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state = 'waiting'
         RETURNING state`,
        [approval.run_id, cfg.orgId],
      );
      if (runUpdate.rowCount) {
        await client.query(`SELECT work.finish_run($1, $2, 'failed', $3)`, [
          approval.run_id,
          cfg.orgId,
          'approval rejected',
        ]);
        await appendEvent(
          client,
          approval.task_id,
          approval.run_id,
          'task.run.failed',
          {
            run_id: approval.run_id,
            reason: 'approval rejected',
            retryable: true,
          },
        );
      }
    }
    return mapApproval({
      ...approval,
      status: updated.rows[0].status,
      revision: updated.rows[0].revision,
    });
  });
}

async function appendEvent(client, taskId, runId, type, payload) {
  await client.query(
    `SELECT id FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [taskId, cfg.orgId],
  );
  const seqResult = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
     FROM work.task_event WHERE task_id = $1 AND org_id = $2`,
    [taskId, cfg.orgId],
  );
  const eventId = uuid();
  const seq = Number(seqResult.rows[0].seq);
  await client.query(
    `INSERT INTO work.task_event
       (id, org_id, task_id, seq, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [eventId, cfg.orgId, taskId, seq, type, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO work.outbox
       (id, org_id, aggregate_type, aggregate_id, event_id, payload)
     VALUES ($1, $2, 'task', $3, $4, $5::jsonb)`,
    [uuid(), cfg.orgId, taskId, eventId, JSON.stringify({ type, payload })],
  );
  return { event_id: eventId, seq };
}

async function listEvents(client, taskId, afterSeq = 0) {
  await getTask(client, taskId);
  const result = await client.query(
    `SELECT id, task_id, seq, type, payload, created_at
     FROM work.task_event
     WHERE org_id = $1 AND task_id = $2 AND seq > $3
     ORDER BY seq ASC LIMIT 500`,
    [cfg.orgId, taskId, afterSeq],
  );
  return result.rows.map((row) => ({
    event_id: row.id,
    task_id: row.task_id,
    aggregate_seq: Number(row.seq),
    schema_version: 1,
    occurred_at: nowIso(row.created_at),
    type: row.type,
    payload: row.payload,
  }));
}

async function getArtifactVersion(client, artifactId, versionNo) {
  const result = await client.query(
    `SELECT a.id AS artifact_id, a.task_id, a.logical_name,
            v.version_no, v.media_type, v.bytes, v.content_hash, v.state,
            v.published_at, v.created_at
     FROM work.artifact a
     JOIN work.artifact_version v
       ON v.artifact_id = a.id AND v.org_id = a.org_id
     JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id
     WHERE a.id = $1 AND v.version_no = $2 AND a.org_id = $3
       AND t.owner_subject_id = $4`,
    [artifactId, versionNo, cfg.orgId, cfg.subjectId],
  );
  if (!result.rowCount) {
    throw new ApiError(404, 'invalid_request', 'artifact_version_not_found');
  }
  const row = result.rows[0];
  return {
    artifact_id: row.artifact_id,
    version_no: row.version_no,
    logical_name: row.logical_name,
    media_type: row.media_type,
    bytes: Number(row.bytes),
    content_hash: row.content_hash,
    state: row.state,
    location: 'cloud',
    content_url: null,
    created_at: nowIso(row.created_at),
    published_at: nowIso(row.published_at),
  };
}

async function acceptTask(taskId, body) {
  if (
    typeof body?.client_request_id !== 'string' ||
    body.client_request_id.length < 8
  ) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  const hasArtifact = body.artifact_id != null;
  if (hasArtifact !== (body.version_no != null)) {
    throw new ApiError(422, 'invalid_request', 'artifact_version_pair_required');
  }
  if (hasArtifact === Boolean(body.completion_reason)) {
    throw new ApiError(
      422,
      'invalid_request',
      'artifact_or_completion_reason_required',
    );
  }
  const requestHash = sha256(body);
  return withAppTx(async (client) => {
    const task = await getTask(client, taskId);
    const dedup = await client.query(
      `INSERT INTO work.submission_dedup
         (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state)
       VALUES ($1, $2, 'task_acceptance', $3, $4, $5, 'accepted')
       ON CONFLICT DO NOTHING
       RETURNING client_request_id`,
      [cfg.orgId, cfg.subjectId, body.client_request_id, requestHash, taskId],
    );
    if (!dedup.rowCount) {
      const existing = await client.query(
        `SELECT request_hash FROM work.submission_dedup
         WHERE org_id = $1 AND subject_id = $2
           AND operation_type = 'task_acceptance' AND client_request_id = $3`,
        [cfg.orgId, cfg.subjectId, body.client_request_id],
      );
      if (!existing.rowCount) {
        throw new ApiError(503, 'service_degraded', 'dedup_not_visible', {
          retryable: true,
        });
      }
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, 'idempotency_conflict', 'payload_mismatch');
      }
      return loadAcceptance(client, taskId);
    }
    const acceptance = await client.query(
      `SELECT work.accept_task($1, $2, $3, $4, $5, $6, $7) AS acceptance_id`,
      [
        taskId,
        cfg.orgId,
        hasArtifact ? body.artifact_id : null,
        hasArtifact ? body.version_no : null,
        cfg.subjectId,
        Number(body.expected_revision),
        hasArtifact ? null : body.completion_reason,
      ],
    );
    const acceptanceId = acceptance.rows[0].acceptance_id;
    const updatedTask = await getTask(client, taskId);
    await appendEvent(client, taskId, task.latest_run_id, 'task.acceptance.recorded', {
      acceptance_id: acceptanceId,
      artifact_id: hasArtifact ? body.artifact_id : null,
      version_no: hasArtifact ? body.version_no : null,
      completion_reason: hasArtifact ? null : body.completion_reason,
      task_revision: updatedTask.revision,
    });
    await appendEvent(client, taskId, task.latest_run_id, 'task.state_changed', {
      from_state: task.state,
      to_state: 'completed',
      revision: updatedTask.revision,
      reason: 'accepted',
    });
    return loadAcceptance(client, taskId);
  });
}

async function loadAcceptance(client, taskId) {
  const result = await client.query(
    `SELECT id, task_id, artifact_id, version_no, completion_reason,
            actor_subject_id, task_revision, created_at
     FROM work.acceptance
     WHERE org_id = $1 AND task_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [cfg.orgId, taskId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'acceptance_not_found');
  const row = result.rows[0];
  const task = await getTask(client, taskId);
  return {
    acceptance: {
      id: row.id,
      task_id: row.task_id,
      artifact_id: row.artifact_id,
      version_no: row.version_no,
      completion_reason: row.completion_reason,
      actor_subject_id: row.actor_subject_id,
      task_revision: Number(row.task_revision),
      created_at: nowIso(row.created_at),
    },
    task,
  };
}

async function createRun(taskId, body) {
  if (
    typeof body?.client_request_id !== 'string' ||
    body.client_request_id.length < 8
  ) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  if (body.target?.kind !== 'cloud') {
    throw new ApiError(422, 'scope_unavailable', 'r0a_requires_cloud_target');
  }
  return withAppTx(async (client) => {
    const task = await getTask(client, taskId);
    const snapshot = await client.query(
      `SELECT snapshot_id FROM work.task WHERE id = $1 AND org_id = $2`,
      [taskId, cfg.orgId],
    );
    const snapshotId = body.snapshot_id || snapshot.rows[0].snapshot_id;
    const runResult = await client.query(
      `SELECT work.create_run($1, $2, $3, $4, $5) AS run_id`,
      [
        taskId,
        cfg.orgId,
        snapshotId,
        `slice-${taskId}-${Date.now()}`,
        cfg.runtimeVersion,
      ],
    );
    return loadTaskRun(client, taskId, runResult.rows[0].run_id);
  });
}

async function workerTick() {
  const runIds = await withAppTx(async (client) => {
    const result = await client.query(
      `SELECT id FROM work.run
       WHERE org_id = $1 AND state IN ('queued', 'waiting', 'active')
       ORDER BY created_at LIMIT 20`,
      [cfg.orgId],
    );
    return result.rows.map((row) => row.id);
  });
  const actions = [];
  for (const runId of runIds) {
    try {
      const action = await withAppTx((client) => advanceRun(client, runId));
      if (action) actions.push(action);
    } catch (error) {
      actions.push({ run_id: runId, error: error.message, code: error.code });
    }
  }
  return { processed: actions.length, actions };
}

async function lockTaskRun(client, runId) {
  const ref = await client.query(
    `SELECT task_id FROM work.run WHERE id = $1 AND org_id = $2`,
    [runId, cfg.orgId],
  );
  if (!ref.rowCount) return null;
  const taskId = ref.rows[0].task_id;
  const taskResult = await client.query(
    `SELECT * FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [taskId, cfg.orgId],
  );
  const runResult = await client.query(
    `SELECT * FROM work.run WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [runId, cfg.orgId],
  );
  return { task: taskResult.rows[0], run: runResult.rows[0] };
}

async function advanceRun(client, runId) {
  const locked = await lockTaskRun(client, runId);
  if (!locked) return null;
  let { task, run } = locked;
  if (run.state === 'queued') {
    const acquired = await client.query(
      `SELECT * FROM work.acquire_run($1, $2)`,
      [runId, cfg.orgId],
    );
    const activeRun = acquired.rows[0];
    await appendEvent(client, task.id, runId, 'task.run.state_changed', {
      from_state: 'queued',
      to_state: 'active',
      wait_reason: null,
      control_revision: Number(activeRun.control_revision),
      fence: Number(activeRun.fence),
    });
    run = activeRun;
    const action = await runModelStep(client, task, run);
    return { run_id: runId, action: action.action, state: action.state };
  }
  if (run.state === 'waiting') {
    const action = await runApprovedToolStep(client, task, run);
    return { run_id: runId, action: action.action, state: action.state };
  }
  if (run.state === 'active') {
    const model = await client.query(
      `SELECT state FROM work.operation
       WHERE org_id = $1 AND run_id = $2 AND logical_key = 'model:1'`,
      [cfg.orgId, runId],
    );
    if (!model.rowCount || model.rows[0].state !== 'succeeded') {
      const action = await runModelStep(client, task, run);
      return { run_id: runId, action: action.action, state: action.state };
    }
    if (model.rows[0].state === 'succeeded') {
      const tool = await client.query(
        `SELECT state FROM work.operation
         WHERE org_id = $1 AND run_id = $2 AND logical_key = 'tool:1'`,
        [cfg.orgId, runId],
      );
      if (tool.rowCount && tool.rows[0].state === 'waiting_approval') {
        await client.query(
          `UPDATE work.run
           SET state = 'waiting', wait_reason = 'approval',
               control_revision = control_revision + 1, updated_at = now()
           WHERE id = $1 AND org_id = $2 AND state = 'active'`,
          [runId, cfg.orgId],
        );
        await appendEvent(client, task.id, runId, 'task.run.state_changed', {
          from_state: 'active',
          to_state: 'waiting',
          wait_reason: 'approval',
          control_revision: Number(run.control_revision) + 1,
          fence: Number(run.fence),
        });
        return { run_id: runId, action: 'waited_for_approval', state: 'waiting' };
      }
      if (!tool.rowCount) {
        const action = await createToolApproval(client, task, run);
        return { run_id: runId, action: action.action, state: action.state };
      }
    }
    return { run_id: runId, action: 'noop', state: run.state };
  }
  return { run_id: runId, action: 'noop', state: run.state };
}

async function ensureReservation(client, operationId, amountCents) {
  const existing = await client.query(
    `SELECT id FROM work.budget_reservation
     WHERE org_id = $1 AND operation_id = $2 AND state IN ('held', 'unknown')
     ORDER BY reservation_seq DESC LIMIT 1`,
    [cfg.orgId, operationId],
  );
  if (existing.rowCount) return existing.rows[0].id;
  const inserted = await client.query(
    `SELECT work.reserve_budget($1, 'default', $2, $3, $4) AS id`,
    [cfg.orgId, cfg.periodId, operationId, amountCents],
  );
  return inserted.rows[0].id;
}

async function runModelStep(client, task, run) {
  let operation = await client.query(
    `SELECT * FROM work.operation
     WHERE org_id = $1 AND run_id = $2 AND logical_key = 'model:1'`,
    [cfg.orgId, run.id],
  );
  if (!operation.rowCount) {
    const requestHash = `sha256:${sha256({
      run_id: run.id,
      step: 'model',
      model: 'faux-r0a',
    })}`;
    const created = await client.query(
      `SELECT work.create_operation($1, $2, 'model:1', 'model', $3) AS id`,
      [run.id, cfg.orgId, requestHash],
    );
    await ensureReservation(client, created.rows[0].id, cfg.modelReserveCents);
    await client.query(
      `UPDATE work.operation SET state = 'authorized', revision = revision + 1
       WHERE id = $1 AND org_id = $2 AND state = 'prepared'`,
      [created.rows[0].id, cfg.orgId],
    );
    operation = await client.query(
      `SELECT * FROM work.operation WHERE id = $1 AND org_id = $2`,
      [created.rows[0].id, cfg.orgId],
    );
  } else {
    await ensureReservation(client, operation.rows[0].id, cfg.modelReserveCents);
    if (operation.rows[0].state === 'prepared') {
      await client.query(
        `UPDATE work.operation SET state = 'authorized', revision = revision + 1
         WHERE id = $1 AND org_id = $2 AND state = 'prepared'`,
        [operation.rows[0].id, cfg.orgId],
      );
      operation = await client.query(
        `SELECT * FROM work.operation WHERE id = $1 AND org_id = $2`,
        [operation.rows[0].id, cfg.orgId],
      );
    }
  }
  const op = operation.rows[0];
  const attempt = await client.query(
    `SELECT work.claim_dispatch($1, $2, $3, $4) AS attempt`,
    [op.id, cfg.orgId, 'cloud-worker-slice', Number(run.fence)],
  );
  if (!attempt.rows[0].attempt) {
    return { action: 'dispatch_already_claimed', state: 'active' };
  }
  await client.query(
    `UPDATE work.operation
     SET state = 'succeeded', provider_request_id = $1, receipt_ref = $2,
         revision = revision + 1
     WHERE id = $3 AND org_id = $4 AND state = 'dispatching'`,
    [
      `faux-${op.id}`,
      `receipt:model:${op.id}`,
      op.id,
      cfg.orgId,
    ],
  );
  const reservation = await client.query(
    `SELECT id FROM work.budget_reservation
     WHERE org_id = $1 AND operation_id = $2 AND state = 'held'
     ORDER BY reservation_seq DESC LIMIT 1`,
    [cfg.orgId, op.id],
  );
  if (reservation.rowCount) {
    await client.query(`SELECT work.settle_budget($1, $2, $3, $4::jsonb, 1)`, [
      reservation.rows[0].id,
      cfg.modelCostCents,
      cfg.priceVersion,
      JSON.stringify({ input_tokens: 128, output_tokens: 64 }),
    ]);
  }
  await appendEvent(client, task.id, run.id, 'task.operation.state_changed', {
    operation_id: op.id,
    kind: 'model',
    from_state: 'dispatching',
    to_state: 'succeeded',
    billable: true,
    revision: Number(op.revision) + 1,
  });
  return createToolApproval(client, task, run);
}

async function createToolApproval(client, task, run) {
  let operation = await client.query(
    `SELECT * FROM work.operation
     WHERE org_id = $1 AND run_id = $2 AND logical_key = 'tool:1'`,
    [cfg.orgId, run.id],
  );
  if (!operation.rowCount) {
    const requestHash = `sha256:${sha256({
      run_id: run.id,
      step: 'tool',
      tool: 'artifact.markdown',
      logical_name: 'result.md',
    })}`;
    const created = await client.query(
      `SELECT work.create_operation($1, $2, 'tool:1', 'tool', $3) AS id`,
      [run.id, cfg.orgId, requestHash],
    );
    operation = await client.query(
      `SELECT * FROM work.operation WHERE id = $1 AND org_id = $2`,
      [created.rows[0].id, cfg.orgId],
    );
  }
  const op = operation.rows[0];
  if (op.state === 'waiting_approval' || op.state === 'authorized') {
    return { action: 'approval_already_created', state: 'waiting' };
  }
  await ensureReservation(client, op.id, cfg.toolReserveCents);
  await client.query(
    `UPDATE work.operation SET state = 'waiting_approval', revision = revision + 1
     WHERE id = $1 AND org_id = $2 AND state = 'prepared'`,
    [op.id, cfg.orgId],
  );
  const policy = await getPolicy(client);
  const approvalId = uuid();
  await client.query(
    `INSERT INTO work.approval
       (id, org_id, target_type, params_hash, scope, risk, expires_at,
        policy_epoch, status, revision)
     VALUES ($1, $2, 'operation', $3, $4::jsonb, 'medium',
             now() + interval '10 minutes', $5, 'pending', 0)`,
    [
      approvalId,
      cfg.orgId,
      op.request_hash,
      JSON.stringify({
        tool: 'artifact.markdown',
        logical_name: 'result.md',
        task_id: task.id,
      }),
      Number(policy.revision),
    ],
  );
  await client.query(
    `INSERT INTO work.approval_operation (approval_id, operation_id, org_id)
     VALUES ($1, $2, $3)`,
    [approvalId, op.id, cfg.orgId],
  );
  await client.query(
    `UPDATE work.run
     SET state = 'waiting', wait_reason = 'approval',
         control_revision = control_revision + 1, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND state = 'active'`,
    [run.id, cfg.orgId],
  );
  await appendEvent(client, task.id, run.id, 'task.approval.requested', {
    approval_id: approvalId,
    operation_id: op.id,
    params_hash: op.request_hash,
    risk: 'medium',
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  await appendEvent(client, task.id, run.id, 'task.run.state_changed', {
    from_state: 'active',
    to_state: 'waiting',
    wait_reason: 'approval',
    control_revision: Number(run.control_revision) + 1,
    fence: Number(run.fence),
  });
  return { action: 'waiting_approval', state: 'waiting' };
}

async function runApprovedToolStep(client, task, run) {
  const approval = await client.query(
    `SELECT a.id, a.revision, a.params_hash, o.id AS operation_id
     FROM work.approval a
     JOIN work.approval_operation ao ON ao.approval_id = a.id
     JOIN work.operation o ON o.id = ao.operation_id
     WHERE a.org_id = $1 AND o.run_id = $2
       AND a.status = 'approved' AND o.state = 'waiting_approval'
     LIMIT 1`,
    [cfg.orgId, run.id],
  );
  if (!approval.rowCount) {
    return { action: 'waiting_for_approval', state: 'waiting' };
  }
  await client.query(
    `UPDATE work.run
     SET state = 'active', wait_reason = NULL,
         control_revision = control_revision + 1, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND state = 'waiting'`,
    [run.id, cfg.orgId],
  );
  await client.query(
    `UPDATE work.operation SET state = 'authorized', revision = revision + 1
     WHERE id = $1 AND org_id = $2 AND state = 'waiting_approval'`,
    [approval.rows[0].operation_id, cfg.orgId],
  );
  const op = await client.query(
    `SELECT * FROM work.operation WHERE id = $1 AND org_id = $2`,
    [approval.rows[0].operation_id, cfg.orgId],
  );
  const attempt = await client.query(
    `SELECT work.claim_dispatch($1, $2, $3, $4) AS attempt`,
    [op.rows[0].id, cfg.orgId, 'cloud-worker-slice', Number(run.fence)],
  );
  if (!attempt.rows[0].attempt) {
    return { action: 'tool_dispatch_already_claimed', state: 'active' };
  }
  const content = `# Work cloud slice result\n\nTask: ${task.id}\nRun: ${run.id}\n\nThis artifact was produced by the deterministic faux cloud worker.\n`;
  const hash = sha256(content);
  await fs.mkdir(cfg.contentDir, { recursive: true });
  await fs.writeFile(path.join(cfg.contentDir, `${hash}.md`), content, 'utf8');
  const artifact = await client.query(
    `INSERT INTO work.artifact
       (id, org_id, task_id, logical_name, state, revision)
     VALUES ($1, $2, $3, 'result.md', 'published', 0)
     ON CONFLICT (org_id, task_id, logical_name)
     DO UPDATE SET state = 'published', revision = work.artifact.revision + 1
     RETURNING id`,
    [uuid(), cfg.orgId, task.id],
  );
  const artifactId = artifact.rows[0].id;
  const versionResult = await client.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
     FROM work.artifact_version WHERE artifact_id = $1 AND org_id = $2`,
    [artifactId, cfg.orgId],
  );
  const versionNo = Number(versionResult.rows[0].version_no);
  await client.query(
    `INSERT INTO work.artifact_version
       (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
        media_type, state, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, 'text/markdown', 'staged', $7::jsonb)`,
    [
      artifactId,
      cfg.orgId,
      versionNo,
      `content/${hash}.md`,
      hash,
      Buffer.byteLength(content),
      JSON.stringify({
        run_id: run.id,
        operation_id: op.rows[0].id,
        tool: 'artifact.markdown',
        model: 'faux-r0a',
      }),
    ],
  );
  await client.query(
    `UPDATE work.artifact_version SET state = 'published', published_at = now()
     WHERE artifact_id = $1 AND org_id = $2 AND version_no = $3`,
    [artifactId, cfg.orgId, versionNo],
  );
  const reservation = await client.query(
    `SELECT id FROM work.budget_reservation
     WHERE org_id = $1 AND operation_id = $2 AND state = 'held'
     ORDER BY reservation_seq DESC LIMIT 1`,
    [cfg.orgId, op.rows[0].id],
  );
  if (reservation.rowCount) {
    await client.query(`SELECT work.settle_budget($1, $2, $3, $4::jsonb, 1)`, [
      reservation.rows[0].id,
      cfg.toolCostCents,
      cfg.priceVersion,
      JSON.stringify({ tool_units: 1 }),
    ]);
  }
  await client.query(
    `UPDATE work.operation
     SET state = 'succeeded', provider_request_id = $1, receipt_ref = $2,
         revision = revision + 1
     WHERE id = $3 AND org_id = $4 AND state = 'dispatching'`,
    [
      `faux-${op.rows[0].id}`,
      `receipt:tool:${op.rows[0].id}`,
      op.rows[0].id,
      cfg.orgId,
    ],
  );
  await appendEvent(client, task.id, run.id, 'task.artifact.published', {
    artifact_id: artifactId,
    version_no: versionNo,
    logical_name: 'result.md',
    media_type: 'text/markdown',
    size_bytes: Buffer.byteLength(content),
    content_hash: hash,
    location: 'cloud',
  });
  await client.query(`SELECT work.finish_run($1, $2, 'succeeded', $3)`, [
    run.id,
    cfg.orgId,
    'artifact published',
  ]);
  await appendEvent(client, task.id, run.id, 'task.run.state_changed', {
    from_state: 'active',
    to_state: 'succeeded',
    wait_reason: null,
    control_revision: Number(run.control_revision) + 2,
    fence: Number(run.fence),
  });
  await appendEvent(client, task.id, run.id, 'task.state_changed', {
    from_state: 'open',
    to_state: 'awaiting_acceptance',
    revision: Number(task.revision) + 1,
    reason: 'run_succeeded',
  });
  return { action: 'artifact_published', state: 'awaiting_acceptance' };
}

function requireAuth(req) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${cfg.devToken}`) {
    throw new ApiError(401, 'invalid_request', 'unauthenticated');
  }
}

function requireInternal(req) {
  const token = req.headers['x-internal-token'] || '';
  if (token !== cfg.devToken) {
    throw new ApiError(403, 'invalid_request', 'internal_token_required');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ApiError(413, 'invalid_request', 'body_too_large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_request', 'invalid_json');
  }
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/internal/worker/tick') {
    requireInternal(req);
    return sendJson(res, 200, await workerTick());
  }
  requireAuth(req);
  if (req.method === 'GET' && pathname === '/work/v1/bootstrap') {
    return sendJson(res, 200, await bootstrap());
  }
  if (req.method === 'POST' && pathname === '/work/v1/task-previews') {
    const body = await readJson(req);
    return withAppTx(async (client) => {
      const policy = await getPolicy(client);
      return sendJson(res, 200, preview(body.intent, policy));
    });
  }
  if (req.method === 'POST' && pathname === '/work/v1/tasks') {
    return sendJson(res, 202, await submitTask(await readJson(req)));
  }
  if (req.method === 'GET' && pathname === '/work/v1/tasks') {
    return withAppTx(async (client) => {
      return sendJson(res, 200, await listTasks(client, url.searchParams.get('state')));
    });
  }
  let match = pathname.match(/^\/work\/v1\/tasks\/([^/]+)$/);
  if (match && req.method === 'GET') {
    return withAppTx(async (client) => {
      return sendJson(res, 200, await getTask(client, match[1]));
    });
  }
  match = pathname.match(/^\/work\/v1\/tasks\/([^/]+)\/runs$/);
  if (match && req.method === 'POST') {
    return sendJson(res, 202, await createRun(match[1], await readJson(req)));
  }
  match = pathname.match(/^\/work\/v1\/tasks\/([^/]+)\/acceptances$/);
  if (match && req.method === 'POST') {
    return sendJson(res, 200, await acceptTask(match[1], await readJson(req)));
  }
  match = pathname.match(/^\/work\/v1\/tasks\/([^/]+)\/events$/);
  if (match && req.method === 'GET') {
    return withAppTx(async (client) => {
      const after = Number(url.searchParams.get('after_seq') || 0);
      return sendJson(res, 200, await listEvents(client, match[1], after));
    });
  }
  match = pathname.match(/^\/work\/v1\/runs\/([^/]+)$/);
  if (match && req.method === 'GET') {
    return withAppTx(async (client) => {
      return sendJson(res, 200, await getRun(client, match[1]));
    });
  }
  match = pathname.match(/^\/work\/v1\/runs\/([^/]+)\/operations$/);
  if (match && req.method === 'GET') {
    return withAppTx(async (client) => {
      return sendJson(res, 200, { items: await listOperations(client, match[1]), next_cursor: null });
    });
  }
  if (req.method === 'GET' && pathname === '/work/v1/approvals') {
    return withAppTx(async (client) => {
      return sendJson(res, 200, {
        items: await listApprovals(client, url.searchParams.get('status')),
        next_cursor: null,
      });
    });
  }
  match = pathname.match(/^\/work\/v1\/approvals\/([^/]+)\/decisions$/);
  if (match && req.method === 'POST') {
    return sendJson(
      res,
      200,
      await decideApproval(match[1], await readJson(req)),
    );
  }
  match = pathname.match(/^\/work\/v1\/artifacts\/([^/]+)\/versions\/(\d+)$/);
  if (match && req.method === 'GET') {
    return withAppTx(async (client) => {
      return sendJson(
        res,
        200,
        await getArtifactVersion(client, match[1], Number(match[2])),
      );
    });
  }
  throw new ApiError(404, 'invalid_request', 'not_found');
}

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const api = mapDbError(error);
      if (api.status >= 500) console.error(api.code, api.message);
      sendJson(res, api.status, {
        code: api.code,
        message: api.message,
        retryable: api.retryable,
        correlation_id: crypto.randomUUID(),
        current_revision: api.currentRevision,
        recovery_action: api.recoveryAction,
      });
    });
  });
}

async function startServer({ port = cfg.port } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    port: server.address().port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

async function main() {
  const command = process.argv[2] || 'serve';
  if (command === 'init') {
    await initDb();
    return;
  }
  if (command === 'tick') {
    const result = await workerTick();
    console.log(JSON.stringify(result, null, 2));
    await pool.end();
    return;
  }
  if (command === 'serve') {
    const started = await startServer();
    console.log(`LISTENING ${started.port}`);
    const stop = async () => {
      await started.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.resolve(__dirname, '../work-ddl-draft-2026-10-25.sql');

const cfg = {
  adminDatabaseUrl:
    process.env.ADMIN_DATABASE_URL ||
    'postgresql://postgres:test@127.0.0.1:55437/work_local_slice',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://work_local_app:app@127.0.0.1:55437/work_local_slice',
  userToken: process.env.USER_TOKEN || 'local-user-token',
  deviceToken: process.env.DEVICE_TOKEN || 'device-slice-token',
  internalToken: process.env.INTERNAL_TOKEN || 'local-internal-token',
  permitSecret: process.env.PERMIT_SECRET || 'local-slice-permit-secret',
  orgId: process.env.ORG_ID || 'org-local',
  subjectId: process.env.SUBJECT_ID || 'alice',
  deviceId:
    process.env.DEVICE_ID || '11111111-1111-4111-8111-111111111111',
  port: process.env.PORT !== undefined ? Number(process.env.PORT) : 8878,
  periodId: '2026-10',
  priceVersion: 'price-v1',
  budgetLimitCents: 1000,
  toolReserveCents: 10,
  toolCostCents: 2,
  leaseSeconds: Number(process.env.LEASE_SECONDS || 2),
  previewTtlMs: 10 * 60 * 1000,
  runtimeVersion: 'local-slice-runtime-v1',
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
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
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
function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapDbError(error) {
  if (error instanceof ApiError) return error;
  const message = String(error?.message || '').split('\n')[0];
  if (error?.code === '23505') return new ApiError(409, 'version_conflict', message);
  if (error?.code === 'P0002') return new ApiError(404, 'invalid_request', message);
  if (
    message.includes('task_has_active_run') ||
    message.includes('task_has_unresolved_operation') ||
    message.includes('run_not_quiescent') ||
    message.includes('run_not_current') ||
    message.includes('invalid_transition')
  ) {
    return new ApiError(409, 'run_not_quiescent', message);
  }
  if (message.includes('budget_exhausted')) {
    return new ApiError(409, 'budget_exhausted', message);
  }
  if (
    message.includes('snapshot_not_in_task') ||
    message.includes('artifact_not_published') ||
    message.includes('operation_key_conflict')
  ) {
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
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE usename = 'work_local_app' AND pid <> pg_backend_pid()`,
    );
    await client.query('DROP SCHEMA IF EXISTS work CASCADE');
    await client.query('DROP ROLE IF EXISTS work_local_app');
    await client.query(
      "CREATE ROLE work_local_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS",
    );
    await client.query(ddl);
    await client.query(`
      GRANT USAGE ON SCHEMA work TO work_local_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA work TO work_local_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA work TO work_local_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA work TO work_local_app;
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
       DO UPDATE SET reserved_cents = 0, settled_cents = 0, limit_cents = EXCLUDED.limit_cents`,
      [cfg.orgId, cfg.periodId, cfg.budgetLimitCents],
    );
    await client.query(
      `INSERT INTO work.device
         (id, org_id, owner_subject_id, public_key, status, protocol_version)
       VALUES ($1, $2, $3, 'dev-public-key', 'active', '1.0')
       ON CONFLICT (id) DO UPDATE SET owner_subject_id = $3, status = 'active'`,
      [cfg.deviceId, cfg.orgId, cfg.subjectId],
    );
  });
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

function allowedModes(policy) {
  if (policy.force_ask_each) return ['ask_each'];
  const modes = ['ask_each'];
  if (policy.allow_auto_readonly) modes.push('auto_readonly');
  if (policy.allow_plan_approval) modes.push('plan_then_run');
  return modes;
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
    output: input.output ?? { format: 'markdown', logical_name: 'device-result.md' },
    workspace_grant_id: input.workspace_grant_id,
  };
  if (
    typeof intent.input_ref !== 'string' ||
    intent.input_ref.length === 0 ||
    intent.input_ref.length > 2000
  ) {
    throw new ApiError(422, 'invalid_request', 'input_ref_invalid');
  }
  if (!intent.target || intent.target.kind !== 'local' || !intent.target.device_id) {
    throw new ApiError(422, 'scope_unavailable', 'r0b_requires_local_device');
  }
  if (
    intent.suite ||
    intent.supplemental_skills.length ||
    intent.connectors.length
  ) {
    throw new ApiError(422, 'scope_unavailable', 'r0b_has_no_suite_or_connectors');
  }
  if (!intent.workspace_grant_id) {
    throw new ApiError(422, 'scope_unavailable', 'workspace_grant_required');
  }
  if (!['ask_each', 'auto_readonly', 'plan_then_run'].includes(intent.permission_mode)) {
    throw new ApiError(
      422,
      'permission_mode_unavailable',
      'unknown_permission_mode',
    );
  }
  if (intent.output?.format !== 'markdown') {
    throw new ApiError(422, 'invalid_request', 'r0b_markdown_only');
  }
  return intent;
}

function effectiveMode(policy, intent) {
  if (policy.force_ask_each && intent.permission_mode !== 'ask_each') {
    throw new ApiError(422, 'permission_mode_unavailable', 'organization_forces_ask_each');
  }
  if (intent.permission_mode === 'auto_readonly' && !policy.allow_auto_readonly) {
    throw new ApiError(422, 'permission_mode_unavailable', 'auto_readonly_not_allowed');
  }
  if (intent.permission_mode === 'plan_then_run' && !policy.allow_plan_approval) {
    throw new ApiError(422, 'permission_mode_unavailable', 'plan_approval_not_allowed');
  }
  return intent.permission_mode;
}

function previewHash(intent, policyRevision) {
  return `sha256:${sha256({
    org_id: cfg.orgId,
    policy_revision: policyRevision,
    price_version: cfg.priceVersion,
    resolver_version: 'local-slice-v1',
    intent: {
      input_ref: intent.input_ref,
      target: intent.target,
      workspace_grant_id: intent.workspace_grant_id,
      suite: intent.suite,
      permission_mode: intent.permission_mode,
      supplemental_skills: intent.supplemental_skills,
      connectors: intent.connectors,
      output: intent.output,
    },
  })}`;
}

async function loadDeviceContext(client, intent, requireSession = true) {
  const device = await client.query(
    `SELECT id, owner_subject_id, status FROM work.device
     WHERE id = $1 AND org_id = $2`,
    [intent.target.device_id, cfg.orgId],
  );
  if (!device.rowCount || device.rows[0].status !== 'active') {
    throw new ApiError(409, 'device_offline', 'device_not_active');
  }
  const grant = await client.query(
    `SELECT g.id, g.device_id, g.session_id, g.root_ref, g.allowed_tools,
            g.status, g.expires_at, g.owner_subject_id
     FROM work.workspace_grant g
     WHERE g.id = $1 AND g.org_id = $2`,
    [intent.workspace_grant_id, cfg.orgId],
  );
  if (!grant.rowCount) {
    throw new ApiError(422, 'scope_unavailable', 'workspace_grant_not_found');
  }
  const g = grant.rows[0];
  if (
    g.device_id !== intent.target.device_id ||
    g.owner_subject_id !== cfg.subjectId ||
    g.status !== 'active' ||
    new Date(g.expires_at).getTime() <= Date.now() ||
    !g.allowed_tools.includes('workspace.write')
  ) {
    throw new ApiError(422, 'scope_unavailable', 'workspace_grant_inactive');
  }
  if (requireSession) {
    const session = await client.query(
      `SELECT id FROM work.device_session
       WHERE id = $1 AND org_id = $2 AND device_id = $3 AND status = 'active'`,
      [g.session_id, cfg.orgId, g.device_id],
    );
    if (!session.rowCount) throw new ApiError(409, 'device_offline', 'device_session_inactive');
  }
  return { device: device.rows[0], grant: g };
}

function previewFor(intent, policy) {
  const base = {
    preview_hash: previewHash(intent, policy.revision),
    effective_permission_mode: intent.permission_mode,
    allowed_permission_modes: allowedModes(policy),
    boundary_summary: [
      '执行目标：已配对的本机设备',
      '目录：仅使用 workspace grant 的类型化写入工具',
      '工具：workspace.write；写入前需要审批',
      '正文：成果保留在设备，控制面只保存本地引用与回执',
      '预算上界：本机工具 10 分（CNY）',
    ],
    cost_upper_bound: {
      amount_cents: cfg.toolReserveCents,
      currency: 'CNY',
      price_version: cfg.priceVersion,
    },
    unavailable_reasons: [],
    expires_at: new Date(Date.now() + cfg.previewTtlMs).toISOString(),
  };
  return base;
}

async function bootstrap() {
  return withAppTx(async (client) => {
    const member = await client.query(
      `SELECT role, work_seat FROM work.member WHERE org_id = $1 AND subject_id = $2`,
      [cfg.orgId, cfg.subjectId],
    );
    const policy = await getPolicy(client);
    return {
      subject_id: cfg.subjectId,
      org: {
        id: cfg.orgId,
        name: 'Work Local Slice Org',
        role: member.rows[0]?.role ?? 'member',
        work_seat: member.rows[0]?.work_seat ?? false,
      },
      permissions: ['work.task.create', 'work.task.accept', 'work.approval.decide'],
      phases: ['R0b'],
      execution_targets: [{ kind: 'local', profile: 'windows-restricted', device_id: cfg.deviceId }],
      allowed_permission_modes: allowedModes(policy),
      limits: { max_supplemental_skills: 0, max_active_runs: 3, max_input_bytes: 1048576 },
    };
  });
}

async function preview(body) {
  const intent = normalizeIntent(body.intent);
  return withAppTx(async (client) => {
    const policy = await getPolicy(client);
    effectiveMode(policy, intent);
    await loadDeviceContext(client, intent, true);
    return previewFor(intent, policy);
  });
}

async function submitTask(body) {
  if (typeof body?.client_request_id !== 'string' || body.client_request_id.length < 8) {
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
    const expectedPreview = previewHash({ ...intent, permission_mode: mode }, policy.revision);
    if (body.preview_hash !== expectedPreview) {
      throw new ApiError(409, 'preview_stale', 'preview_hash_mismatch');
    }
    await loadDeviceContext(client, intent, true);
    const dedup = await client.query(
      `INSERT INTO work.submission_dedup
         (org_id, subject_id, operation_type, client_request_id, request_hash, result_state)
       VALUES ($1, $2, 'task_submit', $3, $4, 'accepted')
       ON CONFLICT DO NOTHING RETURNING client_request_id`,
      [cfg.orgId, cfg.subjectId, body.client_request_id, requestHash],
    );
    if (!dedup.rowCount) {
      const existing = await client.query(
        `SELECT request_hash, task_id FROM work.submission_dedup
         WHERE org_id = $1 AND subject_id = $2
           AND operation_type = 'task_submit' AND client_request_id = $3`,
        [cfg.orgId, cfg.subjectId, body.client_request_id],
      );
      if (!existing.rowCount) {
        throw new ApiError(503, 'service_degraded', 'dedup_not_visible', { retryable: true });
      }
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, 'idempotency_conflict', 'payload_mismatch');
      }
      return loadTaskRun(client, existing.rows[0].task_id);
    }
    const taskId = uuid();
    const snapshotId = uuid();
    const task = await client.query(
      `INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode)
       VALUES ($1, $2, $3, 'open', $4) RETURNING id`,
      [taskId, cfg.orgId, cfg.subjectId, mode],
    );
    const snapshotHash = `sha256:${sha256({ resolver: 'local-slice-v1', intent, permission_mode: mode })}`;
    await client.query(
      `INSERT INTO work.capability_snapshot
         (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
          model_route, scope_caps, price_version, manifest)
       VALUES ($1, $2, $3, 'local-slice-v1', $4,
               ARRAY['workspace.write']::text[],
               '{"provider":"none","model":"local-tool"}'::jsonb,
               jsonb_build_object('workspace_grant_id', $5::text),
               $6, $7::jsonb)`,
      [
        snapshotId,
        cfg.orgId,
        taskId,
        snapshotHash,
        intent.workspace_grant_id,
        cfg.priceVersion,
        JSON.stringify({
          intent,
          permission_mode: mode,
          target: intent.target,
          workspace_grant_id: intent.workspace_grant_id,
          device_id: intent.target.device_id,
        }),
      ],
    );
    await client.query(
      `UPDATE work.task SET snapshot_id = $1 WHERE id = $2 AND org_id = $3`,
      [snapshotId, taskId, cfg.orgId],
    );
    const run = await client.query(
      `SELECT work.create_run($1, $2, $3, $4, $5) AS run_id`,
      [taskId, cfg.orgId, snapshotId, `local-${taskId}`, cfg.runtimeVersion],
    );
    await client.query(
      `UPDATE work.submission_dedup SET task_id = $1
       WHERE org_id = $2 AND subject_id = $3
         AND operation_type = 'task_submit' AND client_request_id = $4`,
      [taskId, cfg.orgId, cfg.subjectId, body.client_request_id],
    );
    return loadTaskRun(client, taskId, run.rows[0].run_id);
  });
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
  const row = result.rows[0];
  return {
    id: row.id,
    owner_subject_id: row.owner_subject_id,
    state: row.state,
    permission_mode: row.permission_mode,
    active_run_id: row.active_run_id,
    latest_run_id: row.latest_run_id,
    revision: Number(row.revision),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
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
    target: { kind: 'local', profile: 'windows-restricted', device_id: cfg.deviceId },
    fence: Number(row.fence),
    control_revision: Number(row.control_revision),
    runtime_version: row.runtime_version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function loadTaskRun(client, taskId, runId = null) {
  const task = await getTask(client, taskId);
  const run = await getRun(client, runId || task.latest_run_id);
  return { task, run };
}

async function listOperations(client, runId) {
  await getRun(client, runId);
  const result = await client.query(
    `SELECT id, run_id, logical_key, kind, state, request_hash,
            provider_request_id, receipt_ref, revision, created_at
     FROM work.operation WHERE org_id = $1 AND run_id = $2
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
    created_at: iso(row.created_at),
  }));
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
    expires_at: iso(row.expires_at),
    status: row.status,
    revision: Number(row.revision),
  };
}

async function listApprovals(client, status) {
  const params = [cfg.orgId, cfg.subjectId];
  let sql = `SELECT a.id, a.params_hash, a.scope, a.risk, a.expires_at,
                    a.status, a.revision, o.id AS operation_id, o.run_id, r.task_id
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

async function decideApproval(approvalId, body) {
  if (typeof body?.client_request_id !== 'string' || body.client_request_id.length < 8) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  if (!['approved', 'rejected'].includes(body.decision)) {
    throw new ApiError(422, 'invalid_request', 'invalid_decision');
  }
  return withAppTx(async (client) => {
    const refs = await client.query(
      `SELECT r.task_id, o.run_id, o.id AS operation_id
       FROM work.approval a
       JOIN work.approval_operation ao ON ao.approval_id = a.id
       JOIN work.operation o ON o.id = ao.operation_id
       JOIN work.run r ON r.id = o.run_id
       WHERE a.id = $1 AND a.org_id = $2`,
      [approvalId, cfg.orgId],
    );
    if (!refs.rowCount) throw new ApiError(404, 'invalid_request', 'approval_not_found');
    const ref = refs.rows[0];
    await client.query(`SELECT id FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
      ref.task_id,
      cfg.orgId,
    ]);
    await client.query(`SELECT id FROM work.run WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
      ref.run_id,
      cfg.orgId,
    ]);
    await client.query(`SELECT id FROM work.operation WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
      ref.operation_id,
      cfg.orgId,
    ]);
    const approvalResult = await client.query(
      `SELECT a.*, o.id AS operation_id, o.run_id, r.task_id
       FROM work.approval a
       JOIN work.approval_operation ao ON ao.approval_id = a.id
       JOIN work.operation o ON o.id = ao.operation_id
       JOIN work.run r ON r.id = o.run_id
       WHERE a.id = $1 AND a.org_id = $2
       FOR UPDATE OF a`,
      [approvalId, cfg.orgId],
    );
    const approval = approvalResult.rows[0];
    if (!approval) throw new ApiError(404, 'invalid_request', 'approval_not_found');
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
    if (!updated.rowCount) throw new ApiError(409, 'version_conflict', 'approval_race_lost');
    await appendEvent(client, approval.task_id, approval.run_id, 'task.approval.decided', {
      approval_id: approvalId,
      decision: body.decision,
      actor_subject_id: cfg.subjectId,
      revision: Number(updated.rows[0].revision),
    });
    if (body.decision === 'rejected') {
      await client.query(
        `UPDATE work.operation SET state = 'canceled', revision = revision + 1
         WHERE id = $1 AND org_id = $2 AND state = 'waiting_approval'`,
        [approval.operation_id, cfg.orgId],
      );
      await client.query(
        `UPDATE work.run SET state = 'active', wait_reason = NULL,
             control_revision = control_revision + 1, updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state = 'waiting'`,
        [approval.run_id, cfg.orgId],
      );
      await client.query(`SELECT work.finish_run($1, $2, 'failed', $3)`, [
        approval.run_id,
        cfg.orgId,
        'approval rejected',
      ]);
      await appendEvent(client, approval.task_id, approval.run_id, 'task.run.failed', {
        run_id: approval.run_id,
        reason: 'approval rejected',
        retryable: true,
      });
    }
    return mapApproval({
      ...approval,
      status: updated.rows[0].status,
      revision: updated.rows[0].revision,
    });
  });
}

async function appendEvent(client, taskId, runId, type, payload) {
  await client.query(`SELECT id FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
    taskId,
    cfg.orgId,
  ]);
  const seqResult = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM work.task_event
     WHERE task_id = $1 AND org_id = $2`,
    [taskId, cfg.orgId],
  );
  const eventId = uuid();
  await client.query(
    `INSERT INTO work.task_event (id, org_id, task_id, seq, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [eventId, cfg.orgId, taskId, Number(seqResult.rows[0].seq), type, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO work.outbox (id, org_id, aggregate_type, aggregate_id, event_id, payload)
     VALUES ($1, $2, 'task', $3, $4, $5::jsonb)`,
    [uuid(), cfg.orgId, taskId, eventId, JSON.stringify({ type, payload })],
  );
  return eventId;
}

async function listEvents(client, taskId, afterSeq = 0) {
  await getTask(client, taskId);
  const result = await client.query(
    `SELECT id, task_id, seq, type, payload, created_at
     FROM work.task_event WHERE org_id = $1 AND task_id = $2 AND seq > $3
     ORDER BY seq LIMIT 500`,
    [cfg.orgId, taskId, afterSeq],
  );
  return result.rows.map((row) => ({
    event_id: row.id,
    task_id: row.task_id,
    aggregate_seq: Number(row.seq),
    schema_version: 1,
    occurred_at: iso(row.created_at),
    type: row.type,
    payload: row.payload,
  }));
}

function localPayload(taskId, runId, grantId) {
  const content = `# Local Work Result\n\nTask: ${taskId}\nRun: ${runId}\nGrant: ${grantId}\n\nProduced on the paired device by the workspace.write tool.\n`;
  return {
    relative_path: 'device-result.md',
    content,
    content_hash: sha256(content),
    request_hash: `sha256:${sha256({
      task_id: taskId,
      run_id: runId,
      grant_id: grantId,
      tool: 'workspace.write',
      relative_path: 'device-result.md',
      content_hash: sha256(content),
    })}`,
  };
}

function signPermit(operationId, runId, fence, requestHash, expiresAt) {
  const payload = Buffer.from(
    JSON.stringify({ operation_id: operationId, run_id: runId, fence, request_hash: requestHash, expires_at: expiresAt }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', cfg.permitSecret)
    .update(`v1.${payload}`)
    .digest('base64url');
  return `v1.${payload}.${sig}`;
}

async function createApproval(client, task, run, operation, grant) {
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
      operation.request_hash,
      JSON.stringify({
        tool: 'workspace.write',
        relative_path: 'device-result.md',
        device_id: grant.device_id,
        workspace_grant_id: grant.id,
        task_id: task.id,
      }),
      Number(policy.revision),
    ],
  );
  await client.query(
    `INSERT INTO work.approval_operation (approval_id, operation_id, org_id)
     VALUES ($1, $2, $3)`,
    [approvalId, operation.id, cfg.orgId],
  );
  await client.query(
    `UPDATE work.operation SET state = 'waiting_approval', revision = revision + 1
     WHERE id = $1 AND org_id = $2 AND state = 'prepared'`,
    [operation.id, cfg.orgId],
  );
  await client.query(
    `UPDATE work.run SET state = 'waiting', wait_reason = 'approval',
         control_revision = control_revision + 1, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND state = 'active'`,
    [run.id, cfg.orgId],
  );
  await appendEvent(client, task.id, run.id, 'task.approval.requested', {
    approval_id: approvalId,
    operation_id: operation.id,
    params_hash: operation.request_hash,
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
  return approvalId;
}

async function startQueuedRun(client, task, run) {
  const acquired = await client.query(`SELECT * FROM work.acquire_run($1, $2)`, [
    run.id,
    cfg.orgId,
  ]);
  const active = acquired.rows[0];
  await appendEvent(client, task.id, run.id, 'task.run.state_changed', {
    from_state: 'queued',
    to_state: 'active',
    wait_reason: null,
    control_revision: Number(active.control_revision),
    fence: Number(active.fence),
  });
  const grant = await client.query(
    `SELECT g.id, g.device_id, g.session_id, g.allowed_tools, g.status
     FROM work.capability_snapshot s
     JOIN work.workspace_grant g
       ON g.id = (s.manifest->>'workspace_grant_id')::uuid AND g.org_id = s.org_id
     WHERE s.id = $1 AND s.org_id = $2`,
    [active.snapshot_id, cfg.orgId],
  );
  if (!grant.rowCount) throw new ApiError(422, 'scope_unavailable', 'grant_missing');
  const payload = localPayload(active.task_id, active.id, grant.rows[0].id);
  const created = await client.query(
    `SELECT work.create_operation($1, $2, 'tool:1', 'tool', $3) AS id`,
    [active.id, cfg.orgId, payload.request_hash],
  );
  await client.query(`SELECT work.reserve_budget($1, 'default', $2, $3, $4)`, [
    cfg.orgId,
    cfg.periodId,
    created.rows[0].id,
    cfg.toolReserveCents,
  ]);
  const operation = await client.query(
    `SELECT * FROM work.operation WHERE id = $1 AND org_id = $2`,
    [created.rows[0].id, cfg.orgId],
  );
  await createApproval(client, task, active, operation.rows[0], grant.rows[0]);
  return { action: 'waiting_approval', state: 'waiting' };
}

async function approveToDevice(client, task, run) {
  const approval = await client.query(
    `SELECT a.id, o.id AS operation_id
     FROM work.approval a
     JOIN work.approval_operation ao ON ao.approval_id = a.id
     JOIN work.operation o ON o.id = ao.operation_id
     WHERE a.org_id = $1 AND o.run_id = $2
       AND a.status = 'approved' AND o.state = 'waiting_approval'
     LIMIT 1`,
    [cfg.orgId, run.id],
  );
  if (!approval.rowCount) return { action: 'waiting_for_approval', state: 'waiting' };
  await client.query(
    `UPDATE work.operation SET state = 'authorized', revision = revision + 1
     WHERE id = $1 AND org_id = $2 AND state = 'waiting_approval'`,
    [approval.rows[0].operation_id, cfg.orgId],
  );
  await client.query(
    `UPDATE work.run SET wait_reason = 'device',
         control_revision = control_revision + 1, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND state = 'waiting'`,
    [run.id, cfg.orgId],
  );
  await appendEvent(client, task.id, run.id, 'task.run.state_changed', {
    from_state: 'waiting',
    to_state: 'waiting',
    wait_reason: 'device',
    control_revision: Number(run.control_revision) + 1,
    fence: Number(run.fence),
  });
  return { action: 'waiting_device', state: 'waiting' };
}

async function sweepExpiredLeases(client) {
  const expired = await client.query(
    `SELECT l.id, l.run_id, l.device_id, r.task_id
     FROM work.execution_lease l
     JOIN work.run r ON r.id = l.run_id AND r.org_id = l.org_id
     WHERE l.org_id = $1 AND l.status = 'active' AND l.expires_at <= now()`,
    [cfg.orgId],
  );
  const actions = [];
  for (const lease of expired.rows) {
    await client.query(`UPDATE work.execution_lease SET status = 'expired' WHERE id = $1`, [
      lease.id,
    ]);
    const ops = await client.query(
      `UPDATE work.operation SET state = 'unknown', revision = revision + 1
       WHERE org_id = $1 AND run_id = $2 AND state = 'dispatching'
       RETURNING id`,
      [cfg.orgId, lease.run_id],
    );
    const runUpdate = await client.query(
      `UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile',
           control_revision = control_revision + 1, updated_at = now()
       WHERE id = $1 AND org_id = $2 AND state = 'active'
       RETURNING id`,
      [lease.run_id, cfg.orgId],
    );
    if (ops.rowCount || runUpdate.rowCount) {
      await appendEvent(client, lease.task_id, lease.run_id, 'task.reconcile.required', {
        run_id: lease.run_id,
        operation_id: ops.rows[0]?.id ?? null,
        reason: 'lease_expired',
      });
      actions.push({ run_id: lease.run_id, action: 'unknown_after_lease_expiry' });
    }
  }
  return actions;
}

async function workerTick() {
  const runIds = await withAppTx(async (client) => {
    const result = await client.query(
      `SELECT id FROM work.run WHERE org_id = $1
       AND state IN ('queued', 'waiting', 'active') ORDER BY created_at LIMIT 20`,
      [cfg.orgId],
    );
    return result.rows.map((row) => row.id);
  });
  const actions = [];
  for (const runId of runIds) {
    try {
      const action = await withAppTx(async (client) => {
        const ref = await client.query(
          `SELECT task_id FROM work.run WHERE id = $1 AND org_id = $2`,
          [runId, cfg.orgId],
        );
        if (!ref.rowCount) return null;
        const taskId = ref.rows[0].task_id;
        const task = await client.query(
          `SELECT * FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [taskId, cfg.orgId],
        );
        const run = await client.query(
          `SELECT * FROM work.run WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [runId, cfg.orgId],
        );
        if (run.rows[0].state === 'queued') {
          return startQueuedRun(client, task.rows[0], run.rows[0]);
        }
        if (run.rows[0].state === 'waiting' && run.rows[0].wait_reason === 'approval') {
          return approveToDevice(client, task.rows[0], run.rows[0]);
        }
        return { action: 'noop', state: run.rows[0].state };
      });
      if (action) actions.push({ run_id: runId, ...action });
    } catch (error) {
      actions.push({ run_id: runId, error: error.message, code: error.code });
    }
  }
  const swept = await withAppTx((client) => sweepExpiredLeases(client));
  return { processed: actions.length + swept.length, actions: [...actions, ...swept] };
}

async function deviceHello(body) {
  if (body.device_id !== cfg.deviceId) {
    throw new ApiError(403, 'invalid_request', 'device_mismatch');
  }
  const bootId = String(body.boot_id || uuid());
  return withAppTx(async (client) => {
    const device = await client.query(
      `SELECT id, status FROM work.device WHERE id = $1 AND org_id = $2`,
      [cfg.deviceId, cfg.orgId],
    );
    if (!device.rowCount || device.rows[0].status !== 'active') {
      throw new ApiError(403, 'invalid_request', 'device_not_active');
    }
    if (body.session_key) {
      const existing = await client.query(
        `SELECT id, session_key, boot_id FROM work.device_session
         WHERE org_id = $1 AND device_id = $2 AND session_key = $3
           AND boot_id = $4 AND status = 'active'`,
        [cfg.orgId, cfg.deviceId, body.session_key, bootId],
      );
      if (existing.rowCount) {
        await client.query(`UPDATE work.device_session SET last_seen_at = now() WHERE id = $1`, [
          existing.rows[0].id,
        ]);
        return {
          device_id: cfg.deviceId,
          session_id: existing.rows[0].id,
          session_key: existing.rows[0].session_key,
          boot_id: bootId,
          lease_ttl_seconds: cfg.leaseSeconds,
          reconnected: true,
        };
      }
    }
    await client.query(
      `UPDATE work.device_session SET status = 'closed'
       WHERE org_id = $1 AND device_id = $2 AND status = 'active'`,
      [cfg.orgId, cfg.deviceId],
    );
    const sessionKey = uuid();
    const session = await client.query(
      `INSERT INTO work.device_session
         (org_id, device_id, session_key, boot_id, status, last_seen_at)
       VALUES ($1, $2, $3, $4, 'active', now())
       RETURNING id, session_key, boot_id`,
      [cfg.orgId, cfg.deviceId, sessionKey, bootId],
    );
    await client.query(`UPDATE work.device SET boot_id = $1 WHERE id = $2`, [bootId, cfg.deviceId]);
    return {
      device_id: cfg.deviceId,
      session_id: session.rows[0].id,
      session_key: session.rows[0].session_key,
      boot_id: bootId,
      lease_ttl_seconds: cfg.leaseSeconds,
      reconnected: false,
    };
  });
}

async function requireActiveSession(client, sessionKey) {
  const result = await client.query(
    `SELECT id, device_id, session_key, boot_id FROM work.device_session
     WHERE org_id = $1 AND device_id = $2 AND session_key = $3 AND status = 'active'`,
    [cfg.orgId, cfg.deviceId, sessionKey],
  );
  if (!result.rowCount) throw new ApiError(401, 'invalid_request', 'device_session_invalid');
  return result.rows[0];
}

async function deviceHeartbeat(body) {
  return withAppTx(async (client) => {
    const session = await requireActiveSession(client, body.session_key);
    await client.query(`UPDATE work.device_session SET last_seen_at = now() WHERE id = $1`, [
      session.id,
    ]);
    const lease = await client.query(
      `UPDATE work.execution_lease
       SET expires_at = now() + ($3 || ' seconds')::interval
       WHERE org_id = $1 AND device_id = $2 AND status = 'active'
       RETURNING run_id, expires_at`,
      [cfg.orgId, cfg.deviceId, String(cfg.leaseSeconds)],
    );
    return {
      session_id: session.id,
      lease: lease.rowCount
        ? { run_id: lease.rows[0].run_id, expires_at: iso(lease.rows[0].expires_at) }
        : null,
    };
  });
}

async function deviceCommand(body) {
  return withAppTx(async (client) => {
    const session = await requireActiveSession(client, body.session_key);
    const candidate = await client.query(
      `SELECT r.id AS run_id, r.task_id, r.fence, r.state AS run_state,
              o.id AS operation_id, o.request_hash,
              g.id AS grant_id, g.allowed_tools, g.status AS grant_status,
              g.expires_at AS grant_expires_at,
              s.manifest->>'device_id' AS target_device_id
       FROM work.run r
       JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
       JOIN work.capability_snapshot s ON s.id = r.snapshot_id AND s.org_id = r.org_id
       JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
       JOIN work.workspace_grant g
         ON g.id = (s.manifest->>'workspace_grant_id')::uuid AND g.org_id = r.org_id
       WHERE r.org_id = $1 AND r.state = 'waiting' AND r.wait_reason = 'device'
         AND o.logical_key = 'tool:1' AND o.state = 'authorized'
         AND s.manifest->>'device_id' = $2
         AND g.status = 'active' AND g.expires_at > now()
         AND g.device_id = $2::uuid
       LIMIT 1`,
      [cfg.orgId, cfg.deviceId],
    );
    if (!candidate.rowCount) return { command: null };
    const c = candidate.rows[0];
    if (!c.allowed_tools.includes('workspace.write')) {
      throw new ApiError(422, 'scope_unavailable', 'workspace_write_not_allowed');
    }
    const expiresAt = new Date(Date.now() + cfg.leaseSeconds * 1000);
    await client.query(
      `INSERT INTO work.execution_lease
         (org_id, run_id, device_id, session_id, fence, expires_at, last_receipt_seq, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'active')
       ON CONFLICT (run_id, org_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         fence = EXCLUDED.fence,
         expires_at = EXCLUDED.expires_at,
         status = 'active'`,
      [cfg.orgId, c.run_id, cfg.deviceId, session.id, c.fence, expiresAt],
    );
    const runUpdate = await client.query(
      `UPDATE work.run SET state = 'active', wait_reason = NULL,
           control_revision = control_revision + 1, updated_at = now()
       WHERE id = $1 AND org_id = $2 AND state = 'waiting' RETURNING id`,
      [c.run_id, cfg.orgId],
    );
    if (!runUpdate.rowCount) return { command: null };
    const attempt = await client.query(
      `SELECT work.claim_dispatch($1, $2, $3, $4) AS attempt`,
      [c.operation_id, cfg.orgId, cfg.deviceId, Number(c.fence)],
    );
    if (!attempt.rows[0].attempt) return { command: null };
    const payload = localPayload(c.task_id, c.run_id, c.grant_id);
    if (payload.request_hash !== c.request_hash) {
      throw new ApiError(409, 'invalid_request', 'operation_payload_hash_mismatch');
    }
    return {
      command: {
        command_id: uuid(),
        operation_id: c.operation_id,
        run_id: c.run_id,
        task_id: c.task_id,
        device_id: cfg.deviceId,
        workspace_grant_id: c.grant_id,
        fence: Number(c.fence),
        request_hash: c.request_hash,
        relative_path: payload.relative_path,
        content: payload.content,
        content_hash: payload.content_hash,
        expires_at: expiresAt.toISOString(),
        signed_permit: signPermit(
          c.operation_id,
          c.run_id,
          Number(c.fence),
          c.request_hash,
          expiresAt.toISOString(),
        ),
      },
    };
  });
}

async function settleOperationBudget(client, operationId) {
  const reservation = await client.query(
    `SELECT * FROM work.budget_reservation
     WHERE org_id = $1 AND operation_id = $2 AND state IN ('held', 'unknown')
     ORDER BY reservation_seq DESC LIMIT 1`,
    [cfg.orgId, operationId],
  );
  if (!reservation.rowCount) return false;
  await client.query(`SELECT work.settle_budget($1, $2, $3, $4::jsonb, 1)`, [
    reservation.rows[0].id,
    cfg.toolCostCents,
    cfg.priceVersion,
    JSON.stringify({ tool_units: 1 }),
  ]);
  return true;
}

async function ensureLocalArtifact(client, taskId, runId, operationId, body) {
  const artifact = await client.query(
    `INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
     VALUES ($1, $2, $3, 'device-result.md', 'published', 0)
     ON CONFLICT (org_id, task_id, logical_name)
     DO UPDATE SET state = 'published', revision = work.artifact.revision + 1
     RETURNING id`,
    [uuid(), cfg.orgId, taskId],
  );
  const artifactId = artifact.rows[0].id;
  const existing = await client.query(
    `SELECT version_no FROM work.artifact_version
     WHERE artifact_id = $1 AND org_id = $2 AND content_ref = $3
     ORDER BY version_no DESC LIMIT 1`,
    [artifactId, cfg.orgId, `local://${cfg.deviceId}/${body.content_hash}`],
  );
  if (existing.rowCount) return { artifactId, versionNo: existing.rows[0].version_no, created: false };
  const version = await client.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
     FROM work.artifact_version WHERE artifact_id = $1 AND org_id = $2`,
    [artifactId, cfg.orgId],
  );
  const versionNo = Number(version.rows[0].version_no);
  await client.query(
    `INSERT INTO work.artifact_version
       (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
        media_type, state, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, 'text/markdown', 'staged', $7::jsonb)`,
    [
      artifactId,
      cfg.orgId,
      versionNo,
      `local://${cfg.deviceId}/${body.content_hash}`,
      body.content_hash,
      Number(body.bytes),
      JSON.stringify({
        device_id: cfg.deviceId,
        operation_id: operationId,
        receipt_ref: `device:${cfg.deviceId}:${operationId}`,
        location: 'local_only',
        run_id: runId,
      }),
    ],
  );
  await client.query(
    `UPDATE work.artifact_version SET state = 'published', published_at = now()
     WHERE artifact_id = $1 AND org_id = $2 AND version_no = $3`,
    [artifactId, cfg.orgId, versionNo],
  );
  return { artifactId, versionNo, created: true };
}

async function upsertJournalRelease(client, runId, throughSeq) {
  const blockers = await client.query(
    `SELECT 1 FROM work.operation o
     WHERE o.org_id = $1 AND o.run_id = $2
       AND o.state IN ('prepared', 'waiting_approval', 'authorized',
                       'dispatching', 'unknown', 'unresolved')
     LIMIT 1`,
    [cfg.orgId, runId],
  );
  if (blockers.rowCount) return null;
  const run = await client.query(
    `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
    [runId, cfg.orgId],
  );
  if (!run.rowCount || !['succeeded', 'failed', 'canceled'].includes(run.rows[0].state)) {
    return null;
  }
  const release = await client.query(
    `INSERT INTO work.journal_release
       (device_id, org_id, session_key, released_through_seq, durable_watermark, released_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (device_id) DO UPDATE SET
       session_key = EXCLUDED.session_key,
       released_through_seq = GREATEST(work.journal_release.released_through_seq, EXCLUDED.released_through_seq),
       durable_watermark = EXCLUDED.durable_watermark,
       released_at = now()
     RETURNING released_through_seq, durable_watermark`,
    [cfg.deviceId, cfg.orgId, `device:${cfg.deviceId}`, Number(throughSeq), uuid()],
  );
  return release.rows[0];
}

async function deviceReceipt(body) {
  if (body.device_id && body.device_id !== cfg.deviceId) {
    throw new ApiError(403, 'invalid_request', 'device_mismatch');
  }
  if (!['started', 'completed', 'unknown'].includes(body.state)) {
    throw new ApiError(422, 'invalid_request', 'invalid_receipt_state');
  }
  return withAppTx(async (client) => {
    const session = await requireActiveSession(client, body.session_key);
    const operation = await client.query(
      `SELECT o.*, r.task_id, r.fence AS run_fence, r.state AS run_state,
              r.control_revision AS run_control_revision,
              t.state AS task_state, t.revision AS task_revision,
              s.manifest->>'device_id' AS target_device_id,
              l.fence AS lease_fence, l.status AS lease_status
       FROM work.operation o
       JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
       JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
       JOIN work.capability_snapshot s ON s.id = r.snapshot_id AND s.org_id = r.org_id
       LEFT JOIN work.execution_lease l ON l.run_id = r.id AND l.org_id = r.org_id
       WHERE o.id = $1 AND o.org_id = $2
       FOR UPDATE OF o, r, t`,
      [body.operation_id, cfg.orgId],
    );
    if (!operation.rowCount) throw new ApiError(404, 'invalid_request', 'operation_not_found');
    const op = operation.rows[0];
    if (op.target_device_id !== cfg.deviceId) {
      throw new ApiError(403, 'invalid_request', 'operation_not_for_device');
    }
    if (body.request_hash !== op.request_hash) {
      throw new ApiError(409, 'version_conflict', 'request_hash_mismatch');
    }
    if (Number(body.fence) !== Number(op.run_fence)) {
      throw new ApiError(409, 'version_conflict', 'fence_mismatch');
    }
    await client.query(
      `INSERT INTO work.device_receipt
         (id, org_id, device_id, session_id, operation_id, seq, fence,
          request_hash, state, payload_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (operation_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         seq = EXCLUDED.seq,
         fence = EXCLUDED.fence,
         request_hash = EXCLUDED.request_hash,
         state = EXCLUDED.state,
         payload_ref = EXCLUDED.payload_ref`,
      [
        uuid(),
        cfg.orgId,
        cfg.deviceId,
        session.id,
        op.id,
        Number(body.seq || 1),
        Number(body.fence),
        body.request_hash,
        body.state,
        body.payload_ref || `device:${cfg.deviceId}:${op.id}`,
      ],
    );
    if (body.state === 'started') {
      return { accepted: true, journal_release: null };
    }
    if (body.state === 'unknown') {
      await client.query(
        `UPDATE work.operation SET state = 'unknown', revision = revision + 1
         WHERE id = $1 AND org_id = $2 AND state = 'dispatching'`,
        [op.id, cfg.orgId],
      );
      return { accepted: true, journal_release: null };
    }
    if (!['dispatching', 'unknown', 'succeeded', 'reconciled'].includes(op.state)) {
      throw new ApiError(409, 'invalid_request', 'operation_not_dispatchable');
    }
    if (
      (op.state === 'succeeded' || op.state === 'reconciled') &&
      ['succeeded', 'failed', 'canceled'].includes(op.run_state)
    ) {
      const release = await upsertJournalRelease(client, op.run_id, body.seq || 1);
      return {
        accepted: true,
        replayed: true,
        journal_release: release
          ? {
              through_seq: Number(release.released_through_seq),
              durable_watermark: release.durable_watermark,
            }
          : null,
      };
    }
    const fromState = op.state;
    if (op.state === 'dispatching') {
      await client.query(
        `UPDATE work.operation SET state = 'succeeded', provider_request_id = $1,
             receipt_ref = $2, revision = revision + 1
         WHERE id = $3 AND org_id = $4 AND state = 'dispatching'`,
        [`device-${cfg.deviceId}`, `device:${cfg.deviceId}:${op.id}`, op.id, cfg.orgId],
      );
    } else if (op.state === 'unknown') {
      await client.query(
        `UPDATE work.operation SET state = 'reconciled', provider_request_id = $1,
             receipt_ref = $2, revision = revision + 1
         WHERE id = $3 AND org_id = $4 AND state = 'unknown'`,
        [`device-${cfg.deviceId}`, `device:${cfg.deviceId}:${op.id}`, op.id, cfg.orgId],
      );
    }
    await settleOperationBudget(client, op.id);
    const artifact = await ensureLocalArtifact(
      client,
      op.task_id,
      op.run_id,
      op.id,
      body,
    );
    if (op.run_state === 'waiting') {
      await client.query(
        `UPDATE work.run SET state = 'active', wait_reason = NULL,
             control_revision = control_revision + 1, updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state = 'waiting'`,
        [op.run_id, cfg.orgId],
      );
    }
    const runNow = await client.query(
      `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
      [op.run_id, cfg.orgId],
    );
    if (!['succeeded', 'failed', 'canceled'].includes(runNow.rows[0].state)) {
      await client.query(`SELECT work.finish_run($1, $2, 'succeeded', $3)`, [
        op.run_id,
        cfg.orgId,
        'device receipt reconciled',
      ]);
    }
    await client.query(
      `UPDATE work.execution_lease SET status = 'revoked'
       WHERE org_id = $1 AND run_id = $2 AND status = 'active'`,
      [cfg.orgId, op.run_id],
    );
    await appendEvent(client, op.task_id, op.run_id, 'task.operation.state_changed', {
      operation_id: op.id,
      kind: 'tool',
      from_state: fromState,
      to_state: fromState === 'unknown' ? 'reconciled' : 'succeeded',
      billable: true,
      revision: Number(op.revision) + 1,
    });
    await appendEvent(client, op.task_id, op.run_id, 'task.artifact.published', {
      artifact_id: artifact.artifactId,
      version_no: artifact.versionNo,
      logical_name: 'device-result.md',
      media_type: 'text/markdown',
      size_bytes: Number(body.bytes || 0),
      content_hash: body.content_hash,
      location: 'local_only',
    });
    await appendEvent(client, op.task_id, op.run_id, 'task.run.state_changed', {
      from_state: op.run_state,
      to_state: 'succeeded',
      wait_reason: null,
      control_revision: Number(op.run_control_revision) + 2,
      fence: Number(op.run_fence),
    });
    await appendEvent(client, op.task_id, op.run_id, 'task.state_changed', {
      from_state: op.task_state,
      to_state: 'awaiting_acceptance',
      revision: Number(op.task_revision) + 1,
      reason: 'device_receipt',
    });
    const release = await upsertJournalRelease(client, op.run_id, body.seq || 1);
    return {
      accepted: true,
      replayed: fromState === 'succeeded' || fromState === 'reconciled',
      journal_release: release
        ? {
            through_seq: Number(release.released_through_seq),
            durable_watermark: release.durable_watermark,
          }
        : null,
    };
  });
}

async function journalRelease(body) {
  return withAppTx(async (client) => {
    await requireActiveSession(client, body.session_key);
    const release = await upsertJournalRelease(client, body.run_id, body.through_seq || 1);
    if (!release) throw new ApiError(409, 'run_not_quiescent', 'journal_not_releasable');
    return {
      through_seq: Number(release.released_through_seq),
      durable_watermark: release.durable_watermark,
    };
  });
}

async function createGrant(body) {
  if (!body.root_ref || typeof body.root_ref !== 'string') {
    throw new ApiError(422, 'invalid_request', 'root_ref_required');
  }
  if (!Array.isArray(body.allowed_tools) || !body.allowed_tools.includes('workspace.write')) {
    throw new ApiError(422, 'invalid_request', 'workspace_write_required');
  }
  return withAppTx(async (client) => {
    const session = await client.query(
      `SELECT id FROM work.device_session
       WHERE org_id = $1 AND device_id = $2 AND status = 'active'
       ORDER BY last_seen_at DESC LIMIT 1`,
      [cfg.orgId, cfg.deviceId],
    );
    if (!session.rowCount) throw new ApiError(409, 'device_offline', 'device_session_missing');
    const grant = await client.query(
      `INSERT INTO work.workspace_grant
         (id, org_id, device_id, session_id, owner_subject_id, root_ref,
          allowed_tools, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 hour', 'active')
       RETURNING *`,
      [
        uuid(),
        cfg.orgId,
        cfg.deviceId,
        session.rows[0].id,
        cfg.subjectId,
        body.root_ref,
        body.allowed_tools,
      ],
    );
    return mapGrant(grant.rows[0]);
  });
}

function mapGrant(row) {
  return {
    id: row.id,
    device_id: row.device_id,
    root_ref: row.root_ref,
    allowed_tools: row.allowed_tools,
    status: row.status,
    expires_at: iso(row.expires_at),
  };
}

async function listGrants() {
  return withAppTx(async (client) => {
    const result = await client.query(
      `SELECT * FROM work.workspace_grant WHERE org_id = $1 AND owner_subject_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [cfg.orgId, cfg.subjectId],
    );
    return result.rows.map(mapGrant);
  });
}

async function revokeGrant(grantId) {
  return withAppTx(async (client) => {
    const result = await client.query(
      `UPDATE work.workspace_grant SET status = 'revoked'
       WHERE id = $1 AND org_id = $2 AND owner_subject_id = $3
       RETURNING *`,
      [grantId, cfg.orgId, cfg.subjectId],
    );
    if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'grant_not_found');
    return mapGrant(result.rows[0]);
  });
}

async function acceptTask(taskId, body) {
  if (typeof body?.client_request_id !== 'string' || body.client_request_id.length < 8) {
    throw new ApiError(400, 'invalid_request', 'client_request_id_required');
  }
  const hasArtifact = body.artifact_id != null;
  if (hasArtifact !== (body.version_no != null)) {
    throw new ApiError(422, 'invalid_request', 'artifact_version_pair_required');
  }
  if (hasArtifact === Boolean(body.completion_reason)) {
    throw new ApiError(422, 'invalid_request', 'artifact_or_completion_reason_required');
  }
  const requestHash = sha256(body);
  return withAppTx(async (client) => {
    const task = await getTask(client, taskId);
    const dedup = await client.query(
      `INSERT INTO work.submission_dedup
         (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state)
       VALUES ($1, $2, 'task_acceptance', $3, $4, $5, 'accepted')
       ON CONFLICT DO NOTHING RETURNING client_request_id`,
      [cfg.orgId, cfg.subjectId, body.client_request_id, requestHash, taskId],
    );
    if (!dedup.rowCount) {
      const existing = await client.query(
        `SELECT request_hash FROM work.submission_dedup
         WHERE org_id = $1 AND subject_id = $2
           AND operation_type = 'task_acceptance' AND client_request_id = $3`,
        [cfg.orgId, cfg.subjectId, body.client_request_id],
      );
      if (!existing.rowCount || existing.rows[0].request_hash !== requestHash) {
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
        hasArtifact ? Number(body.version_no) : null,
        cfg.subjectId,
        Number(body.expected_revision),
        hasArtifact ? null : body.completion_reason,
      ],
    );
    const updatedTask = await getTask(client, taskId);
    await appendEvent(client, taskId, task.latest_run_id, 'task.acceptance.recorded', {
      acceptance_id: acceptance.rows[0].acceptance_id,
      artifact_id: hasArtifact ? body.artifact_id : null,
      version_no: hasArtifact ? Number(body.version_no) : null,
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
     FROM work.acceptance WHERE org_id = $1 AND task_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [cfg.orgId, taskId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'acceptance_not_found');
  const row = result.rows[0];
  return {
    acceptance: {
      id: row.id,
      task_id: row.task_id,
      artifact_id: row.artifact_id,
      version_no: row.version_no,
      completion_reason: row.completion_reason,
      actor_subject_id: row.actor_subject_id,
      task_revision: Number(row.task_revision),
      created_at: iso(row.created_at),
    },
    task: await getTask(client, taskId),
  };
}

async function getArtifactVersion(client, artifactId, versionNo) {
  const result = await client.query(
    `SELECT a.id AS artifact_id, a.task_id, a.logical_name, v.version_no,
            v.media_type, v.bytes, v.content_hash, v.state, v.published_at, v.created_at
     FROM work.artifact a
     JOIN work.artifact_version v ON v.artifact_id = a.id AND v.org_id = a.org_id
     JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id
     WHERE a.id = $1 AND v.version_no = $2 AND a.org_id = $3 AND t.owner_subject_id = $4`,
    [artifactId, versionNo, cfg.orgId, cfg.subjectId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'artifact_not_found');
  const row = result.rows[0];
  return {
    artifact_id: row.artifact_id,
    version_no: row.version_no,
    logical_name: row.logical_name,
    media_type: row.media_type,
    bytes: Number(row.bytes),
    content_hash: row.content_hash,
    state: row.state,
    location: 'local_only',
    content_url: null,
    created_at: iso(row.created_at),
    published_at: iso(row.published_at),
  };
}

function requireUser(req) {
  if ((req.headers.authorization || '') !== `Bearer ${cfg.userToken}`) {
    throw new ApiError(401, 'invalid_request', 'unauthenticated');
  }
}
function requireDevice(req) {
  if ((req.headers['x-device-token'] || '') !== cfg.deviceToken) {
    throw new ApiError(403, 'invalid_request', 'device_token_invalid');
  }
}
function requireInternal(req) {
  if ((req.headers['x-internal-token'] || '') !== cfg.internalToken) {
    throw new ApiError(403, 'invalid_request', 'internal_token_invalid');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new ApiError(413, 'invalid_request', 'body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_request', 'invalid_json');
  }
}
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/internal/worker/tick') {
    requireInternal(req);
    return sendJson(res, 200, await workerTick());
  }
  if (p.startsWith('/internal/device/')) {
    requireDevice(req);
    if (req.method === 'POST' && p === '/internal/device/hello') {
      return sendJson(res, 200, await deviceHello(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/internal/device/heartbeat') {
      return sendJson(res, 200, await deviceHeartbeat(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/internal/device/commands') {
      return sendJson(res, 200, await deviceCommand(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/internal/device/receipts') {
      return sendJson(res, 200, await deviceReceipt(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/internal/device/journal-release') {
      return sendJson(res, 200, await journalRelease(await readJson(req)));
    }
    throw new ApiError(404, 'invalid_request', 'not_found');
  }
  requireUser(req);
  if (req.method === 'GET' && p === '/work/v1/bootstrap') return sendJson(res, 200, await bootstrap());
  if (req.method === 'POST' && p === '/work/v1/task-previews') {
    return sendJson(res, 200, await preview(await readJson(req)));
  }
  if (req.method === 'POST' && p === '/work/v1/tasks') {
    return sendJson(res, 202, await submitTask(await readJson(req)));
  }
  if (req.method === 'GET' && p === '/work/v1/tasks') {
    return withAppTx(async (client) => {
      const state = url.searchParams.get('state');
      const params = [cfg.orgId, cfg.subjectId];
      let sql = `SELECT id, owner_subject_id, state, permission_mode, active_run_id,
                        latest_run_id, revision, created_at, updated_at
                 FROM work.task WHERE org_id = $1 AND owner_subject_id = $2`;
      if (state) {
        params.push(state);
        sql += ' AND state = $3';
      }
      sql += ' ORDER BY created_at DESC LIMIT 50';
      const result = await client.query(sql, params);
      return sendJson(res, 200, {
        items: result.rows.map((row) => ({
          id: row.id,
          owner_subject_id: row.owner_subject_id,
          state: row.state,
          permission_mode: row.permission_mode,
          active_run_id: row.active_run_id,
          latest_run_id: row.latest_run_id,
          revision: Number(row.revision),
          created_at: iso(row.created_at),
          updated_at: iso(row.updated_at),
        })),
        next_cursor: null,
      });
    });
  }
  let m = p.match(/^\/work\/v1\/tasks\/([^/]+)$/);
  if (m && req.method === 'GET') {
    return withAppTx(async (client) => sendJson(res, 200, await getTask(client, m[1])));
  }
  m = p.match(/^\/work\/v1\/runs\/([^/]+)$/);
  if (m && req.method === 'GET') {
    return withAppTx(async (client) => sendJson(res, 200, await getRun(client, m[1])));
  }
  m = p.match(/^\/work\/v1\/runs\/([^/]+)\/operations$/);
  if (m && req.method === 'GET') {
    return withAppTx(async (client) =>
      sendJson(res, 200, { items: await listOperations(client, m[1]), next_cursor: null }),
    );
  }
  if (req.method === 'GET' && p === '/work/v1/approvals') {
    return withAppTx(async (client) =>
      sendJson(res, 200, {
        items: await listApprovals(client, url.searchParams.get('status')),
        next_cursor: null,
      }),
    );
  }
  m = p.match(/^\/work\/v1\/approvals\/([^/]+)\/decisions$/);
  if (m && req.method === 'POST') {
    return sendJson(res, 200, await decideApproval(m[1], await readJson(req)));
  }
  m = p.match(/^\/work\/v1\/tasks\/([^/]+)\/acceptances$/);
  if (m && req.method === 'POST') {
    return sendJson(res, 200, await acceptTask(m[1], await readJson(req)));
  }
  m = p.match(/^\/work\/v1\/tasks\/([^/]+)\/events$/);
  if (m && req.method === 'GET') {
    return withAppTx(async (client) => {
      const after = Number(url.searchParams.get('after_seq') || 0);
      return sendJson(res, 200, await listEvents(client, m[1], after));
    });
  }
  m = p.match(/^\/work\/v1\/artifacts\/([^/]+)\/versions\/(\d+)$/);
  if (m && req.method === 'GET') {
    return withAppTx(async (client) =>
      sendJson(res, 200, await getArtifactVersion(client, m[1], Number(m[2]))),
    );
  }
  if (req.method === 'GET' && p === '/work/v1/workspace-grants') {
    return sendJson(res, 200, await listGrants());
  }
  if (req.method === 'POST' && p === '/work/v1/workspace-grants') {
    return sendJson(res, 201, await createGrant(await readJson(req)));
  }
  m = p.match(/^\/work\/v1\/workspace-grants\/([^/]+)\/revoke$/);
  if (m && req.method === 'POST') {
    return sendJson(res, 200, await revokeGrant(m[1]));
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
        correlation_id: uuid(),
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
    console.log(JSON.stringify(await workerTick(), null, 2));
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

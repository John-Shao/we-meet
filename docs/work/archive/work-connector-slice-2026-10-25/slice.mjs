import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.resolve(__dirname, '../work-ddl-draft-2026-10-25.sql');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'mock-docs.json');

const cfg = {
  adminDatabaseUrl:
    process.env.ADMIN_DATABASE_URL ||
    'postgresql://postgres:test@127.0.0.1:55438/work_connector_slice',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://work_connector_app:app@127.0.0.1:55438/work_connector_slice',
  userToken: process.env.USER_TOKEN || 'connector-user-token',
  internalToken: process.env.INTERNAL_TOKEN || 'connector-internal-token',
  orgId: process.env.ORG_ID || 'org-connector',
  subjectId: process.env.SUBJECT_ID || 'alice',
  connectionId:
    process.env.CONNECTION_ID || '22222222-2222-4222-8222-222222222222',
  grantId: process.env.GRANT_ID || '33333333-3333-4333-8333-333333333333',
  contentDir: path.resolve(process.env.CONTENT_DIR || path.join(__dirname, 'content')),
  port: process.env.PORT !== undefined ? Number(process.env.PORT) : 8879,
  periodId: '2026-10',
  priceVersion: 'price-v1',
  budgetLimitCents: 1000,
  connectorReserveCents: 5,
  connectorCostCents: 3,
  resolverVersion: 'connector-slice-v1',
  runtimeVersion: 'connector-slice-runtime-v1',
  previewTtlMs: 10 * 60 * 1000,
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
       WHERE usename = 'work_connector_app' AND pid <> pg_backend_pid()`,
    );
    await client.query('DROP SCHEMA IF EXISTS work CASCADE');
    await client.query('DROP ROLE IF EXISTS work_connector_app');
    await client.query(
      "CREATE ROLE work_connector_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS",
    );
    await client.query(ddl);
    await client.query(`
      GRANT USAGE ON SCHEMA work TO work_connector_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA work TO work_connector_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA work TO work_connector_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA work TO work_connector_app;
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
      `INSERT INTO work.connector_connection
         (id, org_id, subject_id, provider, credential_ref, status, revision)
       VALUES ($1, $2, $3, 'mock-docs', 'cred://mock/alpha', 'active', 1)
       ON CONFLICT (id) DO UPDATE SET status = 'active', revision = 1`,
      [cfg.connectionId, cfg.orgId, cfg.subjectId],
    );
    await client.query(
      `INSERT INTO work.connector_grant
         (id, org_id, connection_id, resource_selector, allowed_actions,
          revision, status, expires_at)
       VALUES ($1, $2, $3, '{"project_id":"alpha"}'::jsonb,
               ARRAY['docs.read']::text[], 1, 'active', now() + interval '1 hour')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active', revision = 1,
         resource_selector = '{"project_id":"alpha"}'::jsonb,
         allowed_actions = ARRAY['docs.read']::text[],
         expires_at = now() + interval '1 hour'`,
      [cfg.grantId, cfg.orgId, cfg.connectionId],
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
  if (!result.rowCount) throw new ApiError(503, 'service_degraded', 'org_policy_missing');
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
  if (!input || typeof input !== 'object') throw new ApiError(400, 'invalid_request', 'intent_required');
  const intent = {
    input_ref: input.input_ref,
    target: input.target,
    suite: input.suite ?? null,
    supplemental_skills: input.supplemental_skills ?? [],
    connectors: input.connectors ?? [],
    permission_mode: input.permission_mode ?? 'ask_each',
    output: input.output ?? { format: 'markdown', logical_name: 'connector-summary.md' },
  };
  if (typeof intent.input_ref !== 'string' || !intent.input_ref || intent.input_ref.length > 2000) {
    throw new ApiError(422, 'invalid_request', 'input_ref_invalid');
  }
  if (!intent.target || intent.target.kind !== 'cloud') {
    throw new ApiError(422, 'scope_unavailable', 'connector_slice_requires_cloud');
  }
  if (intent.suite || intent.supplemental_skills.length) {
    throw new ApiError(422, 'scope_unavailable', 'r2a_has_no_suite_or_skills');
  }
  if (!Array.isArray(intent.connectors) || intent.connectors.length !== 1) {
    throw new ApiError(422, 'scope_unavailable', 'exactly_one_connector_required');
  }
  if (
    intent.connectors[0].connection_id !== cfg.connectionId ||
    intent.connectors[0].grant_id !== cfg.grantId
  ) {
    throw new ApiError(422, 'scope_unavailable', 'connector_not_available');
  }
  if (!intent.connectors[0].resource_selector || intent.connectors[0].resource_selector.project_id !== 'alpha') {
    throw new ApiError(422, 'scope_unavailable', 'resource_selector_out_of_scope');
  }
  if (!['ask_each', 'auto_readonly', 'plan_then_run'].includes(intent.permission_mode)) {
    throw new ApiError(422, 'permission_mode_unavailable', 'unknown_permission_mode');
  }
  if (intent.output?.format !== 'markdown') {
    throw new ApiError(422, 'invalid_request', 'markdown_only');
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

function selectorMatches(grantSelector, requested) {
  return (
    grantSelector &&
    requested &&
    typeof grantSelector.project_id === 'string' &&
    grantSelector.project_id === requested.project_id
  );
}

async function loadGrantContext(client, grantId, action, selector, deniedStatus = 403) {
  const result = await client.query(
    `SELECT g.*, c.status AS connection_status, c.credential_ref,
            c.revision AS connection_revision, c.subject_id AS connection_subject
     FROM work.connector_grant g
     JOIN work.connector_connection c
       ON c.id = g.connection_id AND c.org_id = g.org_id
     WHERE g.id = $1 AND g.org_id = $2
     FOR UPDATE OF g, c`,
    [grantId, cfg.orgId],
  );
  if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'grant_not_found');
  const grant = result.rows[0];
  if (
    grant.connection_subject !== cfg.subjectId ||
    grant.status !== 'active' ||
    grant.connection_status !== 'active' ||
    new Date(grant.expires_at).getTime() <= Date.now() ||
    !grant.allowed_actions.includes(action) ||
    !selectorMatches(grant.resource_selector, selector)
  ) {
    throw new ApiError(deniedStatus, 'scope_unavailable', 'connector_scope_denied');
  }
  return grant;
}

let fixtureCache = null;
async function loadFixture() {
  if (!fixtureCache) fixtureCache = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
  return fixtureCache;
}

async function adapterInvoke(client, grantId, action, selector) {
  const grant = await loadGrantContext(client, grantId, action, selector);
  const fixture = await loadFixture();
  const project = fixture[selector.project_id];
  if (!project) throw new ApiError(404, 'invalid_request', 'connector_resource_not_found');
  return {
    grant,
    documents: project.documents,
    resource_selector: { project_id: selector.project_id },
  };
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
      connectors: intent.connectors,
      permission_mode: intent.permission_mode,
      output: intent.output,
    },
  })}`;
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
        name: 'Work Connector Slice Org',
        role: member.rows[0]?.role ?? 'member',
        work_seat: member.rows[0]?.work_seat ?? false,
      },
      permissions: ['work.task.create', 'work.task.accept'],
      phases: ['R2a'],
      execution_targets: [{ kind: 'cloud', profile: 'text-v1' }],
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
    const selection = intent.connectors[0];
    const grant = await loadGrantContext(
      client,
      selection.grant_id,
      'docs.read',
      selection.resource_selector,
      422,
    );
    return {
      preview_hash: previewHash(intent, policy.revision),
      effective_permission_mode: intent.permission_mode,
      allowed_permission_modes: allowedModes(policy),
      boundary_summary: [
        '执行目标：云端 Work Runtime',
        `连接器：${cfg.connectionId}`,
        '资源：仅 alpha 项目（由 grant resource selector 限定）',
        '动作：docs.read；适配器在每次调用时复核 grant',
        '预算上界：连接器读取 5 分（CNY）',
      ],
      cost_upper_bound: {
        amount_cents: cfg.connectorReserveCents,
        currency: 'CNY',
        price_version: cfg.priceVersion,
      },
      unavailable_reasons: [],
      expires_at: new Date(Date.now() + cfg.previewTtlMs).toISOString(),
      grant_revision: Number(grant.revision),
    };
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
    if (body.preview_hash !== previewHash({ ...intent, permission_mode: mode }, policy.revision)) {
      throw new ApiError(409, 'preview_stale', 'preview_hash_mismatch');
    }
    const selection = intent.connectors[0];
    const grant = await loadGrantContext(
      client,
      selection.grant_id,
      'docs.read',
      selection.resource_selector,
      422,
    );
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
      if (!existing.rowCount) throw new ApiError(503, 'service_degraded', 'dedup_not_visible');
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, 'idempotency_conflict', 'payload_mismatch');
      }
      return loadTaskRun(client, existing.rows[0].task_id);
    }
    const taskId = uuid();
    const snapshotId = uuid();
    await client.query(
      `INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode)
       VALUES ($1, $2, $3, 'open', $4)`,
      [taskId, cfg.orgId, cfg.subjectId, mode],
    );
    const snapshotHash = `sha256:${sha256({ resolver: cfg.resolverVersion, intent })}`;
    await client.query(
      `INSERT INTO work.capability_snapshot
         (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
          model_route, scope_caps, price_version, manifest)
       VALUES ($1, $2, $3, $4, $5, ARRAY['connector.docs.read']::text[],
               '{"provider":"none","model":"connector-slice"}'::jsonb,
               jsonb_build_object('connector_grant_id', $6::text,
                                  'resource_selector', $7::jsonb),
               $8, $9::jsonb)`,
      [
        snapshotId,
        cfg.orgId,
        taskId,
        cfg.resolverVersion,
        snapshotHash,
        selection.grant_id,
        JSON.stringify(selection.resource_selector),
        cfg.priceVersion,
        JSON.stringify({
          intent,
          permission_mode: mode,
          target: intent.target,
          connectors: [
            {
              connection_id: selection.connection_id,
              grant_id: selection.grant_id,
              grant_revision: Number(grant.revision),
              action: 'docs.read',
              resource_selector: selection.resource_selector,
            },
          ],
        }),
      ],
    );
    await client.query(`UPDATE work.task SET snapshot_id = $1 WHERE id = $2 AND org_id = $3`, [
      snapshotId,
      taskId,
      cfg.orgId,
    ]);
    const run = await client.query(
      `SELECT work.create_run($1, $2, $3, $4, $5) AS run_id`,
      [taskId, cfg.orgId, snapshotId, `connector-${taskId}`, cfg.runtimeVersion],
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
     FROM work.task WHERE id = $1 AND org_id = $2 AND owner_subject_id = $3`,
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
    `SELECT r.id, r.task_id, r.attempt_no, r.state, r.wait_reason, r.terminal_reason,
            r.snapshot_id, r.fence, r.control_revision, r.runtime_version,
            r.created_at, r.updated_at
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
     FROM work.operation WHERE org_id = $1 AND run_id = $2 ORDER BY created_at`,
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

async function appendEvent(client, taskId, runId, type, payload) {
  await client.query(`SELECT id FROM work.task WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
    taskId,
    cfg.orgId,
  ]);
  const seq = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM work.task_event
     WHERE task_id = $1 AND org_id = $2`,
    [taskId, cfg.orgId],
  );
  const eventId = uuid();
  await client.query(
    `INSERT INTO work.task_event (id, org_id, task_id, seq, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [eventId, cfg.orgId, taskId, Number(seq.rows[0].seq), type, JSON.stringify(payload)],
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
    `SELECT id, task_id, seq, type, payload, created_at FROM work.task_event
     WHERE org_id = $1 AND task_id = $2 AND seq > $3 ORDER BY seq LIMIT 500`,
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

async function getConnectorConnections() {
  return withAppTx(async (client) => {
    const result = await client.query(
      `SELECT c.id, c.provider, c.status, c.revision,
              g.id AS grant_id, g.resource_selector, g.allowed_actions,
              g.revision AS grant_revision, g.status AS grant_status,
              g.expires_at
       FROM work.connector_connection c
       LEFT JOIN work.connector_grant g
         ON g.connection_id = c.id AND g.org_id = c.org_id
       WHERE c.org_id = $1 AND c.subject_id = $2
       ORDER BY c.created_at`,
      [cfg.orgId, cfg.subjectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      revision: Number(row.revision),
      grants: row.grant_id
        ? [
            {
              id: row.grant_id,
              resource_selector: row.resource_selector,
              allowed_actions: row.allowed_actions,
              revision: Number(row.grant_revision),
              status: row.grant_status,
              expires_at: iso(row.expires_at),
            },
          ]
        : [],
    }));
  });
}

async function listGrants() {
  return withAppTx(async (client) => {
    const result = await client.query(
      `SELECT id, connection_id, resource_selector, allowed_actions, revision,
              status, expires_at, created_at
       FROM work.connector_grant WHERE org_id = $1 AND created_at IS NOT NULL
       ORDER BY created_at LIMIT 50`,
      [cfg.orgId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      connection_id: row.connection_id,
      resource_selector: row.resource_selector,
      allowed_actions: row.allowed_actions,
      revision: Number(row.revision),
      status: row.status,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at),
    }));
  });
}

async function revokeGrant(grantId) {
  return withAppTx(async (client) => {
    const result = await client.query(
      `UPDATE work.connector_grant SET status = 'revoked', revision = revision + 1
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [grantId, cfg.orgId],
    );
    if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'grant_not_found');
    const row = result.rows[0];
    return {
      id: row.id,
      connection_id: row.connection_id,
      resource_selector: row.resource_selector,
      allowed_actions: row.allowed_actions,
      revision: Number(row.revision),
      status: row.status,
      expires_at: iso(row.expires_at),
    };
  });
}

async function refreshGrant(grantId) {
  return withAppTx(async (client) => {
    const result = await client.query(
      `SELECT g.*, c.status AS connection_status
       FROM work.connector_grant g
       JOIN work.connector_connection c ON c.id = g.connection_id AND c.org_id = g.org_id
       WHERE g.id = $1 AND g.org_id = $2
       FOR UPDATE OF g, c`,
      [grantId, cfg.orgId],
    );
    if (!result.rowCount) throw new ApiError(404, 'invalid_request', 'grant_not_found');
    const grant = result.rows[0];
    if (grant.status !== 'active' || grant.connection_status !== 'active') {
      throw new ApiError(409, 'scope_unavailable', 'revoked_grant_cannot_refresh');
    }
    await client.query(`UPDATE work.connector_connection SET revision = revision + 1 WHERE id = $1`, [
      grant.connection_id,
    ]);
    const updated = await client.query(
      `UPDATE work.connector_grant SET revision = revision + 1,
           expires_at = now() + interval '1 hour'
       WHERE id = $1 AND org_id = $2 AND status = 'active'
       RETURNING *`,
      [grantId, cfg.orgId],
    );
    if (!updated.rowCount) throw new ApiError(409, 'scope_unavailable', 'grant_refresh_race_lost');
    return {
      id: updated.rows[0].id,
      revision: Number(updated.rows[0].revision),
      status: updated.rows[0].status,
      expires_at: iso(updated.rows[0].expires_at),
    };
  });
}

async function internalInvoke(body) {
  return withAppTx(async (client) => {
    const result = await adapterInvoke(
      client,
      body.grant_id,
      body.action || 'docs.read',
      body.resource_selector,
    );
    return {
      grant_revision: Number(result.grant.revision),
      resource_selector: result.resource_selector,
      documents: result.documents,
      credential_ref_visible: false,
    };
  });
}

async function releaseHeldReservation(client, operationId) {
  const reservation = await client.query(
    `SELECT id FROM work.budget_reservation
     WHERE org_id = $1 AND operation_id = $2 AND state = 'held'
     ORDER BY reservation_seq DESC LIMIT 1`,
    [cfg.orgId, operationId],
  );
  if (reservation.rowCount) {
    await client.query(`SELECT work.release_budget($1)`, [reservation.rows[0].id]);
    return true;
  }
  return false;
}

async function startQueuedRun(client, task, run, policy) {
  const acquired = await client.query(`SELECT * FROM work.acquire_run($1, $2)`, [
    run.id,
    cfg.orgId,
  ]);
  const active = acquired.rows[0];
  const snapshot = await client.query(
    `SELECT manifest FROM work.capability_snapshot WHERE id = $1 AND org_id = $2`,
    [active.snapshot_id, cfg.orgId],
  );
  const connector = snapshot.rows[0].manifest.connectors[0];
  const payload = {
    grant_id: connector.grant_id,
    action: connector.action,
    resource_selector: connector.resource_selector,
  };
  const requestHash = `sha256:${sha256({
    run_id: active.id,
    task_id: active.task_id,
    connector,
  })}`;
  const created = await client.query(
    `SELECT work.create_operation($1, $2, 'connector:1', 'connector', $3) AS id`,
    [active.id, cfg.orgId, requestHash],
  );
  await client.query(`SELECT work.reserve_budget($1, 'default', $2, $3, $4)`, [
    cfg.orgId,
    cfg.periodId,
    created.rows[0].id,
    cfg.connectorReserveCents,
  ]);
  await client.query(
    `UPDATE work.operation SET state = 'authorized', revision = revision + 1
     WHERE id = $1 AND org_id = $2 AND state = 'prepared'`,
    [created.rows[0].id, cfg.orgId],
  );
  await appendEvent(client, task.id, run.id, 'task.run.state_changed', {
    from_state: 'queued',
    to_state: 'active',
    wait_reason: null,
    control_revision: Number(active.control_revision),
    fence: Number(active.fence),
  });
  await appendEvent(client, task.id, run.id, 'task.operation.state_changed', {
    operation_id: created.rows[0].id,
    kind: 'connector',
    from_state: 'prepared',
    to_state: 'authorized',
    billable: true,
    revision: 1,
  });
  return { action: 'connector_prepared', state: 'active' };
}

async function executeConnector(client, task, run) {
  const op = await client.query(
    `SELECT * FROM work.operation
     WHERE org_id = $1 AND run_id = $2 AND logical_key = 'connector:1'`,
    [cfg.orgId, run.id],
  );
  if (!op.rowCount || op.rows[0].state !== 'authorized') {
    return { action: 'noop', state: run.state };
  }
  const snapshot = await client.query(
    `SELECT manifest FROM work.capability_snapshot WHERE id = $1 AND org_id = $2`,
    [run.snapshot_id, cfg.orgId],
  );
  const connector = snapshot.rows[0].manifest.connectors[0];
  let grant;
  try {
    grant = await loadGrantContext(
      client,
      connector.grant_id,
      connector.action,
      connector.resource_selector,
    );
  } catch (error) {
    if (error.code !== 'scope_unavailable') throw error;
    await client.query(
      `UPDATE work.operation SET state = 'canceled', revision = revision + 1
       WHERE id = $1 AND org_id = $2 AND state = 'authorized'`,
      [op.rows[0].id, cfg.orgId],
    );
    await releaseHeldReservation(client, op.rows[0].id);
    await client.query(`SELECT work.finish_run($1, $2, 'failed', $3)`, [
      run.id,
      cfg.orgId,
      'connector grant revoked',
    ]);
    await appendEvent(client, task.id, run.id, 'task.run.failed', {
      run_id: run.id,
      reason: 'connector grant revoked',
      retryable: false,
    });
    return { action: 'connector_revoked', state: 'open' };
  }
  const attempt = await client.query(
    `SELECT work.claim_dispatch($1, $2, $3, $4) AS attempt`,
    [op.rows[0].id, cfg.orgId, 'connector-worker-slice', Number(run.fence)],
  );
  if (!attempt.rows[0].attempt) return { action: 'dispatch_already_claimed', state: 'active' };
  let data;
  try {
    data = await adapterInvoke(
      client,
      connector.grant_id,
      connector.action,
      connector.resource_selector,
    );
  } catch (error) {
    await client.query(
      `UPDATE work.operation SET state = 'failed', revision = revision + 1
       WHERE id = $1 AND org_id = $2 AND state = 'dispatching'`,
      [op.rows[0].id, cfg.orgId],
    );
    await releaseHeldReservation(client, op.rows[0].id);
    await client.query(`SELECT work.finish_run($1, $2, 'failed', $3)`, [
      run.id,
      cfg.orgId,
      'connector scope denied after dispatch',
    ]);
    await appendEvent(client, task.id, run.id, 'task.run.failed', {
      run_id: run.id,
      reason: 'connector scope denied after dispatch',
      retryable: false,
    });
    return { action: 'connector_scope_denied', state: 'open' };
  }
  const content = [
    '# Connector summary',
    '',
    `Project: ${connector.resource_selector.project_id}`,
    `Grant revision: ${grant.revision}`,
    '',
    ...data.documents.map((doc) => `- **${doc.title}**: ${doc.body}`),
    '',
  ].join('\n');
  const hash = sha256(content);
  await fs.mkdir(cfg.contentDir, { recursive: true });
  await fs.writeFile(path.join(cfg.contentDir, `${hash}.md`), content, 'utf8');
  const artifact = await client.query(
    `INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
     VALUES ($1, $2, $3, 'connector-summary.md', 'published', 0)
     ON CONFLICT (org_id, task_id, logical_name)
     DO UPDATE SET state = 'published', revision = work.artifact.revision + 1
     RETURNING id`,
    [uuid(), cfg.orgId, task.id],
  );
  const version = await client.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
     FROM work.artifact_version WHERE artifact_id = $1 AND org_id = $2`,
    [artifact.rows[0].id, cfg.orgId],
  );
  const versionNo = Number(version.rows[0].version_no);
  await client.query(
    `INSERT INTO work.artifact_version
       (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
        media_type, state, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, 'text/markdown', 'staged', $7::jsonb)`,
    [
      artifact.rows[0].id,
      cfg.orgId,
      versionNo,
      `content/${hash}.md`,
      hash,
      Buffer.byteLength(content),
      JSON.stringify({
        connector_id: cfg.connectionId,
        grant_id: connector.grant_id,
        grant_revision: Number(grant.revision),
        resource_selector: connector.resource_selector,
        action: connector.action,
        operation_id: op.rows[0].id,
      }),
    ],
  );
  await client.query(
    `UPDATE work.artifact_version SET state = 'published', published_at = now()
     WHERE artifact_id = $1 AND org_id = $2 AND version_no = $3`,
    [artifact.rows[0].id, cfg.orgId, versionNo],
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
      cfg.connectorCostCents,
      cfg.priceVersion,
      JSON.stringify({ connector_bytes: Buffer.byteLength(content) }),
    ]);
  }
  await client.query(
    `UPDATE work.operation SET state = 'succeeded', provider_request_id = $1,
         receipt_ref = $2, revision = revision + 1
     WHERE id = $3 AND org_id = $4 AND state = 'dispatching'`,
    [`connector-${op.rows[0].id}`, `connector:${op.rows[0].id}`, op.rows[0].id, cfg.orgId],
  );
  await appendEvent(client, task.id, run.id, 'task.artifact.published', {
    artifact_id: artifact.rows[0].id,
    version_no: versionNo,
    logical_name: 'connector-summary.md',
    media_type: 'text/markdown',
    size_bytes: Buffer.byteLength(content),
    content_hash: hash,
    location: 'cloud',
  });
  await client.query(`SELECT work.finish_run($1, $2, 'succeeded', $3)`, [
    run.id,
    cfg.orgId,
    'connector read completed',
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
    reason: 'connector_read_completed',
  });
  return { action: 'connector_completed', state: 'awaiting_acceptance' };
}

async function workerTick() {
  const runIds = await withAppTx(async (client) => {
    const result = await client.query(
      `SELECT id FROM work.run WHERE org_id = $1 AND state IN ('queued', 'active')
       ORDER BY created_at LIMIT 20`,
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
        const policy = await getPolicy(client);
        if (run.rows[0].state === 'queued') {
          return startQueuedRun(client, task.rows[0], run.rows[0], policy);
        }
        if (run.rows[0].state === 'active') {
          return executeConnector(client, task.rows[0], run.rows[0]);
        }
        return { action: 'noop', state: run.rows[0].state };
      });
      if (action) actions.push({ run_id: runId, ...action });
    } catch (error) {
      actions.push({ run_id: runId, error: error.message, code: error.code });
    }
  }
  return { processed: actions.length, actions };
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
    location: 'cloud',
    content_url: null,
    created_at: iso(row.created_at),
    published_at: iso(row.published_at),
  };
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

function requireUser(req) {
  if ((req.headers.authorization || '') !== `Bearer ${cfg.userToken}`) {
    throw new ApiError(401, 'invalid_request', 'unauthenticated');
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
  if (p.startsWith('/internal/')) {
    requireInternal(req);
    if (req.method === 'POST' && p === '/internal/worker/tick') {
      return sendJson(res, 200, await workerTick());
    }
    if (req.method === 'POST' && p === '/internal/connector/invoke') {
      return sendJson(res, 200, await internalInvoke(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/internal/connector/refresh') {
      return sendJson(res, 200, await refreshGrant((await readJson(req)).grant_id));
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
      const result = await client.query(
        `SELECT id, owner_subject_id, state, permission_mode, active_run_id,
                latest_run_id, revision, created_at, updated_at
         FROM work.task WHERE org_id = $1 AND owner_subject_id = $2
         ORDER BY created_at DESC LIMIT 50`,
        [cfg.orgId, cfg.subjectId],
      );
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
  if (req.method === 'GET' && p === '/work/v1/connector-connections') {
    return sendJson(res, 200, await getConnectorConnections());
  }
  if (req.method === 'GET' && p === '/work/v1/connector-grants') {
    return sendJson(res, 200, await listGrants());
  }
  m = p.match(/^\/work\/v1\/connector-grants\/([^/]+)\/revoke$/);
  if (m && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.client_request_id !== 'string' || body.client_request_id.length < 8) {
      throw new ApiError(400, 'invalid_request', 'client_request_id_required');
    }
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

-- Work 领域模型 DDL 草案
-- 目标：PostgreSQL 16；schema: work
-- 状态：草案，未应用生产。正式迁移需拆分为有序 migration，并由 DBA 评审。
-- 约定：
--   * 所有租户表带 org_id；被引用的表带 UNIQUE (id, org_id) 以支持复合外键。
--   * 状态用 text + CHECK，迁移通过 work.state_transition 校验；不依赖应用层自觉。
--   * 正文/检查点不进入本库；content_ref 指向受控 Content Store。
--   * RLS 以 current_setting('app.org_id', true) 为租户上下文；应用角色不得是表 owner。

BEGIN;

CREATE SCHEMA IF NOT EXISTS work;
SET search_path TO work, public;

-- ---------------------------------------------------------------------------
-- 组织与成员
-- ---------------------------------------------------------------------------
CREATE TABLE work.org (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  execution_enabled boolean NOT NULL DEFAULT true,
  operator_suspended boolean NOT NULL DEFAULT false,
  home_region text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work.member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  subject_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'left')),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  work_seat boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, subject_id)
);

-- R0 审批模式的最小组织策略；完整 Policy Evaluator 仍在控制面模块。
CREATE TABLE work.org_policy (
  org_id text PRIMARY KEY REFERENCES work.org(id),
  revision bigint NOT NULL DEFAULT 1,
  force_ask_each boolean NOT NULL DEFAULT false,
  allow_auto_readonly boolean NOT NULL DEFAULT false,
  allow_plan_approval boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 能力注册表与执行快照
-- ---------------------------------------------------------------------------
CREATE TABLE work.capability_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  kind text NOT NULL CHECK (kind IN ('suite', 'skill', 'connector', 'tool')),
  slug text NOT NULL,
  name text NOT NULL,
  owner_subject_id text,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, kind, slug)
);

CREATE TABLE work.capability_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  definition_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  content_hash text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'published', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (definition_id, org_id, version_no),
  FOREIGN KEY (definition_id, org_id) REFERENCES work.capability_definition(id, org_id)
);

CREATE TABLE work.capability_installation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  definition_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  installed_by_subject_id text,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, definition_id),
  FOREIGN KEY (definition_id, org_id) REFERENCES work.capability_definition(id, org_id)
);

CREATE TABLE work.capability_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  resolver_version text NOT NULL,
  snapshot_hash text NOT NULL,
  tool_allowlist text[] NOT NULL,
  model_route jsonb NOT NULL,
  scope_caps jsonb NOT NULL,
  price_version text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (id, task_id, org_id)
);

-- ---------------------------------------------------------------------------
-- 连接器
-- ---------------------------------------------------------------------------
CREATE TABLE work.connector_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  subject_id text NOT NULL,
  provider text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, subject_id, provider)
);

CREATE TABLE work.connector_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  connection_id uuid NOT NULL,
  resource_selector jsonb NOT NULL,
  allowed_actions text[] NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (connection_id, org_id, revision),
  FOREIGN KEY (connection_id, org_id) REFERENCES work.connector_connection(id, org_id)
);

-- ---------------------------------------------------------------------------
-- Task / Run
-- ---------------------------------------------------------------------------
CREATE TABLE work.task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  owner_subject_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'awaiting_acceptance', 'completed', 'canceled', 'archived')),
  active_run_id uuid,
  latest_run_id uuid,
  snapshot_id uuid,
  permission_mode text NOT NULL DEFAULT 'ask_each'
    CHECK (permission_mode IN ('ask_each', 'auto_readonly', 'plan_then_run')),
  completion_reason text,
  parent_task_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (snapshot_id, org_id) REFERENCES work.capability_snapshot(id, org_id),
  FOREIGN KEY (parent_task_id, org_id) REFERENCES work.task(id, org_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE work.run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  attempt_no int NOT NULL CHECK (attempt_no > 0),
  state text NOT NULL CHECK (state IN ('queued', 'active', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'canceled')),
  wait_reason text CHECK (wait_reason IN ('approval', 'input', 'budget', 'device', 'provider', 'reconcile')),
  terminal_reason text,
  fence bigint NOT NULL DEFAULT 1,
  control_revision bigint NOT NULL DEFAULT 0,
  snapshot_id uuid NOT NULL,
  workflow_id text NOT NULL,
  runtime_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_no),
  UNIQUE (id, org_id),
  UNIQUE (id, task_id, org_id),
  UNIQUE (workflow_id),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (snapshot_id, task_id, org_id)
    REFERENCES work.capability_snapshot(id, task_id, org_id)
);

ALTER TABLE work.task
  ADD CONSTRAINT fk_task_active_run
  FOREIGN KEY (active_run_id, id, org_id)
  REFERENCES work.run(id, task_id, org_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE work.task
  ADD CONSTRAINT fk_task_latest_run
  FOREIGN KEY (latest_run_id, id, org_id)
  REFERENCES work.run(id, task_id, org_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE work.capability_snapshot
  ADD CONSTRAINT fk_snapshot_task
  FOREIGN KEY (task_id, org_id)
  REFERENCES work.task(id, org_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX work_run_one_open_per_task
  ON work.run(task_id)
  WHERE state IN ('queued', 'active', 'waiting', 'cancel_requested');

CREATE INDEX work_run_task_state ON work.run(org_id, task_id, state);
CREATE INDEX work_task_owner_state ON work.task(org_id, owner_subject_id, state);

-- ---------------------------------------------------------------------------
-- Operation
-- ---------------------------------------------------------------------------
CREATE TABLE work.operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  logical_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'tool', 'connector', 'artifact', 'journal')),
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'succeeded', 'failed', 'canceled', 'reconciled', 'unresolved')),
  dispatch_attempt_id uuid,
  consumer_id text,
  provider_request_id text,
  receipt_ref text,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, run_id, logical_key),
  FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id)
);

CREATE INDEX work_operation_run_state ON work.operation(org_id, run_id, state);
CREATE INDEX work_operation_reconcile ON work.operation(org_id, state)
  WHERE state IN ('dispatching', 'unknown');

-- ---------------------------------------------------------------------------
-- 审批
-- ---------------------------------------------------------------------------
CREATE TABLE work.approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('operation', 'plan')),
  plan_version_id uuid,
  params_hash text NOT NULL,
  scope jsonb NOT NULL,
  risk text NOT NULL,
  expires_at timestamptz NOT NULL,
  policy_epoch bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK ((target_type = 'plan' AND plan_version_id IS NOT NULL) OR (target_type = 'operation' AND plan_version_id IS NULL))
);

CREATE TABLE work.approval_operation (
  approval_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  org_id text NOT NULL,
  PRIMARY KEY (operation_id),
  UNIQUE (approval_id, operation_id, org_id),
  FOREIGN KEY (approval_id, org_id) REFERENCES work.approval(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);

CREATE TABLE work.approval_decision (
  approval_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_subject_id text NOT NULL,
  params_hash text NOT NULL,
  policy_epoch bigint NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (approval_id, org_id) REFERENCES work.approval(id, org_id)
);

-- ---------------------------------------------------------------------------
-- 提交去重（Task 删除后保留 tombstone）
-- ---------------------------------------------------------------------------
CREATE TABLE work.submission_dedup (
  org_id text NOT NULL,
  subject_id text NOT NULL,
  operation_type text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  task_id uuid,
  task_deleted boolean NOT NULL DEFAULT false,
  result_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, subject_id, operation_type, client_request_id)
);
CREATE INDEX work_submission_task ON work.submission_dedup(org_id, task_id);

-- ---------------------------------------------------------------------------
-- 预算
-- ---------------------------------------------------------------------------
CREATE TABLE work.budget_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_key text NOT NULL,
  period_id text NOT NULL,
  currency char(3) NOT NULL,
  limit_cents bigint NOT NULL CHECK (limit_cents >= 0),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  version bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, account_key, period_id),
  CHECK (settled_cents + reserved_cents <= limit_cents)
);

CREATE TABLE work.budget_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  reservation_seq int NOT NULL DEFAULT 1 CHECK (reservation_seq > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  state text NOT NULL CHECK (state IN ('held', 'settled', 'released', 'unknown')),
  settlement_revision int NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (operation_id, reservation_seq),
  CHECK (settled_cents <= amount_cents),
  FOREIGN KEY (account_id, org_id) REFERENCES work.budget_account(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);

-- 同一 Operation 最多一个 held/unknown 预留；释放后可用新的 reservation_seq 重预留。
CREATE UNIQUE INDEX work_budget_one_active_reservation
  ON work.budget_reservation(operation_id)
  WHERE state IN ('held', 'unknown');

CREATE TABLE work.budget_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid,
  operation_id uuid,
  kind text NOT NULL CHECK (kind IN ('reserve', 'settle', 'release', 'adjust')),
  amount_cents bigint NOT NULL,
  settlement_revision int NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  price_version text,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (account_id, org_id) REFERENCES work.budget_account(id, org_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES work.budget_reservation(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);

-- settle/adjust 按 operation_id + settlement_revision 唯一；reserve/release 不参与。
CREATE UNIQUE INDEX work_budget_settlement_unique
  ON work.budget_entry(operation_id, settlement_revision)
  WHERE kind IN ('settle', 'adjust') AND settlement_revision > 0;

-- ---------------------------------------------------------------------------
-- 成果
-- ---------------------------------------------------------------------------
CREATE TABLE work.artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  logical_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'published', 'deleted')),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (org_id, task_id, logical_name),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id)
);

CREATE TABLE work.artifact_version (
  artifact_id uuid NOT NULL,
  org_id text NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  content_ref text NOT NULL,
  content_hash text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  media_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('staged', 'published', 'quarantined')),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (artifact_id, version_no),
  UNIQUE (artifact_id, org_id, version_no),
  FOREIGN KEY (artifact_id, org_id) REFERENCES work.artifact(id, org_id)
);

CREATE TABLE work.upload_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  artifact_id uuid,
  state text NOT NULL CHECK (state IN ('created', 'uploaded', 'finalized', 'aborted')),
  content_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (artifact_id, org_id) REFERENCES work.artifact(id, org_id)
);

CREATE TABLE work.acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  artifact_id uuid,
  version_no int,
  actor_subject_id text NOT NULL,
  task_revision bigint NOT NULL,
  completion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (task_id, task_revision),
  CHECK ((artifact_id IS NULL AND completion_reason IS NOT NULL) OR (artifact_id IS NOT NULL AND version_no IS NOT NULL AND completion_reason IS NULL)),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (artifact_id, org_id, version_no) REFERENCES work.artifact_version(artifact_id, org_id, version_no)
);

CREATE TABLE work.artifact_tombstone (
  artifact_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 设备与租约
-- ---------------------------------------------------------------------------
CREATE TABLE work.device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  owner_subject_id text NOT NULL,
  public_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  boot_id text,
  protocol_version text NOT NULL,
  attestation jsonb,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, public_key)
);

CREATE TABLE work.device_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  device_id uuid NOT NULL,
  session_key text NOT NULL,
  boot_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'closed', 'revoked')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (device_id, org_id, session_key),
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id)
);

CREATE TABLE work.workspace_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  root_ref text NOT NULL,
  allowed_tools text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id)
);

CREATE TABLE work.execution_lease (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  fence bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  last_receipt_seq bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (run_id, org_id),
  FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id)
);

CREATE TABLE work.device_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  fence bigint NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'completed', 'unknown')),
  payload_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (device_id, seq),
  UNIQUE (operation_id),
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);

CREATE TABLE work.journal_release (
  device_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  session_key text NOT NULL,
  released_through_seq bigint NOT NULL,
  durable_watermark text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id)
);

-- ---------------------------------------------------------------------------
-- R3 项目与计划
-- ---------------------------------------------------------------------------
CREATE TABLE work.project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);

CREATE TABLE work.project_member (
  project_id uuid NOT NULL,
  org_id text NOT NULL,
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (project_id, subject_id, org_id),
  FOREIGN KEY (project_id, org_id) REFERENCES work.project(id, org_id)
);

CREATE TABLE work.project_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  source_ref text NOT NULL,
  version_ref text,
  content_hash text,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (project_id, org_id) REFERENCES work.project(id, org_id)
);

CREATE TABLE work.context_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  content_ref text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (project_id, org_id, version_no),
  FOREIGN KEY (project_id, org_id) REFERENCES work.project(id, org_id)
);

CREATE TABLE work.plan_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  plan jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'running', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (run_id, org_id, version_no),
  FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id)
);

CREATE TABLE work.plan_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  plan_version_id uuid NOT NULL,
  step_key text NOT NULL,
  depends_on text[] NOT NULL DEFAULT '{}',
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  artifact_id uuid,
  version_no int,
  UNIQUE (id, org_id),
  UNIQUE (plan_version_id, step_key),
  FOREIGN KEY (plan_version_id, org_id) REFERENCES work.plan_version(id, org_id),
  FOREIGN KEY (artifact_id, org_id, version_no) REFERENCES work.artifact_version(artifact_id, org_id, version_no)
);

ALTER TABLE work.approval
  ADD CONSTRAINT fk_approval_plan_version
  FOREIGN KEY (plan_version_id, org_id)
  REFERENCES work.plan_version(id, org_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 事件、审计与 Outbox
-- ---------------------------------------------------------------------------
CREATE TABLE work.task_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  type text NOT NULL,
  payload_ref text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (task_id, seq),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id)
);

CREATE TABLE work.audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  actor_subject_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE work.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_id uuid NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);
CREATE INDEX work_outbox_pending ON work.outbox(available_at)
  WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------------
-- 状态迁移约束
-- ---------------------------------------------------------------------------
CREATE TABLE work.state_transition (
  entity text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  PRIMARY KEY (entity, from_state, to_state)
);

INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('task', 'open', 'awaiting_acceptance'),
  ('task', 'open', 'completed'),
  ('task', 'open', 'canceled'),
  ('task', 'open', 'archived'),
  ('task', 'awaiting_acceptance', 'open'),
  ('task', 'awaiting_acceptance', 'completed'),
  ('task', 'awaiting_acceptance', 'canceled'),
  ('task', 'awaiting_acceptance', 'archived'),
  ('task', 'completed', 'archived'),
  ('task', 'canceled', 'archived'),
  ('run', 'queued', 'active'),
  ('run', 'queued', 'failed'),
  ('run', 'queued', 'cancel_requested'),
  ('run', 'active', 'waiting'),
  ('run', 'active', 'succeeded'),
  ('run', 'active', 'failed'),
  ('run', 'active', 'cancel_requested'),
  ('run', 'waiting', 'active'),
  ('run', 'waiting', 'failed'),
  ('run', 'waiting', 'cancel_requested'),
  ('run', 'cancel_requested', 'canceled'),
  ('operation', 'prepared', 'waiting_approval'),
  ('operation', 'prepared', 'authorized'),
  ('operation', 'prepared', 'canceled'),
  ('operation', 'waiting_approval', 'authorized'),
  ('operation', 'waiting_approval', 'canceled'),
  ('operation', 'authorized', 'dispatching'),
  ('operation', 'authorized', 'canceled'),
  ('operation', 'dispatching', 'succeeded'),
  ('operation', 'dispatching', 'failed'),
  ('operation', 'dispatching', 'unknown'),
  ('operation', 'unknown', 'reconciled'),
  ('operation', 'unknown', 'unresolved'),
  ('approval', 'pending', 'approved'),
  ('approval', 'pending', 'rejected'),
  ('approval', 'pending', 'expired'),
  ('approval', 'pending', 'revoked'),
  ('artifact_version', 'staged', 'published'),
  ('artifact_version', 'staged', 'quarantined');

CREATE FUNCTION work.enforce_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entity_name text := TG_ARGV[0];
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.state_transition
    WHERE entity = entity_name AND from_state = OLD.state AND to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'invalid_transition:%:%->%', entity_name, OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_transition BEFORE UPDATE OF state ON work.task
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('task');
CREATE TRIGGER run_transition BEFORE UPDATE OF state ON work.run
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('run');
CREATE TRIGGER operation_transition BEFORE UPDATE OF state ON work.operation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('operation');
CREATE FUNCTION work.enforce_approval_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.state_transition
    WHERE entity = 'approval' AND from_state = OLD.status AND to_state = NEW.status
  ) THEN
    RAISE EXCEPTION 'invalid_transition:approval:%->%', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_transition BEFORE UPDATE OF status ON work.approval
  FOR EACH ROW EXECUTE FUNCTION work.enforce_approval_transition();
CREATE TRIGGER artifact_version_transition BEFORE UPDATE OF state ON work.artifact_version
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('artifact_version');

-- ---------------------------------------------------------------------------
-- 领域命令：Task / Run / Operation
--   * 所有命令按 Task -> Run -> Operation 顺序加锁，避免采纳/派发/新 Run 互相穿透。
--   * active_run_id 只指向非终态 Run；latest_run_id 保留最近一次 Run。
--   * 旧 Run 存在未终态或 unresolved Operation 时，新 Run 与采纳均被拒绝。
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.task_has_blocking_operation(p_task_id uuid, p_org_id text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM work.operation o
    JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
    WHERE r.task_id = p_task_id
      AND o.org_id = p_org_id
      AND o.state IN (
        'prepared', 'waiting_approval', 'authorized',
        'dispatching', 'unknown', 'unresolved'
      )
  );
$$;

CREATE FUNCTION work.enforce_operation_creation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM work.run r
  JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
  WHERE r.id = NEW.run_id
    AND r.org_id = NEW.org_id
    AND t.state = 'open'
    AND t.active_run_id = r.id
    AND r.state IN ('active', 'waiting')
  FOR SHARE OF r, t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_run_not_active' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_creation BEFORE INSERT ON work.operation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_operation_creation();

CREATE FUNCTION work.create_operation(
  p_run_id uuid,
  p_org_id text,
  p_logical_key text,
  p_kind text,
  p_request_hash text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  existing work.operation%ROWTYPE;
  operation_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO run_row FROM work.run WHERE id = p_run_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = run_row.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run WHERE id = p_run_id AND org_id = p_org_id FOR UPDATE;
  IF run_row.state NOT IN ('active', 'waiting') THEN
    RAISE EXCEPTION 'run_not_accepting_operations' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO existing
  FROM work.operation
  WHERE org_id = p_org_id AND run_id = p_run_id AND logical_key = p_logical_key;
  IF FOUND THEN
    IF existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'operation_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO work.operation
    (id, org_id, run_id, logical_key, kind, request_hash, state)
  VALUES
    (operation_id, p_org_id, p_run_id, p_logical_key, p_kind, p_request_hash, 'prepared');
  RETURN operation_id;
END;
$$;

CREATE FUNCTION work.create_run(
  p_task_id uuid,
  p_org_id text,
  p_snapshot_id uuid,
  p_workflow_id text,
  p_runtime_version text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  next_attempt int;
  run_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO task_row
  FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.state NOT IN ('open', 'awaiting_acceptance') THEN
    RAISE EXCEPTION 'task_not_runnable' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'task_has_active_run' USING ERRCODE = 'P0001';
  END IF;
  IF work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'task_has_unresolved_operation' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.capability_snapshot
    WHERE id = p_snapshot_id AND org_id = p_org_id AND task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'snapshot_not_in_task' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO next_attempt
  FROM work.run
  WHERE task_id = p_task_id AND org_id = p_org_id;
  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (run_id, p_org_id, p_task_id, next_attempt, 'queued', p_snapshot_id, p_workflow_id, p_runtime_version);
  UPDATE work.task
  SET state = 'open',
      active_run_id = run_id,
      latest_run_id = run_id,
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_task_id AND org_id = p_org_id;
  RETURN run_id;
END;
$$;

CREATE FUNCTION work.finish_run(
  p_run_id uuid,
  p_org_id text,
  p_outcome text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'invalid_run_outcome' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task
  WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id FOR UPDATE;
  IF task_row.state NOT IN ('open', 'canceled')
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome = 'succeeded' AND task_row.state <> 'open' THEN
    RAISE EXCEPTION 'canceled_task_cannot_succeed' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome = 'succeeded' AND work.task_has_blocking_operation(task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_has_unresolved_operation' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = p_outcome,
      wait_reason = NULL,
      terminal_reason = p_reason,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  IF p_outcome = 'succeeded' THEN
    UPDATE work.task
    SET state = 'awaiting_acceptance',
        active_run_id = NULL,
        latest_run_id = p_run_id,
        revision = revision + 1,
        updated_at = now()
    WHERE id = task_id AND org_id = p_org_id;
  ELSE
    UPDATE work.task
    SET active_run_id = NULL,
        latest_run_id = p_run_id,
        revision = revision + 1,
        updated_at = now()
    WHERE id = task_id AND org_id = p_org_id;
  END IF;
END;
$$;

CREATE FUNCTION work.acquire_run(
  p_run_id uuid,
  p_org_id text
) RETURNS work.run
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state <> 'queued' THEN
    RAISE EXCEPTION 'run_not_queued' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = 'active',
      fence = fence + 1,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = p_run_id AND org_id = p_org_id;
  RETURN run_row;
END;
$$;

-- 不可变/仅追加记录
CREATE FUNCTION work.prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table:%', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON work.audit_event
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER approval_decision_append_only BEFORE UPDATE OR DELETE ON work.approval_decision
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER budget_entry_append_only BEFORE UPDATE OR DELETE ON work.budget_entry
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER task_event_append_only BEFORE UPDATE OR DELETE ON work.task_event
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER artifact_tombstone_no_delete BEFORE DELETE ON work.artifact_tombstone
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER submission_dedup_no_delete BEFORE DELETE ON work.submission_dedup
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE FUNCTION work.artifact_version_immutable_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_id <> OLD.artifact_id
     OR NEW.org_id <> OLD.org_id
     OR NEW.version_no <> OLD.version_no
     OR NEW.content_ref <> OLD.content_ref
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.bytes <> OLD.bytes
     OR NEW.media_type <> OLD.media_type
     OR NEW.provenance <> OLD.provenance THEN
    RAISE EXCEPTION 'artifact_version_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_version_content_immutable BEFORE UPDATE ON work.artifact_version
  FOR EACH ROW EXECUTE FUNCTION work.artifact_version_immutable_content();

-- ---------------------------------------------------------------------------
-- 预算锁与线性化操作
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.reserve_budget(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_operation_id uuid,
  p_amount_cents bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  account work.budget_account%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  reservation_id uuid := gen_random_uuid();
  next_seq int;
BEGIN
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'invalid_reservation_amount' USING ERRCODE = '22023';
  END IF;
  -- Operation 行锁同时串行化 reserve/release/re-reserve 与派发。
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF operation_row.state NOT IN ('prepared', 'waiting_approval', 'authorized') THEN
    RAISE EXCEPTION 'operation_not_reservable' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.budget_reservation
    WHERE operation_id = p_operation_id AND state IN ('held', 'unknown')
  ) THEN
    RAISE EXCEPTION 'operation_has_active_reservation' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(reservation_seq), 0) + 1 INTO next_seq
  FROM work.budget_reservation
  WHERE operation_id = p_operation_id;
  SELECT * INTO account
  FROM work.budget_account
  WHERE org_id = p_org_id AND account_key = p_account_key AND period_id = p_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'budget_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF account.limit_cents - account.settled_cents - account.reserved_cents < p_amount_cents THEN
    RAISE EXCEPTION 'budget_exhausted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.budget_account
    SET reserved_cents = reserved_cents + p_amount_cents,
        version = version + 1,
        updated_at = now()
    WHERE id = account.id;
  INSERT INTO work.budget_reservation
    (id, org_id, account_id, operation_id, reservation_seq, amount_cents, state)
  VALUES
    (reservation_id, p_org_id, account.id, p_operation_id, next_seq, p_amount_cents, 'held');
  INSERT INTO work.budget_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_cents)
  VALUES
    (p_org_id, account.id, reservation_id, p_operation_id, 'reserve', p_amount_cents);
  RETURN reservation_id;
END;
$$;

CREATE FUNCTION work.settle_budget(
  p_reservation_id uuid,
  p_amount_cents bigint,
  p_price_version text,
  p_usage jsonb,
  p_settlement_revision int
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.budget_reservation%ROWTYPE;
  account work.budget_account%ROWTYPE;
  existing_amount bigint;
BEGIN
  SELECT * INTO reservation FROM work.budget_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_settlement_revision <= reservation.settlement_revision THEN
    -- 同 revision 同金额视为幂等重试；不同金额或倒退 revision 冲突。
    SELECT amount_cents INTO existing_amount
    FROM work.budget_entry
    WHERE operation_id = reservation.operation_id
      AND kind IN ('settle', 'adjust')
      AND settlement_revision = p_settlement_revision
    LIMIT 1;
    IF existing_amount IS NOT NULL AND existing_amount = p_amount_cents THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'settlement_revision_not_monotonic' USING ERRCODE = 'P0001';
  END IF;
  IF reservation.state NOT IN ('held', 'unknown') THEN
    RAISE EXCEPTION 'reservation_not_settleable' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents < 0 OR p_amount_cents > reservation.amount_cents THEN
    RAISE EXCEPTION 'settlement_out_of_bounds' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO account FROM work.budget_account
    WHERE id = reservation.account_id FOR UPDATE;
  UPDATE work.budget_account
    SET reserved_cents = reserved_cents - reservation.amount_cents,
        settled_cents = settled_cents + p_amount_cents,
        version = version + 1,
        updated_at = now()
    WHERE id = account.id;
  UPDATE work.budget_reservation
    SET state = 'settled',
        settled_cents = p_amount_cents,
        settlement_revision = p_settlement_revision,
        settled_at = now()
    WHERE id = reservation.id;
  INSERT INTO work.budget_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_cents,
     settlement_revision, price_version, usage)
  VALUES
    (reservation.org_id, account.id, reservation.id, reservation.operation_id,
     'settle', p_amount_cents, p_settlement_revision, p_price_version, p_usage);
END;
$$;

-- 账单修正只追加 adjust 分录，不改写已结算金额。
CREATE FUNCTION work.adjust_budget(
  p_reservation_id uuid,
  p_delta_cents bigint,
  p_reason text,
  p_settlement_revision int
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.budget_reservation%ROWTYPE;
  existing_amount bigint;
BEGIN
  SELECT * INTO reservation FROM work.budget_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.state <> 'settled' THEN
    RAISE EXCEPTION 'reservation_not_settled' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_revision <= reservation.settlement_revision THEN
    SELECT amount_cents INTO existing_amount
    FROM work.budget_entry
    WHERE operation_id = reservation.operation_id
      AND kind = 'adjust'
      AND settlement_revision = p_settlement_revision
    LIMIT 1;
    IF existing_amount IS NOT NULL AND existing_amount = p_delta_cents THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'settlement_revision_not_monotonic' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_cents = 0 THEN
    RAISE EXCEPTION 'adjustment_amount_zero' USING ERRCODE = '22023';
  END IF;
  UPDATE work.budget_account
    SET settled_cents = settled_cents + p_delta_cents,
        version = version + 1,
        updated_at = now()
    WHERE id = reservation.account_id;
  UPDATE work.budget_reservation
    SET settlement_revision = p_settlement_revision
    WHERE id = reservation.id;
  INSERT INTO work.budget_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_cents,
     settlement_revision, usage)
  VALUES
    (reservation.org_id, reservation.account_id, reservation.id, reservation.operation_id,
     'adjust', p_delta_cents, p_settlement_revision,
     jsonb_build_object('reason', p_reason));
END;
$$;

CREATE FUNCTION work.release_budget(p_reservation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.budget_reservation%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM work.budget_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.state <> 'held' THEN
    RAISE EXCEPTION 'only_held_reservations_can_be_released' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.budget_account
    SET reserved_cents = reserved_cents - reservation.amount_cents,
        version = version + 1,
        updated_at = now()
    WHERE id = reservation.account_id;
  UPDATE work.budget_reservation SET state = 'released' WHERE id = reservation.id;
  INSERT INTO work.budget_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_cents)
  VALUES
    (reservation.org_id, reservation.account_id, reservation.id,
     reservation.operation_id, 'release', reservation.amount_cents);
END;
$$;

CREATE FUNCTION work.claim_dispatch(
  p_operation_id uuid,
  p_org_id text,
  p_consumer_id text,
  p_fence bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
  attempt uuid := gen_random_uuid();
BEGIN
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = operation_row.run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- 固定锁顺序 Task -> Run -> Operation；与采纳、Run 终态、新 Run 串行化。
  SELECT * INTO task_row
  FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run
  WHERE id = operation_row.run_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active'
     OR run_row.fence <> p_fence
     OR operation_row.state <> 'authorized'
     OR operation_row.dispatch_attempt_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  UPDATE work.operation
    SET state = 'dispatching',
        dispatch_attempt_id = attempt,
        consumer_id = p_consumer_id,
        revision = revision + 1,
        updated_at = now()
    WHERE id = p_operation_id AND org_id = p_org_id;
  RETURN attempt;
END;
$$;

CREATE FUNCTION work.accept_task(
  p_task_id uuid,
  p_org_id text,
  p_artifact_id uuid,
  p_version_no int,
  p_actor_subject_id text,
  p_expected_revision bigint,
  p_completion_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  acceptance_id uuid := gen_random_uuid();
BEGIN
  IF p_artifact_id IS NULL AND p_completion_reason IS NULL THEN
    RAISE EXCEPTION 'acceptance_requires_artifact_or_reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO task_row
  FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.revision <> p_expected_revision
     OR task_row.state NOT IN ('open', 'awaiting_acceptance') THEN
    RAISE EXCEPTION 'run_not_quiescent_or_revision_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'task_has_active_run' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.latest_run_id IS NOT NULL THEN
    PERFORM 1 FROM work.run
    WHERE id = task_row.latest_run_id AND org_id = p_org_id
    FOR UPDATE;
  END IF;
  IF task_row.latest_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM work.run r
    WHERE r.id = task_row.latest_run_id
      AND r.org_id = p_org_id
      AND r.task_id = p_task_id
      AND r.state IN ('succeeded', 'failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'latest_run_not_terminal' USING ERRCODE = 'P0001';
  END IF;
  -- 静止判定覆盖全部非终态/未核对 Operation，不只 dispatching/unknown。
  IF work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent_or_revision_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF p_artifact_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM work.artifact a
      JOIN work.artifact_version v
        ON v.artifact_id = a.id AND v.org_id = a.org_id
      WHERE a.id = p_artifact_id
        AND a.org_id = p_org_id
        AND a.task_id = p_task_id
        AND v.version_no = p_version_no
        AND a.state = 'published'
        AND v.state = 'published'
    ) THEN
      RAISE EXCEPTION 'artifact_not_published_or_not_in_task' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  UPDATE work.task
    SET state = 'completed',
        active_run_id = NULL,
        revision = revision + 1,
        updated_at = now()
    WHERE id = p_task_id
      AND org_id = p_org_id
      AND revision = p_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_quiescent_or_revision_conflict' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO work.acceptance
    (id, org_id, task_id, artifact_id, version_no, actor_subject_id, task_revision, completion_reason)
  VALUES (acceptance_id, p_org_id, p_task_id, p_artifact_id, p_version_no, p_actor_subject_id, p_expected_revision + 1, p_completion_reason);
  RETURN acceptance_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS：应用必须每事务 SET LOCAL app.org_id = '<org>'
-- 表 owner 与 migration 角色不使用 BYPASSRLS；它们以独立迁移连接执行。
-- ---------------------------------------------------------------------------
ALTER TABLE work.org ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON work.org
  USING (id = current_setting('app.org_id', true))
  WITH CHECK (id = current_setting('app.org_id', true));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'member', 'org_policy', 'capability_definition', 'capability_version',
    'capability_installation', 'capability_snapshot', 'connector_connection',
    'connector_grant', 'task', 'run', 'operation', 'approval', 'approval_operation',
    'submission_dedup', 'budget_account', 'budget_reservation',
    'artifact', 'artifact_version', 'upload_session', 'acceptance',
    'device', 'device_session', 'workspace_grant', 'execution_lease',
    'device_receipt', 'journal_release',
    'project', 'project_member', 'project_source', 'context_version',
    'plan_version', 'plan_step', 'outbox'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON work.%I USING (org_id = current_setting(''app.org_id'', true)) WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'approval_decision', 'budget_entry', 'task_event', 'audit_event', 'artifact_tombstone'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_select ON work.%I FOR SELECT USING (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON work.%I FOR INSERT WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;

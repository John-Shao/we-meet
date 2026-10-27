-- E1 migration draft: R0a schema (schema "work").
-- Generated from docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql.
-- Roles must exist first (D-04); this file does not create/drop roles or databases.
-- Local verification: apply sql/r0a_roles.sql first, then this file.
CREATE SCHEMA IF NOT EXISTS work AUTHORIZATION work_owner;
SET ROLE work_owner;

-- 组织与成员
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

CREATE TABLE work.org_policy (
  org_id text PRIMARY KEY REFERENCES work.org(id),
  revision bigint NOT NULL DEFAULT 1,
  force_ask_each boolean NOT NULL DEFAULT false,
  allow_auto_readonly boolean NOT NULL DEFAULT false,
  allow_plan_approval boolean NOT NULL DEFAULT false,
  -- 每个 Run 的 token 硬上限（D-08）：派发前按此值预留，所有组织都强制。
  run_cap_tokens bigint NOT NULL DEFAULT 100000 CHECK (run_cap_tokens > 0),
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 执行快照、输入、任务
CREATE TABLE work.capability_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  resolver_version text NOT NULL,
  snapshot_hash text NOT NULL,
  tool_allowlist text[] NOT NULL,
  model_route jsonb NOT NULL,
  scope_caps jsonb NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (id, task_id, org_id)
);

-- R0a 新增：输入对象与 Task 元数据
-- 正文只存在 Content Store；本表只保留引用、哈希、大小与保留状态。

CREATE TABLE work.input_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  subject_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'task_input' CHECK (purpose IN ('task_input')),
  content_ref text NOT NULL,
  content_hash text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  media_type text NOT NULL DEFAULT 'application/json',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'deleted')),
  task_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);

-- 输入一次性：同哈希只复用尚未绑定任务的输入；提交时绑定 task_id，删除只粉碎本任务输入。
CREATE UNIQUE INDEX work_input_active_hash
  ON work.input_object(org_id, subject_id, content_hash, purpose)
  WHERE status = 'active' AND task_id IS NULL;


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

ALTER TABLE work.task ADD COLUMN input_id uuid NOT NULL;
ALTER TABLE work.task ADD COLUMN title text NOT NULL
  CHECK (length(title) BETWEEN 1 AND 200);
ALTER TABLE work.task
  ADD CONSTRAINT fk_task_input
  FOREIGN KEY (input_id, org_id)
  REFERENCES work.input_object(id, org_id);

CREATE UNIQUE INDEX work_input_one_task
  ON work.input_object(task_id) WHERE task_id IS NOT NULL;

CREATE INDEX work_task_owner_created
  ON work.task(org_id, owner_subject_id, created_at DESC);

CREATE TABLE work.run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  attempt_no int NOT NULL CHECK (attempt_no > 0),
  state text NOT NULL CHECK (state IN ('queued', 'active', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'canceled')),
  wait_reason text CHECK (wait_reason IN ('approval', 'input', 'quota', 'device', 'provider', 'reconcile')),
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


-- Task/Run 复合外键与唯一开放 Run
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

-- 审批
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

-- 提交去重与配额
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

CREATE TABLE work.quota_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_key text NOT NULL,
  period_id text NOT NULL,
  limit_tokens bigint NOT NULL CHECK (limit_tokens >= 0),
  reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  settled_tokens bigint NOT NULL DEFAULT 0 CHECK (settled_tokens >= 0),
  -- soft：周期量只统计不阻断（客户自带账号，账单在云厂商）；hard：演示组织等由 platform 承担成本的组织。
  enforcement text NOT NULL DEFAULT 'soft' CHECK (enforcement IN ('soft', 'hard')),
  version bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, account_key, period_id),
  CHECK (enforcement = 'soft' OR settled_tokens + reserved_tokens <= limit_tokens)
);

CREATE TABLE work.quota_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  reservation_seq int NOT NULL DEFAULT 1 CHECK (reservation_seq > 0),
  amount_tokens bigint NOT NULL CHECK (amount_tokens > 0),
  settled_tokens bigint NOT NULL DEFAULT 0 CHECK (settled_tokens >= 0),
  state text NOT NULL CHECK (state IN ('held', 'settled', 'released', 'unknown')),
  settlement_revision int NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (operation_id, reservation_seq),
  CHECK (settled_tokens <= amount_tokens),
  FOREIGN KEY (account_id, org_id) REFERENCES work.quota_account(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);

CREATE TABLE work.quota_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid,
  operation_id uuid,
  kind text NOT NULL CHECK (kind IN ('reserve', 'settle', 'release', 'adjust')),
  amount_tokens bigint NOT NULL,
  settlement_revision int NOT NULL DEFAULT 0 CHECK (settlement_revision >= 0),
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (account_id, org_id) REFERENCES work.quota_account(id, org_id),
  FOREIGN KEY (reservation_id, org_id) REFERENCES work.quota_reservation(id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id)
);


CREATE UNIQUE INDEX work_quota_one_active_reservation
  ON work.quota_reservation(operation_id)
  WHERE state IN ('held', 'unknown');
CREATE UNIQUE INDEX work_quota_settlement_unique
  ON work.quota_entry(operation_id, settlement_revision)
  WHERE kind IN ('settle', 'adjust') AND settlement_revision > 0;

-- 大模型接入与用量（D-08）
CREATE TABLE work.provider_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  provider text NOT NULL CHECK (provider IN ('aliyun', 'volcengine', 'deepseek')),
  mode text NOT NULL CHECK (mode IN ('sts_role', 'managed_key')),
  role_ref text,
  secret_ciphertext bytea,
  wrapped_dek bytea,
  kms_key_ref text,
  secret_fingerprint text NOT NULL,
  key_version int NOT NULL DEFAULT 1 CHECK (key_version > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  UNIQUE (id, org_id),
  -- managed_key: both KMS fields NULL = static single-layer; both present = reserved KMS envelope.
  CHECK (
    (mode = 'sts_role' AND role_ref IS NOT NULL
       AND secret_ciphertext IS NULL AND wrapped_dek IS NULL AND kms_key_ref IS NULL)
    OR (mode = 'managed_key' AND role_ref IS NULL
       AND secret_ciphertext IS NOT NULL
       AND ((wrapped_dek IS NULL AND kms_key_ref IS NULL)
         OR (wrapped_dek IS NOT NULL AND kms_key_ref IS NOT NULL
             AND length(btrim(kms_key_ref)) > 0)))
  )
);

CREATE TABLE work.provider_access_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  revision bigint NOT NULL CHECK (revision > 0),
  provider text NOT NULL CHECK (provider IN ('aliyun', 'volcengine', 'deepseek')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  region text NOT NULL,
  endpoint text NOT NULL,
  credential_mode text NOT NULL CHECK (credential_mode IN ('sts_role', 'managed_key')),
  credential_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (org_id, revision),
  FOREIGN KEY (credential_id, org_id) REFERENCES work.provider_credential(id, org_id)
);

CREATE TABLE work.usage_daily (
  org_id text NOT NULL REFERENCES work.org(id),
  subject_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  usage_date date NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  run_count int NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, subject_id, provider, model, usage_date)
);

-- 成果
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

-- 事件、审计、Outbox、状态迁移
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


-- D3 reconciliation: an unresolved Operation can be resolved later.
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('operation', 'unresolved', 'reconciled')
ON CONFLICT DO NOTHING;
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
  IF p_kind NOT IN ('model', 'tool', 'artifact') THEN
    RAISE EXCEPTION 'scope_unavailable:operation_kind' USING ERRCODE = 'P0001';
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
CREATE TRIGGER quota_entry_append_only BEFORE UPDATE OR DELETE ON work.quota_entry
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
-- 配额锁与线性化操作（D-08：单位是 token，不是金额）
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.reserve_quota(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_operation_id uuid,
  p_amount_tokens bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  account work.quota_account%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  reservation_id uuid := gen_random_uuid();
  next_seq int;
BEGIN
  IF p_amount_tokens <= 0 THEN
    RAISE EXCEPTION 'invalid_reservation_amount' USING ERRCODE = '22023';
  END IF;
  -- Run 级硬上限对所有组织生效：预留不得超过组织策略允许的单 Run token 上限。
  SELECT * INTO policy_row FROM work.org_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
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
    SELECT 1 FROM work.quota_reservation
    WHERE operation_id = p_operation_id AND state IN ('held', 'unknown')
  ) THEN
    RAISE EXCEPTION 'operation_has_active_reservation' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(reservation_seq), 0) + 1 INTO next_seq
  FROM work.quota_reservation
  WHERE operation_id = p_operation_id;
  SELECT * INTO account
  FROM work.quota_account
  WHERE org_id = p_org_id AND account_key = p_account_key AND period_id = p_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- soft 账户只统计（客户账单在云厂商侧）；hard 账户（演示组织）超限即拒。
  IF account.enforcement = 'hard'
     AND account.limit_tokens - account.settled_tokens - account.reserved_tokens < p_amount_tokens THEN
    RAISE EXCEPTION 'quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account
    SET reserved_tokens = reserved_tokens + p_amount_tokens,
        version = version + 1,
        updated_at = now()
    WHERE id = account.id;
  INSERT INTO work.quota_reservation
    (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
  VALUES
    (reservation_id, p_org_id, account.id, p_operation_id, next_seq, p_amount_tokens, 'held');
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens)
  VALUES
    (p_org_id, account.id, reservation_id, p_operation_id, 'reserve', p_amount_tokens);
  RETURN reservation_id;
END;
$$;

CREATE FUNCTION work.settle_quota(
  p_reservation_id uuid,
  p_amount_tokens bigint,
  p_usage jsonb,
  p_settlement_revision int
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.quota_reservation%ROWTYPE;
  account work.quota_account%ROWTYPE;
  existing_amount bigint;
  v_settled bigint;
  overrun boolean := false;
BEGIN
  SELECT * INTO reservation FROM work.quota_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_settlement_revision <= reservation.settlement_revision THEN
    -- 同 revision 同金额视为幂等重试；不同金额或倒退 revision 冲突。
    SELECT amount_tokens INTO existing_amount
    FROM work.quota_entry
    WHERE operation_id = reservation.operation_id
      AND kind IN ('settle', 'adjust')
      AND settlement_revision = p_settlement_revision
    LIMIT 1;
    IF existing_amount IS NOT NULL AND existing_amount = LEAST(p_amount_tokens, reservation.amount_tokens) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'settlement_revision_not_monotonic' USING ERRCODE = 'P0001';
  END IF;
  IF reservation.state NOT IN ('held', 'unknown') THEN
    RAISE EXCEPTION 'reservation_not_settleable' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_tokens < 0 THEN
    RAISE EXCEPTION 'invalid_settlement_amount' USING ERRCODE = '22023';
  END IF;
  -- 上游报告的用量可能略超预留（在途调用收尾）；结算按预留上界截断，
  -- 超出部分只落在 usage 事实里供告警，不写进账户，避免账户不可变式越界。
  v_settled := LEAST(p_amount_tokens, reservation.amount_tokens);
  overrun := p_amount_tokens > reservation.amount_tokens;
  SELECT * INTO account FROM work.quota_account
    WHERE id = reservation.account_id FOR UPDATE;
  UPDATE work.quota_account
    SET reserved_tokens = reserved_tokens - reservation.amount_tokens,
        settled_tokens = settled_tokens + v_settled,
        version = version + 1,
        updated_at = now()
    WHERE id = account.id;
  UPDATE work.quota_reservation
    SET state = 'settled',
        settled_tokens = v_settled,
        settlement_revision = p_settlement_revision,
        settled_at = now()
    WHERE id = reservation.id;
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens,
     settlement_revision, usage)
  VALUES
    (reservation.org_id, account.id, reservation.id, reservation.operation_id,
     'settle', v_settled, p_settlement_revision,
     COALESCE(p_usage, '{}'::jsonb) || jsonb_build_object(
       'reserved_tokens', reservation.amount_tokens,
       'reported_tokens', p_amount_tokens,
       'overrun', overrun
     ));
END;
$$;

-- 配额修正只追加 adjust 分录，不改写已结算量。
CREATE FUNCTION work.adjust_quota(
  p_reservation_id uuid,
  p_delta_tokens bigint,
  p_reason text,
  p_settlement_revision int
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.quota_reservation%ROWTYPE;
  existing_amount bigint;
BEGIN
  SELECT * INTO reservation FROM work.quota_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.state <> 'settled' THEN
    RAISE EXCEPTION 'reservation_not_settled' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_revision <= reservation.settlement_revision THEN
    SELECT amount_tokens INTO existing_amount
    FROM work.quota_entry
    WHERE operation_id = reservation.operation_id
      AND kind = 'adjust'
      AND settlement_revision = p_settlement_revision
    LIMIT 1;
    IF existing_amount IS NOT NULL AND existing_amount = p_delta_tokens THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'settlement_revision_not_monotonic' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account
    SET settled_tokens = settled_tokens + p_delta_tokens,
        version = version + 1,
        updated_at = now()
    WHERE id = reservation.account_id;
  UPDATE work.quota_reservation
    SET settlement_revision = p_settlement_revision
    WHERE id = reservation.id;
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens,
     settlement_revision, usage)
  VALUES
    (reservation.org_id, reservation.account_id, reservation.id, reservation.operation_id,
     'adjust', p_delta_tokens, p_settlement_revision,
     jsonb_build_object('reason', p_reason));
END;
$$;

CREATE FUNCTION work.release_quota(p_reservation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  reservation work.quota_reservation%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM work.quota_reservation
    WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.state <> 'held' THEN
    RAISE EXCEPTION 'only_held_reservations_can_be_released' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account
    SET reserved_tokens = reserved_tokens - reservation.amount_tokens,
        version = version + 1,
        updated_at = now()
    WHERE id = reservation.account_id;
  UPDATE work.quota_reservation SET state = 'released' WHERE id = reservation.id;
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens)
  VALUES
    (reservation.org_id, reservation.account_id, reservation.id,
     reservation.operation_id, 'release', reservation.amount_tokens);
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

-- R0a 领域命令：输入、提交、成果发布、取消、审批、Outbox
-- 这些函数在装配后统一改为 SECURITY DEFINER，由 work_owner 拥有；
-- 应用角色只获得具体函数的 EXECUTE，不获得事实/账本表的直接 DML。

-- Outbox：单聚合有序 + 领取租约 + 失败退避 + 死信（死信继续阻塞本聚合）
ALTER TABLE work.outbox
  ADD COLUMN outbox_seq bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN last_error_code text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN claimed_until timestamptz;

CREATE UNIQUE INDEX work_outbox_seq ON work.outbox(outbox_seq);
CREATE INDEX work_outbox_aggregate_pending
  ON work.outbox(aggregate_type, aggregate_id, outbox_seq)
  WHERE delivered_at IS NULL;

-- 幂等命令的结果引用（retry 的 run_id、accept 的 acceptance_id、用户版本号、标题 revision）
ALTER TABLE work.submission_dedup ADD COLUMN result_ref text;

-- 调用者身份绑定：API/运维会话必须 SET LOCAL app.subject_id，函数参数中的主体必须与之相同。
CREATE FUNCTION work.assert_session_subject(p_subject_id text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_subject_id IS NULL OR p_subject_id = ''
     OR p_subject_id IS DISTINCT FROM nullif(current_setting('app.subject_id', true), '') THEN
    RAISE EXCEPTION 'actor_mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 事件/outbox/终态原因只允许枚举码，不允许自由文本（防止 provider 报错原文、用户输入进入事件）。
CREATE FUNCTION work.reason_code(p_reason text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_reason IS NOT NULL AND p_reason !~ '^[a-z][a-z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  RETURN p_reason;
END;
$$;

-- 同一幂等键的并发请求串行化（行尚不存在时 FOR UPDATE 无效）。
CREATE FUNCTION work.lock_request_key(
  p_org_id text, p_subject_id text, p_operation_type text, p_client_request_id text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid_client_request_id' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_org_id || ':' || p_subject_id || ':' || p_operation_type || ':' || p_client_request_id, 0));
END;
$$;

CREATE FUNCTION work.sha256_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

CREATE FUNCTION work.append_audit(
  p_org_id text,
  p_actor_subject_id text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  audit_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO work.audit_event
    (id, org_id, actor_subject_id, action, target_type, target_id, metadata)
  VALUES
    (audit_id, p_org_id, p_actor_subject_id, p_action, p_target_type, p_target_id,
     COALESCE(p_metadata, '{}'::jsonb));
  RETURN audit_id;
END;
$$;

CREATE FUNCTION work.append_task_event(
  p_org_id text,
  p_task_id uuid,
  p_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  next_seq bigint;
  event_id uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(MAX(seq), 0) + 1 INTO next_seq
  FROM work.task_event
  WHERE task_id = p_task_id AND org_id = p_org_id;
  INSERT INTO work.task_event
    (id, org_id, task_id, seq, type, payload)
  VALUES
    (event_id, p_org_id, p_task_id, next_seq, p_type, COALESCE(p_payload, '{}'::jsonb));
  INSERT INTO work.outbox
    (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES
    (p_org_id, 'task', p_task_id, event_id, COALESCE(p_payload, '{}'::jsonb));
  RETURN event_id;
END;
$$;

CREATE FUNCTION work.create_input(
  p_org_id text,
  p_subject_id text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text DEFAULT 'application/json'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  input_id uuid;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM 1 FROM work.member
  WHERE org_id = p_org_id
    AND subject_id = p_subject_id
    AND status = 'active'
    AND work_seat = true
    AND role <> 'viewer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes <= 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  -- 只复用尚未绑定任务的同哈希输入；已绑定的输入属于那个任务，删除时随之粉碎。
  -- 未绑定输入按 work.input_ttl_hours（默认 24 小时）过期，由 work.expire_due_inputs 清扫。
  INSERT INTO work.input_object
    (org_id, subject_id, purpose, content_ref, content_hash, bytes, media_type, expires_at)
  VALUES
    (p_org_id, p_subject_id, 'task_input', p_content_ref, p_content_hash, p_bytes, p_media_type,
     now() + make_interval(hours => work.input_ttl_hours()))
  ON CONFLICT (org_id, subject_id, content_hash, purpose) WHERE status = 'active' AND task_id IS NULL
  DO NOTHING
  RETURNING id INTO input_id;
  IF input_id IS NULL THEN
    SELECT id INTO input_id
    FROM work.input_object
    WHERE org_id = p_org_id
      AND subject_id = p_subject_id
      AND content_hash = p_content_hash
      AND purpose = 'task_input'
      AND status = 'active'
      AND task_id IS NULL;
  END IF;
  IF input_id IS NULL THEN
    RAISE EXCEPTION 'input_conflict_retry' USING ERRCODE = '40001';
  END IF;
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'input.create', 'input', input_id::text,
    jsonb_build_object('bytes', p_bytes, 'media_type', p_media_type)
  );
  RETURN input_id;
END;
$$;

-- 输入创建幂等：client_request_id 同键同内容返回原 input；同键异内容 409。
CREATE FUNCTION work.create_input_idempotent(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text DEFAULT 'application/json'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  dedup_row work.submission_dedup%ROWTYPE;
  req_hash text;
  input_id uuid;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(
    p_org_id, p_subject_id, 'input.create', p_client_request_id
  );
  req_hash := work.sha256_text(jsonb_build_object(
    'content_hash', p_content_hash,
    'bytes', p_bytes,
    'media_type', p_media_type
  )::text);
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id
    AND d.subject_id = p_subject_id
    AND d.operation_type = 'input.create'
    AND d.client_request_id = p_client_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN dedup_row.result_ref::uuid;
  END IF;
  input_id := work.create_input(
    p_org_id, p_subject_id, p_content_ref, p_content_hash, p_bytes, p_media_type
  );
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'input.create', p_client_request_id, req_hash,
     input_id::text);
  RETURN input_id;
END;
$$;

-- 提交：幂等键加锁 → 先查重放（重放不受后续席位/组织/输入变化影响）→ 再做准入检查。
-- 请求哈希由服务端从规范化参数计算，不信任客户端摘要。
CREATE FUNCTION work.submit_task(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_input_id uuid,
  p_title text,
  p_permission_mode text,
  p_snapshot_hash text,
  p_snapshot_manifest jsonb,
  p_tool_allowlist text[],
  p_model_route jsonb,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (task_id uuid, run_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  org_row work.org%ROWTYPE;
  member_row work.member%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  input_row work.input_object%ROWTYPE;
  req_hash text;
  new_task_id uuid := gen_random_uuid();
  new_snapshot_id uuid := gen_random_uuid();
  new_run_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'task.submit', p_client_request_id);
  req_hash := work.sha256_text(jsonb_build_object(
    'input_id', p_input_id, 'title', p_title, 'permission_mode', p_permission_mode,
    'snapshot_hash', p_snapshot_hash, 'tool_allowlist', to_jsonb(p_tool_allowlist),
    'model_route', p_model_route
  )::text);

  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id
    AND d.subject_id = p_subject_id
    AND d.operation_type = 'task.submit'
    AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted OR dedup_row.task_id IS NULL THEN
      RAISE EXCEPTION 'task_deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
      SELECT t.id, r.id, t.revision
      FROM work.task t
      JOIN work.run r
        ON r.task_id = t.id AND r.org_id = t.org_id AND r.attempt_no = 1
      WHERE t.id = dedup_row.task_id AND t.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dedup_task_missing' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'title_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_permission_mode NOT IN ('ask_each', 'auto_readonly') THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF p_tool_allowlist IS NULL
     OR NOT (p_tool_allowlist <@ ARRAY['model_call', 'read_builtin_template', 'write_artifact_draft']::text[])
     OR NOT ('model_call' = ANY (p_tool_allowlist)) THEN
    RAISE EXCEPTION 'scope_unavailable:tool_allowlist' USING ERRCODE = 'P0001';
  END IF;
  IF p_snapshot_hash IS NULL OR p_snapshot_hash = ''
     OR p_snapshot_manifest IS NULL
     OR p_model_route IS NULL
     OR p_workflow_id IS NULL OR p_workflow_id = ''
     OR p_runtime_version IS NULL OR p_runtime_version = '' THEN
    RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO org_row
  FROM work.org
  WHERE id = p_org_id
  FOR SHARE;
  IF NOT FOUND
     OR org_row.status <> 'active'
     OR NOT org_row.execution_enabled
     OR org_row.operator_suspended THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO member_row
  FROM work.member
  WHERE org_id = p_org_id AND subject_id = p_subject_id
  FOR SHARE;
  IF NOT FOUND
     OR member_row.status <> 'active'
     OR NOT member_row.work_seat
     OR member_row.role = 'viewer' THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO policy_row
  FROM work.org_policy
  WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF policy_row.force_ask_each AND p_permission_mode <> 'ask_each' THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF p_permission_mode = 'auto_readonly' AND NOT policy_row.allow_auto_readonly THEN
    RAISE EXCEPTION 'permission_mode_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO input_row
  FROM work.input_object i
  WHERE i.id = p_input_id
    AND i.org_id = p_org_id
    AND i.subject_id = p_subject_id
    AND i.status = 'active'
    AND i.task_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'input_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO work.task
    (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
  VALUES
    (new_task_id, p_org_id, p_subject_id, 'open', p_permission_mode, btrim(p_title), p_input_id, 0);

  UPDATE work.input_object i
  SET task_id = new_task_id
  WHERE i.id = p_input_id AND i.org_id = p_org_id;

  INSERT INTO work.capability_snapshot
    (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
     model_route, scope_caps, manifest)
  VALUES
    (new_snapshot_id, p_org_id, new_task_id, 'r0a-v1', p_snapshot_hash,
     p_tool_allowlist, p_model_route, '{}'::jsonb, p_snapshot_manifest);

  UPDATE work.task t
  SET snapshot_id = new_snapshot_id
  WHERE t.id = new_task_id AND t.org_id = p_org_id;

  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (new_run_id, p_org_id, new_task_id, 1, 'queued', new_snapshot_id, p_workflow_id, p_runtime_version);

  UPDATE work.task AS t
  SET active_run_id = new_run_id,
      latest_run_id = new_run_id,
      revision = t.revision + 1,
      updated_at = now()
  WHERE t.id = new_task_id AND t.org_id = p_org_id;

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'task.submit', p_client_request_id, req_hash, new_task_id, 'accepted', new_run_id::text);

  PERFORM work.append_task_event(
    p_org_id, new_task_id, 'task.submitted',
    jsonb_build_object(
      'task_id', new_task_id,
      'run_id', new_run_id,
      'state', 'open',
      'permission_mode', p_permission_mode
    )
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', new_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', p_workflow_id)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.submit', 'task', new_task_id::text,
    jsonb_build_object(
      'run_id', new_run_id,
      'permission_mode', p_permission_mode,
      'snapshot_hash', p_snapshot_hash
    )
  );
  RETURN QUERY SELECT new_task_id, new_run_id, 1::bigint;
END;
$$;

-- Worker 发布成果：仅当前 active/waiting Run；同 Run 同逻辑名同哈希的重放返回已有版本（活动重试幂等）。
CREATE FUNCTION work.publish_artifact(
  p_org_id text,
  p_task_id uuid,
  p_run_id uuid,
  p_logical_name text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text,
  p_provenance jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (artifact_id uuid, version_no int)
LANGUAGE plpgsql AS $$
DECLARE
  artifact_row work.artifact%ROWTYPE;
  next_version int;
  existing_version int;
  new_artifact_id uuid := gen_random_uuid();
BEGIN
  IF p_logical_name IS NULL OR p_logical_name = ''
     OR p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes < 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_artifact' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM work.task t
  JOIN work.run r
    ON r.task_id = t.id AND r.org_id = t.org_id
  WHERE t.id = p_task_id
    AND t.org_id = p_org_id
    AND t.deleted_at IS NULL
    AND r.id = p_run_id
    AND r.org_id = p_org_id
  FOR UPDATE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_accepting_artifacts' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO artifact_row
  FROM work.artifact a
  WHERE a.org_id = p_org_id AND a.task_id = p_task_id AND a.logical_name = p_logical_name
  FOR UPDATE;
  IF FOUND THEN
    SELECT av.version_no INTO existing_version
    FROM work.artifact_version av
    WHERE av.artifact_id = artifact_row.id AND av.org_id = p_org_id
      AND av.content_hash = p_content_hash
      AND av.provenance->>'run_id' = p_run_id::text
    ORDER BY av.version_no DESC
    LIMIT 1;
    IF existing_version IS NOT NULL THEN
      RETURN QUERY SELECT artifact_row.id, existing_version;
      RETURN;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.run r WHERE r.id = p_run_id AND r.org_id = p_org_id AND r.state IN ('active', 'waiting')
  ) THEN
    RAISE EXCEPTION 'run_not_accepting_artifacts' USING ERRCODE = 'P0001';
  END IF;
  IF artifact_row.id IS NOT NULL THEN
    IF artifact_row.state = 'deleted' THEN
      RAISE EXCEPTION 'artifact_deleted' USING ERRCODE = 'P0001';
    END IF;
    new_artifact_id := artifact_row.id;
  ELSE
    INSERT INTO work.artifact
      (id, org_id, task_id, logical_name, state)
    VALUES
      (new_artifact_id, p_org_id, p_task_id, p_logical_name, 'draft');
  END IF;
  SELECT COALESCE(MAX(av.version_no), 0) + 1 INTO next_version
  FROM work.artifact_version av
  WHERE av.artifact_id = new_artifact_id AND av.org_id = p_org_id;
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance)
  VALUES
    (new_artifact_id, p_org_id, next_version, p_content_ref, p_content_hash,
     p_bytes, p_media_type, 'staged',
     COALESCE(p_provenance, '{}'::jsonb) || jsonb_build_object('source', 'run', 'run_id', p_run_id));
  UPDATE work.artifact_version AS av
  SET state = 'published', published_at = now()
  WHERE av.artifact_id = new_artifact_id AND av.org_id = p_org_id AND av.version_no = next_version;
  UPDATE work.artifact a
  SET state = 'published', revision = a.revision + 1, updated_at = now()
  WHERE a.id = new_artifact_id AND a.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'artifact.published',
    jsonb_build_object(
      'artifact_id', new_artifact_id,
      'version_no', next_version,
      'source', 'run',
      'content_hash', p_content_hash,
      'bytes', p_bytes,
      'media_type', p_media_type
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'artifact.publish', 'artifact', new_artifact_id::text,
    jsonb_build_object('task_id', p_task_id, 'run_id', p_run_id, 'version_no', next_version)
  );
  RETURN QUERY SELECT new_artifact_id, next_version;
END;
$$;

-- 用户取消运行：仅任务 owner；原因只收枚举码。
CREATE FUNCTION work.request_cancel(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
  reason text := work.reason_code(p_reason);
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  SELECT r.task_id INTO task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = task_id AND t.org_id = p_org_id
  FOR UPDATE;
  IF task_row.deleted_at IS NOT NULL OR task_row.owner_subject_id <> p_actor_subject_id THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO run_row
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id
  FOR UPDATE;
  IF run_row.state IN ('succeeded', 'failed', 'canceled', 'cancel_requested') THEN
    RETURN;
  END IF;
  UPDATE work.run r
  SET state = 'cancel_requested',
      wait_reason = NULL,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.cancel_requested',
    jsonb_build_object('run_id', p_run_id, 'reason', reason)
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', p_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'cancel_signal', 'run_id', p_run_id, 'reason', reason)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'run.cancel_request', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id, 'reason', reason)
  );
END;
$$;

CREATE FUNCTION work.authorize_operation(
  p_org_id text,
  p_operation_id uuid,
  p_policy_epoch bigint,
  p_decision_source text DEFAULT 'policy_auto'
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
BEGIN
  IF p_decision_source <> 'policy_auto' THEN
    RAISE EXCEPTION 'invalid_decision_source' USING ERRCODE = '22023';
  END IF;
  IF p_policy_epoch IS NULL OR p_policy_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid_policy_epoch' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'waiting_approval' THEN
    RAISE EXCEPTION 'approval_required' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state <> 'prepared' THEN
    RAISE EXCEPTION 'operation_not_authorizable' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation
  SET state = 'authorized',
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.authorized',
    jsonb_build_object(
      'operation_id', p_operation_id,
      'decision_source', p_decision_source,
      'policy_epoch', p_policy_epoch
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.authorize', 'operation', p_operation_id::text,
    jsonb_build_object('policy_epoch', p_policy_epoch, 'decision_source', p_decision_source)
  );
END;
$$;

-- 活动重试幂等：同结果同 provider_request_id 的重放直接返回。
CREATE FUNCTION work.finish_operation(
  p_org_id text,
  p_operation_id uuid,
  p_outcome text,
  p_provider_request_id text DEFAULT NULL,
  p_receipt_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid_operation_outcome' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task t WHERE t.id = task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = p_outcome
     AND operation_row.provider_request_id IS NOT DISTINCT FROM p_provider_request_id THEN
    RETURN;
  END IF;
  IF operation_row.state <> 'dispatching' THEN
    RAISE EXCEPTION 'operation_not_dispatching' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation o
  SET state = p_outcome,
      provider_request_id = p_provider_request_id,
      receipt_ref = p_receipt_ref,
      revision = o.revision + 1,
      updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.finished',
    jsonb_build_object(
      'operation_id', p_operation_id,
      'outcome', p_outcome,
      'provider_request_id', p_provider_request_id
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.finish', 'operation', p_operation_id::text,
    jsonb_build_object('outcome', p_outcome, 'provider_request_id', p_provider_request_id)
  );
END;
$$;

-- Worker 取消 Operation（仅 worker 授权）：派发中 → unknown；未派发 → canceled + 释放预算 + 过期审批。
CREATE FUNCTION work.cancel_operation(
  p_org_id text,
  p_operation_id uuid,
  p_actor_subject_id text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reservation_id uuid;
  reason text := work.reason_code(p_reason);
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task t WHERE t.id = task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state IN ('succeeded', 'failed', 'canceled', 'reconciled', 'unresolved', 'unknown') THEN
    RETURN;
  END IF;
  IF operation_row.state = 'dispatching' THEN
    UPDATE work.operation o
    SET state = 'unknown',
        revision = o.revision + 1,
        updated_at = now()
    WHERE o.id = p_operation_id AND o.org_id = p_org_id;
    PERFORM work.append_task_event(
      p_org_id, task_id, 'operation.unknown',
      jsonb_build_object('operation_id', p_operation_id, 'reason', reason)
    );
    PERFORM work.append_audit(
      p_org_id, p_actor_subject_id, 'operation.unknown', 'operation', p_operation_id::text,
      jsonb_build_object('reason', reason)
    );
    RETURN;
  END IF;
  UPDATE work.operation o
  SET state = 'canceled',
      revision = o.revision + 1,
      updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  UPDATE work.approval a
  SET status = 'expired', revision = a.revision + 1, updated_at = now()
  FROM work.approval_operation ao
  WHERE ao.approval_id = a.id AND ao.org_id = a.org_id
    AND ao.operation_id = p_operation_id AND a.org_id = p_org_id
    AND a.status = 'pending';
  SELECT br.id INTO reservation_id
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id AND br.state = 'held';
  IF reservation_id IS NOT NULL THEN
    PERFORM work.release_quota(reservation_id);
  END IF;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.canceled',
    jsonb_build_object('operation_id', p_operation_id, 'reason', reason)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'operation.cancel', 'operation', p_operation_id::text,
    jsonb_build_object('reason', reason)
  );
END;
$$;


CREATE FUNCTION work.wait_run(
  p_org_id text,
  p_run_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  task_row work.task%ROWTYPE;
  run_row work.run%ROWTYPE;
BEGIN
  IF p_reason NOT IN ('quota', 'provider', 'reconcile') THEN
    RAISE EXCEPTION 'invalid_wait_reason' USING ERRCODE = '22023';
  END IF;
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
  IF run_row.state = 'waiting' THEN
    IF run_row.wait_reason IS DISTINCT FROM p_reason THEN
      UPDATE work.run
      SET wait_reason = p_reason,
          control_revision = control_revision + 1,
          updated_at = now()
      WHERE id = p_run_id AND org_id = p_org_id;
      PERFORM work.append_task_event(
        p_org_id, task_id, 'run.waiting',
        jsonb_build_object('run_id', p_run_id, 'reason', p_reason)
      );
    END IF;
    RETURN;
  END IF;
  IF run_row.state <> 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = 'waiting',
      wait_reason = p_reason,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.waiting',
    jsonb_build_object('run_id', p_run_id, 'reason', p_reason)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'run.wait', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id, 'reason', p_reason)
  );
END;
$$;

CREATE FUNCTION work.resume_run(
  p_org_id text,
  p_run_id uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  task_row work.task%ROWTYPE;
  run_row work.run%ROWTYPE;
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
  IF run_row.state = 'active' THEN
    RETURN;
  END IF;
  IF run_row.state <> 'waiting' THEN
    RAISE EXCEPTION 'run_not_waiting' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run
  SET state = 'active',
      wait_reason = NULL,
      control_revision = control_revision + 1,
      updated_at = now()
  WHERE id = p_run_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'run.resumed',
    jsonb_build_object('run_id', p_run_id)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'run.resume', 'run', p_run_id::text,
    jsonb_build_object('task_id', task_id)
  );
END;
$$;

CREATE FUNCTION work.mark_operation_unknown(
  p_org_id text,
  p_operation_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reason text := work.reason_code(p_reason);
BEGIN
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'unknown' THEN
    RETURN;
  END IF;
  IF operation_row.state <> 'dispatching' THEN
    RAISE EXCEPTION 'operation_not_dispatching' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.operation
  SET state = 'unknown',
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'operation.unknown',
    jsonb_build_object('operation_id', p_operation_id, 'reason', reason)
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.unknown', 'operation', p_operation_id::text,
    jsonb_build_object('task_id', task_id, 'reason', reason)
  );
END;
$$;

CREATE FUNCTION work.reconcile_operation(
  p_org_id text,
  p_operation_id uuid,
  p_resolution text,
  p_provider_request_id text DEFAULT NULL,
  p_settled_tokens bigint DEFAULT 0,
  p_evidence_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  reservation work.quota_reservation%ROWTYPE;
  next_revision int;
BEGIN
  IF p_resolution NOT IN ('sent_succeeded', 'not_sent', 'unresolved') THEN
    RAISE EXCEPTION 'invalid_reconciliation_resolution' USING ERRCODE = '22023';
  END IF;
  IF p_settled_tokens < 0 THEN
    RAISE EXCEPTION 'invalid_settlement_amount' USING ERRCODE = '22023';
  END IF;
  IF p_resolution IN ('sent_succeeded', 'not_sent')
     AND (p_evidence_ref IS NULL OR p_evidence_ref = '') THEN
    RAISE EXCEPTION 'reconciliation_evidence_required' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
  WHERE id = task_id AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'reconciled' THEN
    RETURN;
  END IF;
  IF operation_row.state = 'unresolved' AND p_resolution = 'unresolved' THEN
    RETURN;
  END IF;
  IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
    RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO reservation
  FROM work.quota_reservation
  WHERE operation_id = p_operation_id AND org_id = p_org_id
  ORDER BY reservation_seq DESC
  LIMIT 1
  FOR UPDATE;
  IF p_resolution = 'sent_succeeded' THEN
    IF reservation.id IS NULL THEN
      RAISE EXCEPTION 'reservation_not_found' USING ERRCODE = 'P0002';
    END IF;
    next_revision := reservation.settlement_revision + 1;
    PERFORM work.settle_quota(
      reservation.id, p_settled_tokens,
      jsonb_build_object('resolution', p_resolution, 'evidence_ref', p_evidence_ref),
      next_revision
    );
  ELSIF p_resolution = 'not_sent' THEN
    IF reservation.id IS NOT NULL AND reservation.state = 'held' THEN
      PERFORM work.release_quota(reservation.id);
    ELSIF reservation.id IS NOT NULL AND reservation.state = 'unknown' THEN
      next_revision := reservation.settlement_revision + 1;
      PERFORM work.settle_quota(
        reservation.id, 0,
        jsonb_build_object('resolution', p_resolution, 'evidence_ref', p_evidence_ref),
        next_revision
      );
    END IF;
  END IF;
  UPDATE work.operation
  SET state = CASE WHEN p_resolution = 'unresolved' THEN 'unresolved' ELSE 'reconciled' END,
      provider_request_id = COALESCE(p_provider_request_id, provider_request_id),
      receipt_ref = COALESCE(p_evidence_ref, receipt_ref),
      revision = revision + 1,
      updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconciled' END,
    jsonb_build_object(
      'operation_id', p_operation_id,
      'resolution', p_resolution,
      'settled_tokens', p_settled_tokens,
      'evidence_ref', p_evidence_ref
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL,
    CASE WHEN p_resolution = 'unresolved' THEN 'operation.unresolved' ELSE 'operation.reconcile' END,
    'operation', p_operation_id::text,
    jsonb_build_object('resolution', p_resolution, 'settled_tokens', p_settled_tokens, 'evidence_ref', p_evidence_ref)
  );
END;
$$;

-- Worker 按策略为 Operation 发起审批（R0a golden path 不可达，内部命令保留）。
CREATE FUNCTION work.request_approval(
  p_org_id text,
  p_operation_id uuid,
  p_params_hash text,
  p_scope jsonb,
  p_risk text,
  p_expires_at timestamptz,
  p_policy_epoch bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  task_id uuid;
  operation_row work.operation%ROWTYPE;
  new_approval_id uuid := gen_random_uuid();
  existing_id uuid;
BEGIN
  IF p_params_hash IS NULL OR p_params_hash = ''
     OR p_scope IS NULL
     OR p_risk NOT IN ('low', 'medium', 'high')
     OR p_expires_at IS NULL OR p_expires_at <= now()
     OR p_policy_epoch IS NULL OR p_policy_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid_approval_request' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task t
  WHERE t.id = task_id AND t.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  IF operation_row.state = 'waiting_approval' THEN
    SELECT ao.approval_id INTO existing_id
    FROM work.approval_operation ao
    WHERE ao.operation_id = p_operation_id AND ao.org_id = p_org_id;
    IF existing_id IS NOT NULL THEN
      RETURN existing_id;
    END IF;
  END IF;
  IF operation_row.state <> 'prepared' THEN
    RAISE EXCEPTION 'operation_not_approvable' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO work.approval
    (id, org_id, target_type, params_hash, scope, risk, expires_at, policy_epoch, status)
  VALUES
    (new_approval_id, p_org_id, 'operation', p_params_hash, p_scope, p_risk,
     p_expires_at, p_policy_epoch, 'pending');
  INSERT INTO work.approval_operation
    (approval_id, operation_id, org_id)
  VALUES
    (new_approval_id, p_operation_id, p_org_id);
  UPDATE work.operation o
  SET state = 'waiting_approval',
      revision = o.revision + 1,
      updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'approval.requested',
    jsonb_build_object(
      'approval_id', new_approval_id,
      'operation_id', p_operation_id,
      'risk', p_risk,
      'expires_at', p_expires_at
    )
  );
  PERFORM work.append_audit(
    p_org_id, NULL, 'approval.request', 'approval', new_approval_id::text,
    jsonb_build_object('operation_id', p_operation_id, 'risk', p_risk)
  );
  RETURN new_approval_id;
END;
$$;

-- 用户审批：R0a 审批人 = 任务 owner（在职、非 viewer）；与会话主体绑定。
CREATE FUNCTION work.decide_approval(
  p_org_id text,
  p_approval_id uuid,
  p_actor_subject_id text,
  p_decision text,
  p_expected_revision bigint,
  p_params_hash text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  approval_row work.approval%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  task_row work.task%ROWTYPE;
  task_id uuid;
  existing_decision work.approval_decision%ROWTYPE;
  reservation_id uuid;
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_approval_decision' USING ERRCODE = '22023';
  END IF;
  SELECT o.id, r.task_id INTO operation_row.id, task_id
  FROM work.approval_operation ao
  JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE ao.approval_id = p_approval_id AND ao.org_id = p_org_id;
  IF operation_row.id IS NULL THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t WHERE t.id = task_id AND t.org_id = p_org_id FOR UPDATE;
  IF task_row.deleted_at IS NOT NULL
     OR task_row.owner_subject_id <> p_actor_subject_id
     OR NOT EXISTS (
       SELECT 1 FROM work.member m
       WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
         AND m.status = 'active' AND m.role <> 'viewer'
     ) THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = operation_row.id AND o.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO approval_row
  FROM work.approval a
  WHERE a.id = p_approval_id AND a.org_id = p_org_id
  FOR UPDATE;
  IF approval_row.status <> 'pending' THEN
    SELECT * INTO existing_decision
    FROM work.approval_decision d
    WHERE d.approval_id = p_approval_id AND d.org_id = p_org_id;
    IF FOUND
       AND existing_decision.decision = p_decision
       AND existing_decision.params_hash = p_params_hash
       AND existing_decision.actor_subject_id = p_actor_subject_id THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'approval_not_pending' USING ERRCODE = 'P0001';
  END IF;
  IF approval_row.revision <> p_expected_revision
     OR approval_row.params_hash <> p_params_hash
     OR approval_row.expires_at <= now() THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.approval a
  SET status = p_decision,
      revision = a.revision + 1,
      updated_at = now()
  WHERE a.id = p_approval_id AND a.org_id = p_org_id;
  INSERT INTO work.approval_decision
    (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch)
  VALUES
    (p_approval_id, p_org_id, p_decision, p_actor_subject_id, p_params_hash, approval_row.policy_epoch);
  IF p_decision = 'approved' THEN
    UPDATE work.operation o
    SET state = 'authorized',
        revision = o.revision + 1,
        updated_at = now()
    WHERE o.id = operation_row.id AND o.org_id = p_org_id;
  ELSE
    UPDATE work.operation o
    SET state = 'canceled',
        revision = o.revision + 1,
        updated_at = now()
    WHERE o.id = operation_row.id AND o.org_id = p_org_id;
    SELECT br.id INTO reservation_id
    FROM work.quota_reservation br
    WHERE br.operation_id = operation_row.id AND br.state = 'held';
    IF reservation_id IS NOT NULL THEN
      PERFORM work.release_quota(reservation_id);
    END IF;
  END IF;
  PERFORM work.append_task_event(
    p_org_id, task_id, 'approval.decided',
    jsonb_build_object(
      'approval_id', p_approval_id,
      'operation_id', operation_row.id,
      'decision', p_decision
    )
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'approval.decide', 'approval', p_approval_id::text,
    jsonb_build_object('operation_id', operation_row.id, 'decision', p_decision)
  );
END;
$$;

-- Outbox relay（跨组织）：relay 不设 app.org_id；本组函数在 work_owner 身份下临时打开
-- app.outbox_relay，配合 outbox_relay 策略看到全部组织的行，函数返回前关闭。
-- 顺序：同一 (aggregate_type, aggregate_id) 只有最早的未投递行可被领取；在途（租约未过期）、
-- 退避中、死信中的头部行都会挡住后续行。跨聚合不保证顺序。
-- 租约：领取写入 claimed_by/claimed_until；ACK/失败必须由持有者提交，否则 outbox_lease_lost。
CREATE FUNCTION work.claim_outbox(
  p_relay_id text,
  p_limit int DEFAULT 20,
  p_lease_seconds int DEFAULT 60
) RETURNS SETOF work.outbox
LANGUAGE plpgsql AS $$
BEGIN
  IF p_relay_id IS NULL OR p_relay_id !~ '^[a-z0-9][a-z0-9._:-]{2,63}$'
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 600 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.outbox_relay', 'on', true);
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM work.outbox o
    WHERE o.delivered_at IS NULL
      AND o.dead_lettered_at IS NULL
      AND o.available_at <= now()
      AND (o.claimed_until IS NULL OR o.claimed_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM work.outbox e
        WHERE e.aggregate_type = o.aggregate_type
          AND e.aggregate_id = o.aggregate_id
          AND e.outbox_seq < o.outbox_seq
          AND e.delivered_at IS NULL
      )
    ORDER BY o.outbox_seq
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE work.outbox u
  SET claimed_by = p_relay_id,
      claimed_until = now() + make_interval(secs => p_lease_seconds)
  FROM picked
  WHERE u.id = picked.id
  RETURNING u.*;
  PERFORM set_config('app.outbox_relay', 'off', true);
END;
$$;

CREATE FUNCTION work.lock_claimed_outbox(p_event_id uuid, p_relay_id text)
RETURNS work.outbox
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
BEGIN
  PERFORM set_config('app.outbox_relay', 'on', true);
  SELECT * INTO row_ FROM work.outbox o WHERE o.event_id = p_event_id FOR UPDATE;
  PERFORM set_config('app.outbox_relay', 'off', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF row_.delivered_at IS NULL AND row_.dead_lettered_at IS NULL
     AND row_.claimed_by IS DISTINCT FROM p_relay_id THEN
    RAISE EXCEPTION 'outbox_lease_lost' USING ERRCODE = 'P0001';
  END IF;
  RETURN row_;
END;
$$;

-- 投递失败：可重试按 2^attempts 秒退避（上限 300s）；第 10 次（约 13.5 分钟）或不可重试即死信。
-- start_workflow 死信时 Run 若仍 queued → failed、若已 cancel_requested → canceled（原因 dispatch_dead_letter），
-- 同一 Run 之后的消息标记 superseded（Run 已终态，不再阻塞，也不会留下无工作流的 cancel_requested）。
CREATE FUNCTION work.mark_outbox_failed(
  p_event_id uuid,
  p_relay_id text,
  p_error_code text,
  p_retryable boolean
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
  next_attempts int;
  prev_org text := current_setting('app.org_id', true);
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  row_ := work.lock_claimed_outbox(p_event_id, p_relay_id);
  IF row_.delivered_at IS NOT NULL THEN
    RETURN 'delivered';
  END IF;
  IF row_.dead_lettered_at IS NOT NULL THEN
    RETURN 'dead_letter';
  END IF;
  next_attempts := row_.attempts + 1;
  PERFORM set_config('app.org_id', row_.org_id, true);
  IF NOT p_retryable OR next_attempts >= 10 THEN
    UPDATE work.outbox o
    SET attempts = next_attempts, last_error_code = p_error_code,
        dead_lettered_at = now(), claimed_until = NULL
    WHERE o.id = row_.id;
    PERFORM work.append_audit(
      row_.org_id, 'system:outbox-relay', 'outbox.dead_lettered', row_.aggregate_type,
      row_.aggregate_id::text,
      jsonb_build_object('event_id', p_event_id, 'attempts', next_attempts, 'error_code', p_error_code)
    );
    IF row_.aggregate_type = 'run' AND row_.payload->>'kind' = 'start_workflow' AND EXISTS (
      SELECT 1 FROM work.run r WHERE r.id = row_.aggregate_id AND r.org_id = row_.org_id
        AND r.state IN ('queued', 'cancel_requested')
    ) THEN
      PERFORM work.finish_run(
        row_.aggregate_id, row_.org_id,
        CASE WHEN (SELECT r.state FROM work.run r WHERE r.id = row_.aggregate_id) = 'queued'
             THEN 'failed' ELSE 'canceled' END,
        'dispatch_dead_letter');
      UPDATE work.outbox o
      SET delivered_at = now(), last_error_code = 'superseded_run_terminal', claimed_until = NULL
      WHERE o.aggregate_type = 'run' AND o.aggregate_id = row_.aggregate_id
        AND o.outbox_seq > row_.outbox_seq AND o.delivered_at IS NULL;
    END IF;
    PERFORM set_config('app.org_id', COALESCE(prev_org, ''), true);
    RETURN 'dead_letter';
  END IF;
  UPDATE work.outbox o
  SET attempts = next_attempts,
      last_error_code = p_error_code,
      claimed_until = NULL,
      available_at = now() + make_interval(secs => LEAST(power(2, next_attempts), 300))
  WHERE o.id = row_.id;
  PERFORM set_config('app.org_id', COALESCE(prev_org, ''), true);
  RETURN 'retry_scheduled';
END;
$$;

CREATE FUNCTION work.mark_outbox_delivered(p_event_id uuid, p_relay_id text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
BEGIN
  row_ := work.lock_claimed_outbox(p_event_id, p_relay_id);
  IF row_.delivered_at IS NOT NULL THEN
    RETURN;
  END IF;
  IF row_.dead_lettered_at IS NOT NULL THEN
    RAISE EXCEPTION 'outbox_dead_lettered' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.outbox_relay', 'on', true);
  UPDATE work.outbox o
  SET delivered_at = now(), attempts = o.attempts + 1, claimed_until = NULL
  WHERE o.id = row_.id;
  PERFORM set_config('app.outbox_relay', 'off', true);
END;
$$;

-- 运维重放死信（本组织）：必须给理由；写审计；Run 已不在 queued 的 start_workflow 拒绝重放。
CREATE FUNCTION work.requeue_outbox_dead_letter(
  p_event_id uuid,
  p_actor_subject_id text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO row_
  FROM work.outbox o
  WHERE o.event_id = p_event_id
    AND o.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND OR row_.dead_lettered_at IS NULL OR row_.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF row_.payload->>'kind' = 'start_workflow' AND NOT EXISTS (
    SELECT 1 FROM work.run r WHERE r.id = row_.aggregate_id AND r.org_id = row_.org_id AND r.state = 'queued'
  ) THEN
    RAISE EXCEPTION 'outbox_requeue_stale' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.outbox o
  SET dead_lettered_at = NULL, attempts = 0, available_at = now(),
      claimed_by = NULL, claimed_until = NULL
  WHERE o.id = row_.id;
  PERFORM work.append_audit(
    row_.org_id, p_actor_subject_id, 'outbox.requeued', row_.aggregate_type,
    row_.aggregate_id::text,
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason, 'last_error_code', row_.last_error_code)
  );
END;
$$;

-- 运维跳过死信：确认下游不需要该消息后解除聚合阻塞；写审计。
CREATE FUNCTION work.skip_outbox_dead_letter(
  p_event_id uuid,
  p_actor_subject_id text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  row_ work.outbox%ROWTYPE;
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO row_
  FROM work.outbox o
  WHERE o.event_id = p_event_id
    AND o.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND OR row_.dead_lettered_at IS NULL OR row_.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'outbox_event_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE work.outbox o
  SET delivered_at = now(), last_error_code = 'skipped_by_ops', claimed_until = NULL
  WHERE o.id = row_.id;
  PERFORM work.append_audit(
    row_.org_id, p_actor_subject_id, 'outbox.skipped', row_.aggregate_type,
    row_.aggregate_id::text,
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason, 'last_error_code', row_.last_error_code)
  );
END;
$$;


-- ---------------------------------------------------------------------------
-- 组织执行闸门：新增 Run/Operation/预算预留必须检查组织执行开通。
-- 终态/取消/对账更新不被此触发器阻断。
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.enforce_org_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM work.org
    WHERE id = NEW.org_id
      AND status = 'active'
      AND execution_enabled
      AND NOT operator_suspended
  ) THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_org_execution_insert
  BEFORE INSERT ON work.run
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();
CREATE TRIGGER run_org_execution_active
  BEFORE UPDATE OF state ON work.run
  FOR EACH ROW
  WHEN (OLD.state <> 'active' AND NEW.state = 'active')
  EXECUTE FUNCTION work.enforce_org_execution();

CREATE TRIGGER operation_org_execution_insert
  BEFORE INSERT ON work.operation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();
CREATE TRIGGER operation_org_execution_start
  BEFORE UPDATE OF state ON work.operation
  FOR EACH ROW
  WHEN (OLD.state <> NEW.state AND NEW.state IN ('authorized', 'dispatching'))
  EXECUTE FUNCTION work.enforce_org_execution();

CREATE TRIGGER reservation_org_execution
  BEFORE INSERT ON work.quota_reservation
  FOR EACH ROW EXECUTE FUNCTION work.enforce_org_execution();

-- ---------------------------------------------------------------------------
-- R0a 任务摘要投影（供“我的工作”与 TaskDetail 使用）
-- ---------------------------------------------------------------------------
CREATE VIEW work.task_summary
WITH (security_invoker = true) AS
SELECT
  t.org_id,
  t.id AS task_id,
  t.owner_subject_id,
  t.title,
  t.state AS task_state,
  t.permission_mode,
  t.active_run_id,
  t.latest_run_id,
  t.revision,
  t.created_at,
  t.updated_at,
  r.state AS run_state,
  r.wait_reason,
  r.terminal_reason,
  a.id AS latest_artifact_id,
  av.version_no AS latest_artifact_version,
  av.content_hash AS latest_artifact_hash,
  (t.state = 'awaiting_acceptance') AS pending_acceptance,
  COALESCE((
    SELECT count(*)
    FROM work.operation o
    WHERE o.run_id = r.id
      AND o.org_id = t.org_id
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown', 'unresolved')
  ), 0) AS blocking_operations,
  COALESCE((
    SELECT SUM(br.amount_tokens)
    FROM work.quota_reservation br
    JOIN work.operation o ON o.id = br.operation_id AND o.org_id = br.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND br.state IN ('held', 'unknown')
  ), 0) AS reserved_tokens,
  COALESCE((
    SELECT SUM(be.amount_tokens)
    FROM work.quota_entry be
    JOIN work.operation o ON o.id = be.operation_id AND o.org_id = be.org_id
    WHERE o.run_id IN (
      SELECT rr.id FROM work.run rr WHERE rr.task_id = t.id AND rr.org_id = t.org_id
    )
      AND be.kind IN ('settle', 'adjust')
  ), 0) AS settled_tokens,
  CASE
    WHEN t.state = 'completed' THEN 'completed'
    WHEN t.state = 'canceled' THEN 'canceled'
    WHEN t.state = 'archived' THEN 'archived'
    WHEN t.state = 'awaiting_acceptance' THEN 'awaiting_acceptance'
    WHEN r.state = 'queued' THEN 'queued'
    WHEN r.state = 'cancel_requested' THEN 'canceling'
    WHEN r.state IN ('active', 'waiting') AND r.wait_reason = 'quota' THEN 'quota_exhausted'
    WHEN r.state IN ('active', 'waiting') AND EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.run_id = r.id AND o.org_id = t.org_id AND o.state IN ('unknown', 'unresolved')
    ) THEN 'reconciling'
    WHEN r.state IN ('active', 'waiting') THEN 'running'
    WHEN r.state = 'canceled' THEN 'run_canceled'
    WHEN r.state = 'failed' THEN 'failed'
    ELSE 'open'
  END AS display_state
FROM work.task t
LEFT JOIN work.run r
  ON r.id = t.latest_run_id AND r.org_id = t.org_id
LEFT JOIN LATERAL (
  SELECT ar.id
  FROM work.artifact ar
  WHERE ar.task_id = t.id
    AND ar.org_id = t.org_id
    AND ar.state = 'published'
  ORDER BY ar.updated_at DESC
  LIMIT 1
) a ON true
LEFT JOIN LATERAL (
  SELECT v.version_no, v.content_hash
  FROM work.artifact_version v
  WHERE v.artifact_id = a.id
    AND v.org_id = t.org_id
    AND v.state = 'published'
  ORDER BY v.version_no DESC
  LIMIT 1
) av ON true
WHERE t.deleted_at IS NULL;

-- 标题编辑：仅 owner；乐观并发 + 幂等；事件/审计只记字段名，不记标题正文。
CREATE FUNCTION work.update_task_title(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_title text
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  clean_title text := btrim(p_title);
  req_hash text;
  dedup_row work.submission_dedup%ROWTYPE;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'task.title', p_client_request_id);
  IF clean_title IS NULL OR char_length(clean_title) NOT BETWEEN 1 AND 80
     OR clean_title ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'title_invalid' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(p_task_id::text || ':' || clean_title);

  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'task.title' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN dedup_row.result_ref::bigint;
  END IF;

  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001',
      DETAIL = task_row.revision::text;
  END IF;
  IF task_row.state = 'archived' THEN
    RAISE EXCEPTION 'task_archived' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.task t
  SET title = clean_title, revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'task.title', p_client_request_id, req_hash, p_task_id, 'updated',
     (task_row.revision + 1)::text);
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'task.updated', jsonb_build_object('fields', jsonb_build_array('title'))
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.title_update', 'task', p_task_id::text,
    jsonb_build_object('fields', jsonb_build_array('title'))
  );
  RETURN task_row.revision + 1;
END;
$$;

-- 成果下载审计：只记版本与哈希；读取正文本身由 Content Store 受控入口完成。
CREATE FUNCTION work.record_artifact_export(
  p_org_id text,
  p_artifact_id uuid,
  p_version_no int,
  p_subject_id text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  version_row work.artifact_version%ROWTYPE;
  owner_id text;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  SELECT t.owner_subject_id INTO owner_id
  FROM work.artifact a
  JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id
    AND a.deleted_at IS NULL AND t.deleted_at IS NULL;
  IF owner_id IS NULL OR owner_id <> p_subject_id THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO version_row
  FROM work.artifact_version v
  WHERE v.artifact_id = p_artifact_id AND v.org_id = p_org_id AND v.version_no = p_version_no;
  IF NOT FOUND OR version_row.state <> 'published' THEN
    RAISE EXCEPTION 'version_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN work.append_audit(
    p_org_id, p_subject_id, 'artifact.exported', 'artifact', p_artifact_id::text,
    jsonb_build_object('version_no', p_version_no, 'content_hash', version_row.content_hash,
                       'bytes', version_row.bytes, 'media_type', version_row.media_type)
  );
END;
$$;

-- 任务删除核心：在任务行锁内校验 owner（用户删除）与 revision，要求静止；逻辑 tombstone +
-- 本任务输入/成果的正文引用进入 content_shred outbox（只含引用）。预算账本、审计与无正文事件保留。
-- 不授予任何应用角色。
CREATE FUNCTION work.delete_task_core(
  p_org_id text,
  p_task_id uuid,
  p_actor_subject_id text,
  p_required_owner text,
  p_expected_revision bigint,
  p_reason text,
  p_action text
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  refs jsonb;
  artifact_count int;
BEGIN
  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND
     OR (p_required_owner IS NOT NULL AND task_row.owner_subject_id <> p_required_owner) THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.deleted_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF p_expected_revision IS NOT NULL AND task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = task_row.revision::text;
  END IF;
  IF task_row.active_run_id IS NOT NULL OR work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  -- 只粉碎不再被其他存活输入/成果引用的正文对象（Content Store 若按内容去重，引用可能共享）。
  SELECT COALESCE(jsonb_agg(DISTINCT s.ref), '[]'::jsonb) INTO refs
  FROM (
    SELECT v.content_ref AS ref
    FROM work.artifact a
    JOIN work.artifact_version v ON v.artifact_id = a.id AND v.org_id = a.org_id
    WHERE a.task_id = p_task_id AND a.org_id = p_org_id
    UNION
    SELECT i.content_ref
    FROM work.input_object i
    WHERE i.id = task_row.input_id AND i.org_id = p_org_id AND i.task_id = p_task_id
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM work.input_object i2
    WHERE i2.org_id = p_org_id AND i2.content_ref = s.ref AND i2.deleted_at IS NULL
      AND i2.task_id IS DISTINCT FROM p_task_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM work.artifact_version v2
    JOIN work.artifact a2 ON a2.id = v2.artifact_id AND a2.org_id = v2.org_id
    WHERE v2.org_id = p_org_id AND v2.content_ref = s.ref AND a2.deleted_at IS NULL
      AND a2.task_id <> p_task_id
  );

  INSERT INTO work.artifact_tombstone (artifact_id, org_id)
  SELECT a.id, a.org_id FROM work.artifact a
  WHERE a.task_id = p_task_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
  ON CONFLICT (artifact_id) DO NOTHING;
  UPDATE work.artifact a
  SET state = 'deleted', deleted_at = now(), updated_at = now()
  WHERE a.task_id = p_task_id AND a.org_id = p_org_id AND a.deleted_at IS NULL;
  GET DIAGNOSTICS artifact_count = ROW_COUNT;

  UPDATE work.input_object i
  SET status = 'deleted', deleted_at = now()
  WHERE i.id = task_row.input_id AND i.org_id = p_org_id AND i.task_id = p_task_id
    AND i.deleted_at IS NULL;

  UPDATE work.submission_dedup d
  SET task_deleted = true
  WHERE d.org_id = p_org_id AND d.task_id = p_task_id;

  UPDATE work.task t
  SET deleted_at = now(), title = '[deleted]', revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;

  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (p_org_id, 'content', p_task_id, gen_random_uuid(),
          jsonb_build_object('kind', 'content_shred', 'task_id', p_task_id, 'content_refs', refs));

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, p_action, 'task', p_task_id::text,
    jsonb_build_object('reason', p_reason, 'artifacts', artifact_count,
                       'content_refs', jsonb_array_length(refs), 'owner_subject_id', task_row.owner_subject_id)
  );
  RETURN jsonb_array_length(refs);
END;
$$;

-- 用户删除自己的任务：owner 与 revision 在行锁内校验；原因只收枚举码。
CREATE FUNCTION work.delete_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_expected_revision bigint,
  p_reason text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  IF p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  RETURN work.delete_task_core(
    p_org_id, p_task_id, p_subject_id, p_subject_id, p_expected_revision,
    work.reason_code(p_reason), 'task.deleted');
END;
$$;

-- 运维代执行删除（法务/组织退出/离职清理）：必须带工单号；运维身份与会话绑定。
CREATE FUNCTION work.ops_delete_task(
  p_org_id text,
  p_task_id uuid,
  p_actor_subject_id text,
  p_ticket_ref text,
  p_reason text
) RETURNS int
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_ticket_ref IS NULL OR p_ticket_ref !~ '^[A-Z][A-Z0-9]+-[0-9]+$' OR length(btrim(coalesce(p_reason, ''))) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  RETURN work.delete_task_core(
    p_org_id, p_task_id, p_actor_subject_id, NULL, NULL,
    p_ticket_ref || ': ' || p_reason, 'task.deleted_by_ops'
  );
END;
$$;

-- 所有权转移（试点人工流程）：新 owner 必须是同组织在职、有 Work 席位、非 viewer 成员（锁定成员行）；
-- 任务须静止；不复制原 owner 的任何授权；原 owner 立即失去访问。
CREATE FUNCTION work.transfer_task_ownership(
  p_org_id text,
  p_task_id uuid,
  p_new_owner text,
  p_actor_subject_id text,
  p_ticket_ref text,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_ticket_ref IS NULL OR p_ticket_ref !~ '^[A-Z][A-Z0-9]+-[0-9]+$' OR length(btrim(coalesce(p_reason, ''))) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.owner_subject_id = p_new_owner THEN
    RETURN task_row.revision;
  END IF;
  PERFORM 1 FROM work.member m
  WHERE m.org_id = p_org_id AND m.subject_id = p_new_owner
    AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL OR work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.task t
  SET owner_subject_id = p_new_owner, revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'task.owner_changed', jsonb_build_object('fields', jsonb_build_array('owner'))
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'task.ownership_transferred', 'task', p_task_id::text,
    jsonb_build_object('from', task_row.owner_subject_id, 'to', p_new_owner,
                       'ticket_ref', p_ticket_ref, 'reason', p_reason)
  );
  RETURN task_row.revision + 1;
END;
$$;

-- 运维代取消在途 Run（D-07 A，2026-10-27 定案）：撤席位/停用后在途 Run 不自动取消，
-- 由值班按工单执行本命令。走与 request_cancel 相同的 cancel_signal outbox 与状态机，
-- 区别只是不要求调用者是任务 owner（owner 可能已失权）。调用方需 SET LOCAL app.org_id/app.subject_id。
CREATE FUNCTION work.ops_cancel_run(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text,
  p_ticket_ref text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  reason text;
BEGIN
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_ticket_ref IS NULL OR p_ticket_ref !~ '^[A-Z][A-Z0-9]+-[0-9]+$' OR length(btrim(coalesce(p_reason, ''))) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  reason := work.reason_code(p_reason);
  SELECT * INTO run_row
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.state IN ('succeeded', 'failed', 'canceled', 'cancel_requested') THEN
    RETURN;
  END IF;
  UPDATE work.run r
  SET state = 'cancel_requested',
      wait_reason = NULL,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  PERFORM work.append_task_event(
    p_org_id, run_row.task_id, 'run.cancel_requested',
    jsonb_build_object('run_id', p_run_id, 'reason', reason, 'requested_by', 'ops')
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', p_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'cancel_signal', 'run_id', p_run_id, 'reason', reason)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'run.cancel_requested_by_ops', 'run', p_run_id::text,
    jsonb_build_object('task_id', run_row.task_id, 'previous_state', run_row.state,
                       'ticket_ref', p_ticket_ref, 'reason', reason)
  );
END;
$$;

-- 生命周期事件由触发器统一补发，覆盖 finish_run/accept_task/cancel/对账等全部写路径，
-- 供 SSE 时间线与试点指标使用；payload 不含正文、标题或完成理由文本（terminal_reason 已是枚举码）。
CREATE FUNCTION work.emit_run_terminal_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('succeeded', 'failed', 'canceled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM work.append_task_event(
      NEW.org_id, NEW.task_id, 'run.' || NEW.state,
      jsonb_build_object('run_id', NEW.id, 'attempt_no', NEW.attempt_no, 'terminal_reason', NEW.terminal_reason)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_terminal_event
AFTER UPDATE OF state ON work.run
FOR EACH ROW EXECUTE FUNCTION work.emit_run_terminal_event();

CREATE FUNCTION work.emit_task_state_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'awaiting_acceptance' AND OLD.state IS DISTINCT FROM 'awaiting_acceptance' THEN
    PERFORM work.append_task_event(
      NEW.org_id, NEW.id, 'task.awaiting_acceptance',
      jsonb_build_object('latest_run_id', NEW.latest_run_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_state_event
AFTER UPDATE OF state ON work.task
FOR EACH ROW EXECUTE FUNCTION work.emit_task_state_event();

CREATE FUNCTION work.emit_acceptance_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.append_task_event(
    NEW.org_id, NEW.task_id, 'task.completed',
    jsonb_build_object(
      'acceptance_id', NEW.id,
      'basis', CASE WHEN NEW.artifact_id IS NULL THEN 'reason' ELSE 'version' END,
      'artifact_id', NEW.artifact_id,
      'version_no', NEW.version_no
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_event
AFTER INSERT ON work.acceptance
FOR EACH ROW EXECUTE FUNCTION work.emit_acceptance_event();

-- R0a 加固：覆盖基线 DDL 中的部分领域命令，并新增 API 侧重试/采纳/用户版本命令。
-- 原则：API 命令都校验会话主体 = owner、任务未删除、乐观并发与幂等；Worker 命令对活动重试幂等。

-- 基线 create_run 不校验 owner/删除，也不写 start_workflow；R0a 由 retry_task 取代。
DROP FUNCTION work.create_run(uuid, text, uuid, text, text);
DROP FUNCTION work.accept_task(uuid, text, uuid, int, text, bigint, text);

-- Run 终态：活动重试幂等（已是目标终态直接返回）；原因只收枚举码。
CREATE OR REPLACE FUNCTION work.finish_run(
  p_run_id uuid,
  p_org_id text,
  p_outcome text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_task_id uuid;
  reason text := work.reason_code(p_reason);
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'invalid_run_outcome' USING ERRCODE = '22023';
  END IF;
  SELECT r.task_id INTO v_task_id FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id FOR UPDATE;
  IF run_row.state = p_outcome THEN
    RETURN;
  END IF;
  -- 取消请求已落库后不得再以成功收尾（迟到结果只结算、不发布）。
  IF p_outcome = 'succeeded' AND run_row.state = 'cancel_requested' THEN
    RAISE EXCEPTION 'run_cancel_requested' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome = 'succeeded' AND work.task_has_blocking_operation(v_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_has_unresolved_operation' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run r
  SET state = p_outcome,
      wait_reason = NULL,
      terminal_reason = reason,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  UPDATE work.task t
  SET state = CASE WHEN p_outcome = 'succeeded' THEN 'awaiting_acceptance' ELSE t.state END,
      active_run_id = NULL,
      latest_run_id = p_run_id,
      revision = t.revision + 1,
      updated_at = now()
  WHERE t.id = v_task_id AND t.org_id = p_org_id;
END;
$$;

-- 领取 Run：queued → active 时 fence+1；活动重试（结果丢失）时 Run 已 active/waiting 则返回当前行，不再报 run_not_queued；
-- 启动前已 cancel_requested 或已终态则返回当前行，工作流据此直接收尾。
CREATE OR REPLACE FUNCTION work.acquire_run(
  p_run_id uuid,
  p_org_id text
) RETURNS work.run
LANGUAGE plpgsql AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_task_id uuid;
BEGIN
  SELECT r.task_id INTO v_task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t WHERE t.id = v_task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r WHERE r.id = p_run_id AND r.org_id = p_org_id FOR UPDATE;
  -- 启动前已取消或已终态：原样返回，由工作流收尾，不 bump fence。
  IF run_row.state IN ('cancel_requested', 'succeeded', 'failed', 'canceled') THEN
    RETURN run_row;
  END IF;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state IN ('active', 'waiting') THEN
    RETURN run_row;
  END IF;
  IF run_row.state <> 'queued' THEN
    RAISE EXCEPTION 'run_not_queued' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.run r
  SET state = 'active',
      fence = r.fence + 1,
      control_revision = r.control_revision + 1,
      updated_at = now()
  WHERE r.id = p_run_id AND r.org_id = p_org_id
  RETURNING * INTO run_row;
  RETURN run_row;
END;
$$;

-- 派发许可：同 consumer + 同 fence 的重放返回已有 dispatch_attempt_id；其余未赢得返回 NULL，
-- 调用方需重读 Operation 状态：authorized 且 Run 取消中 → cancel_operation + finish_run(canceled)；
-- 已由其他 consumer/fence 派发 → 不动（结果归属派发方，崩溃由对账扫描接管）。
CREATE OR REPLACE FUNCTION work.claim_dispatch(
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
  attempt uuid := gen_random_uuid();
BEGIN
  SELECT * INTO operation_row FROM work.operation o WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO run_row FROM work.run r WHERE r.id = operation_row.run_id AND r.org_id = p_org_id;
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run r WHERE r.id = operation_row.run_id AND r.org_id = p_org_id FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation o WHERE o.id = p_operation_id AND o.org_id = p_org_id FOR UPDATE;
  IF operation_row.state = 'dispatching'
     AND operation_row.consumer_id = p_consumer_id
     AND run_row.fence = p_fence THEN
    RETURN operation_row.dispatch_attempt_id;
  END IF;
  IF task_row.state <> 'open'
     OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active'
     OR run_row.fence <> p_fence
     OR operation_row.state <> 'authorized'
     OR operation_row.dispatch_attempt_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  UPDATE work.operation o
  SET state = 'dispatching',
      dispatch_attempt_id = attempt,
      consumer_id = p_consumer_id,
      revision = o.revision + 1,
      updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  RETURN attempt;
END;
$$;

-- 预留：同 Operation 已有同额 held/unknown 预留时返回该预留（活动重试幂等）。
CREATE OR REPLACE FUNCTION work.reserve_quota(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_operation_id uuid,
  p_amount_tokens bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  account work.quota_account%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  existing work.quota_reservation%ROWTYPE;
  reservation_id uuid := gen_random_uuid();
  next_seq int;
  run_cumulative_tokens bigint;
BEGIN
  IF p_amount_tokens IS NULL OR p_amount_tokens <= 0 THEN
    RAISE EXCEPTION 'invalid_reservation_amount' USING ERRCODE = '22023';
  END IF;
  -- Run 级硬上限对所有组织生效（D-08）。
  SELECT * INTO policy_row FROM work.org_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO existing
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id AND br.state IN ('held', 'unknown');
  IF FOUND THEN
    IF existing.amount_tokens = p_amount_tokens THEN
      RETURN existing.id;
    END IF;
    RAISE EXCEPTION 'operation_has_active_reservation' USING ERRCODE = 'P0001';
  END IF;
  -- Run 级累计检查：已结算 + 已预留（held/unknown）不得超过 run_cap_tokens（D-08）。
  SELECT COALESCE(SUM(br.settled_tokens), 0) + COALESCE(SUM(
    CASE WHEN br.state IN ('held', 'unknown') THEN br.amount_tokens ELSE 0 END
  ), 0) INTO run_cumulative_tokens
  FROM work.quota_reservation br
  JOIN work.operation o ON o.id = br.operation_id
  WHERE o.run_id = operation_row.run_id AND o.org_id = p_org_id;
  IF run_cumulative_tokens + p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state NOT IN ('prepared', 'waiting_approval', 'authorized') THEN
    RAISE EXCEPTION 'operation_not_reservable' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(br.reservation_seq), 0) + 1 INTO next_seq
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id;
  SELECT * INTO account
  FROM work.quota_account ba
  WHERE ba.org_id = p_org_id AND ba.account_key = p_account_key AND ba.period_id = p_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- soft：客户自带账号，周期量只统计；hard：演示组织等平台承担成本的组织，超限即拒。
  IF account.enforcement = 'hard'
     AND account.limit_tokens - account.settled_tokens - account.reserved_tokens < p_amount_tokens THEN
    RAISE EXCEPTION 'quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account ba
  SET reserved_tokens = ba.reserved_tokens + p_amount_tokens,
      version = ba.version + 1,
      updated_at = now()
  WHERE ba.id = account.id;
  INSERT INTO work.quota_reservation
    (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
  VALUES
    (reservation_id, p_org_id, account.id, p_operation_id, next_seq, p_amount_tokens, 'held');
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens)
  VALUES
    (p_org_id, account.id, reservation_id, p_operation_id, 'reserve', p_amount_tokens);
  RETURN reservation_id;
END;
$$;

-- 用户重试：仅 owner、未删除、最新 Run 为 failed/canceled、任务静止；沿用任务快照；
-- 写 start_workflow outbox；幂等键返回同一 Run。
CREATE FUNCTION work.retry_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_workflow_id text,
  p_runtime_version text
) RETURNS TABLE (run_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  latest_state text;
  req_hash text;
  next_attempt int;
  new_run_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'run.retry', p_client_request_id);
  IF p_workflow_id IS NULL OR p_workflow_id = '' OR p_runtime_version IS NULL OR p_runtime_version = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(p_task_id::text || ':' || p_expected_revision::text);
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'run.retry' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY SELECT dedup_row.result_ref::uuid, (p_expected_revision + 1);
    RETURN;
  END IF;

  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.member m
  WHERE m.org_id = p_org_id AND m.subject_id = p_subject_id
    AND m.status = 'active' AND m.work_seat AND m.role <> 'viewer'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = task_row.revision::text;
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'task_has_active_run' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.state INTO latest_state FROM work.run r
  WHERE r.id = task_row.latest_run_id AND r.org_id = p_org_id
  FOR UPDATE;
  IF task_row.state <> 'open' OR latest_state IS NULL OR latest_state NOT IN ('failed', 'canceled') THEN
    RAISE EXCEPTION 'task_not_runnable' USING ERRCODE = 'P0001';
  END IF;
  IF work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(r.attempt_no), 0) + 1 INTO next_attempt
  FROM work.run r WHERE r.task_id = p_task_id AND r.org_id = p_org_id;
  INSERT INTO work.run
    (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
  VALUES
    (new_run_id, p_org_id, p_task_id, next_attempt, 'queued', task_row.snapshot_id, p_workflow_id, p_runtime_version);
  UPDATE work.task t
  SET active_run_id = new_run_id, latest_run_id = new_run_id,
      revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'run.retry', p_client_request_id, req_hash, p_task_id, 'accepted', new_run_id::text);
  PERFORM work.append_task_event(
    p_org_id, p_task_id, 'run.queued',
    jsonb_build_object('run_id', new_run_id, 'attempt_no', next_attempt)
  );
  INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES (
    p_org_id, 'run', new_run_id, gen_random_uuid(),
    jsonb_build_object('kind', 'start_workflow', 'run_id', new_run_id, 'workflow_id', p_workflow_id)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'run.retry', 'task', p_task_id::text,
    jsonb_build_object('run_id', new_run_id, 'attempt_no', next_attempt)
  );
  RETURN QUERY SELECT new_run_id, task_row.revision + 1;
END;
$$;

-- 用户采纳：仅 owner、未删除、状态 awaiting_acceptance、静止；固定版本或完成理由；
-- revision 冲突返回 version_conflict（DETAIL=当前 revision）；幂等键返回同一采纳。
CREATE FUNCTION work.accept_task(
  p_org_id text,
  p_task_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_expected_revision bigint,
  p_artifact_id uuid,
  p_version_no int,
  p_completion_reason text
) RETURNS TABLE (acceptance_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  req_hash text;
  new_acceptance_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'task.accept', p_client_request_id);
  IF (p_artifact_id IS NULL) = (p_completion_reason IS NULL)
     OR (p_artifact_id IS NOT NULL AND p_version_no IS NULL)
     OR (p_completion_reason IS NOT NULL AND char_length(btrim(p_completion_reason)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'acceptance_requires_artifact_or_reason' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(concat_ws(':', p_task_id, p_expected_revision, p_artifact_id, p_version_no,
                                         work.sha256_text(COALESCE(p_completion_reason, ''))));
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'task.accept' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY SELECT dedup_row.result_ref::uuid, (p_expected_revision + 1);
    RETURN;
  END IF;

  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = p_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = task_row.revision::text;
  END IF;
  IF task_row.state <> 'awaiting_acceptance' THEN
    RAISE EXCEPTION 'task_not_acceptable' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL OR work.task_has_blocking_operation(p_task_id, p_org_id) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;
  IF p_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM work.artifact a
    JOIN work.artifact_version v ON v.artifact_id = a.id AND v.org_id = a.org_id
    WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.task_id = p_task_id
      AND a.deleted_at IS NULL AND v.version_no = p_version_no
      AND a.state = 'published' AND v.state = 'published'
  ) THEN
    RAISE EXCEPTION 'artifact_not_published' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.task t
  SET state = 'completed', revision = t.revision + 1, updated_at = now()
  WHERE t.id = p_task_id AND t.org_id = p_org_id;
  INSERT INTO work.acceptance
    (id, org_id, task_id, artifact_id, version_no, actor_subject_id, task_revision, completion_reason)
  VALUES
    (new_acceptance_id, p_org_id, p_task_id, p_artifact_id, p_version_no, p_subject_id,
     p_expected_revision + 1, btrim(p_completion_reason));
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'task.accept', p_client_request_id, req_hash, p_task_id, 'completed',
     new_acceptance_id::text);
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'task.accept', 'task', p_task_id::text,
    jsonb_build_object('acceptance_id', new_acceptance_id,
                       'basis', CASE WHEN p_artifact_id IS NULL THEN 'reason' ELSE 'version' END,
                       'artifact_id', p_artifact_id, 'version_no', p_version_no)
  );
  RETURN QUERY SELECT new_acceptance_id, task_row.revision + 1;
END;
$$;

-- 用户编辑成果另存新版本：仅 owner、未删除、任务静止且未完成（open/awaiting_acceptance）；
-- base_version_no 必须等于当前最新已发布版本（否则 version_conflict，DETAIL=最新版本号）；
-- 版本不可变、来源标为 user；任务 revision +1，使旧视图的采纳失效。
CREATE FUNCTION work.create_user_artifact_version(
  p_org_id text,
  p_artifact_id uuid,
  p_subject_id text,
  p_client_request_id text,
  p_base_version_no int,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_media_type text
) RETURNS TABLE (version_no int, task_revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  task_row work.task%ROWTYPE;
  artifact_row work.artifact%ROWTYPE;
  dedup_row work.submission_dedup%ROWTYPE;
  v_task_id uuid;
  latest_version int;
  req_hash text;
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_subject_id, 'artifact.version', p_client_request_id);
  IF p_base_version_no IS NULL OR p_base_version_no < 1
     OR p_content_ref IS NULL OR p_content_ref = ''
     OR p_content_hash IS NULL OR p_content_hash = ''
     OR p_bytes IS NULL OR p_bytes <= 0
     OR p_media_type IS NULL OR p_media_type = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  req_hash := work.sha256_text(concat_ws(':', p_artifact_id, p_base_version_no, p_content_hash));
  SELECT * INTO dedup_row
  FROM work.submission_dedup d
  WHERE d.org_id = p_org_id AND d.subject_id = p_subject_id
    AND d.operation_type = 'artifact.version' AND d.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF dedup_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF dedup_row.task_deleted THEN
      RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY
      SELECT dedup_row.result_ref::int, t.revision
      FROM work.task t WHERE t.id = dedup_row.task_id AND t.org_id = p_org_id;
    RETURN;
  END IF;

  SELECT a.task_id INTO v_task_id FROM work.artifact a WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE;
  SELECT * INTO artifact_row FROM work.artifact a
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
  FOR UPDATE;
  IF task_row.id IS NULL OR artifact_row.id IS NULL OR task_row.owner_subject_id <> p_subject_id THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF task_row.state NOT IN ('open', 'awaiting_acceptance') THEN
    RAISE EXCEPTION 'artifact_read_only' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;
  -- UI shows run_canceled/failed artifacts as read-only: a terminal, unsuccessful
  -- latest run freezes editing until a later run succeeds.
  IF task_row.latest_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM work.run r
    WHERE r.id = task_row.latest_run_id AND r.org_id = p_org_id
      AND r.state IN ('failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'artifact_read_only' USING ERRCODE = 'P0001';
  END IF;
  SELECT MAX(v.version_no) INTO latest_version
  FROM work.artifact_version v
  WHERE v.artifact_id = p_artifact_id AND v.org_id = p_org_id AND v.state = 'published';
  IF latest_version IS DISTINCT FROM p_base_version_no THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001', DETAIL = COALESCE(latest_version, 0)::text;
  END IF;
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance)
  VALUES
    (p_artifact_id, p_org_id, latest_version + 1, p_content_ref, p_content_hash, p_bytes, p_media_type,
     'staged', jsonb_build_object('source', 'user', 'base_version_no', p_base_version_no));
  UPDATE work.artifact_version v
  SET state = 'published', published_at = now()
  WHERE v.artifact_id = p_artifact_id AND v.org_id = p_org_id AND v.version_no = latest_version + 1;
  UPDATE work.artifact a
  SET revision = a.revision + 1, updated_at = now()
  WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  UPDATE work.task t
  SET revision = t.revision + 1, updated_at = now()
  WHERE t.id = v_task_id AND t.org_id = p_org_id;
  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id, result_state, result_ref)
  VALUES
    (p_org_id, p_subject_id, 'artifact.version', p_client_request_id, req_hash, v_task_id, 'published',
     (latest_version + 1)::text);
  PERFORM work.append_task_event(
    p_org_id, v_task_id, 'artifact.published',
    jsonb_build_object('artifact_id', p_artifact_id, 'version_no', latest_version + 1, 'source', 'user',
                       'content_hash', p_content_hash, 'bytes', p_bytes, 'media_type', p_media_type)
  );
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'artifact.version_create', 'artifact', p_artifact_id::text,
    jsonb_build_object('task_id', v_task_id, 'version_no', latest_version + 1, 'base_version_no', p_base_version_no)
  );
  RETURN QUERY SELECT latest_version + 1, task_row.revision + 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 管理只读（U2 方案 B）与 Host 目录投影写入（ADR-0021）
--
-- 方案 B 的前提是：R0a 管理读接口自己提供 role/revision/token 配额与异步导出作业，
-- P1-A 只负责读权限与主组织上下文。因此这些数据必须在 work schema 内有真实落点，
-- 否则 OpenAPI 承诺的作业生命周期与席位/预算字段只能由服务端伪造。
--
-- ADR-0021 的落地：work.org / work.member 是 Host IdentityDirectory/Entitlement 的
-- 投影，只有 work_directory 角色能通过 sync_* 命令写入；应用与 worker 角色不能直接 DML，
-- 也不能读 work.audit_export（只能经领域函数），避免跨成员泄露导出作业元数据。
-- ---------------------------------------------------------------------------

CREATE TABLE work.audit_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  requested_by text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'json')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'expired', 'failed')),
  content_ref text,
  content_hash text,
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  error_code text,
  lease_owner text,
  lease_until timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  download_token_hash text,
  download_expires_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, client_request_id),
  CHECK (range_from < range_to),
  CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- ready 作业必须有内容引用与有效期；未 ready 不得留下引用。
  CHECK ((status = 'ready') = (content_ref IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (downloaded_at IS NULL OR download_token_hash IS NOT NULL)
);

ALTER TABLE work.org ADD COLUMN name text;
CREATE INDEX work_audit_export_queued
  ON work.audit_export(org_id, created_at)
  WHERE status = 'queued';
CREATE INDEX work_audit_export_expiry ON work.audit_export(expires_at)
  WHERE status = 'ready';

-- ---------------------------------------------------------------------------
-- Host 目录投影写入（IdentityDirectory / Entitlement 适配器唯一入口）
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.sync_org_projection(
  p_org_id text,
  p_name text,
  p_status text,
  p_execution_enabled boolean,
  p_home_region text,
  p_revision bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  current_revision bigint;
  applied_revision bigint;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) = 0 OR char_length(p_name) > 128 THEN
    RAISE EXCEPTION 'invalid_request:org_name' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'invalid_request:org_status' USING ERRCODE = '22023';
  END IF;
  IF p_execution_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_enabled' USING ERRCODE = '22023';
  END IF;
  IF p_home_region IS NULL OR p_home_region !~ '^[a-z0-9-]{3,64}$' THEN
    RAISE EXCEPTION 'invalid_request:home_region' USING ERRCODE = '22023';
  END IF;
  IF p_revision IS NULL OR p_revision <= 0 THEN
    RAISE EXCEPTION 'invalid_request:revision' USING ERRCODE = '22023';
  END IF;

  SELECT o.revision INTO current_revision FROM work.org o WHERE o.id = p_org_id;
  IF current_revision IS NOT NULL AND p_revision <= current_revision THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- 只读校验挡不住并发写：两个同步可能同时读到旧修订号。
  -- 单调性由 DO UPDATE 的 WHERE 保证，读校验只用于给出更早的错误。
  INSERT INTO work.org (id, name, status, execution_enabled, home_region, revision)
  VALUES (p_org_id, btrim(p_name), p_status, p_execution_enabled, p_home_region, p_revision)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        status = EXCLUDED.status,
        execution_enabled = EXCLUDED.execution_enabled,
        home_region = EXCLUDED.home_region,
        revision = EXCLUDED.revision,
        updated_at = now()
    WHERE work.org.revision < EXCLUDED.revision
  RETURNING work.org.revision INTO applied_revision;
  IF applied_revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- operator_suspended 只由运维停用路径设置，目录同步不得覆盖。
  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.org_synced', 'org', p_org_id,
    jsonb_build_object('revision', p_revision, 'status', p_status,
                       'execution_enabled', p_execution_enabled)
  );
  RETURN p_revision;
END;
$$;

CREATE FUNCTION work.sync_member_projection(
  p_org_id text,
  p_subject_id text,
  p_status text,
  p_role text,
  p_work_seat boolean,
  p_revision bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  member_row work.member%ROWTYPE;
  member_id uuid;
  entitlement_lost boolean := false;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_subject_id IS NULL OR p_subject_id !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid_request:subject_id' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('invited', 'active', 'suspended', 'left') THEN
    RAISE EXCEPTION 'invalid_request:member_status' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'viewer') THEN
    RAISE EXCEPTION 'invalid_request:member_role' USING ERRCODE = '22023';
  END IF;
  IF p_work_seat IS NULL THEN
    RAISE EXCEPTION 'invalid_request:work_seat' USING ERRCODE = '22023';
  END IF;
  IF p_revision IS NULL OR p_revision <= 0 THEN
    RAISE EXCEPTION 'invalid_request:revision' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO member_row
  FROM work.member m
  WHERE m.org_id = p_org_id AND m.subject_id = p_subject_id
  FOR UPDATE;
  IF FOUND THEN
    IF p_revision <= member_row.revision THEN
      RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
    END IF;
    entitlement_lost := (member_row.work_seat AND NOT p_work_seat)
      OR (member_row.status = 'active' AND p_status IN ('suspended', 'left'));
  END IF;

  -- 行锁只覆盖已存在的成员：新成员的两个并发写由 DO UPDATE 的修订号守卫裁决，
  -- 否则低修订号会在读-写窗口里覆盖高修订号（投影必须单调）。
  INSERT INTO work.member
    (org_id, subject_id, status, role, work_seat, revision)
  VALUES
    (p_org_id, p_subject_id, p_status, p_role, p_work_seat, p_revision)
  ON CONFLICT (org_id, subject_id) DO UPDATE
    SET status = EXCLUDED.status,
        role = EXCLUDED.role,
        work_seat = EXCLUDED.work_seat,
        revision = EXCLUDED.revision,
        updated_at = now()
    WHERE work.member.revision < EXCLUDED.revision
  RETURNING id INTO member_id;
  IF member_id IS NULL THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- 收窄只落投影；在途 Run 的停止走 sanctioned request_cancel（D3），
  -- 投影写入不直接杀 Run，避免目录同步与编排抢同一状态机。
  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.member_synced', 'member', p_subject_id,
    jsonb_build_object(
      'revision', p_revision,
      'status', p_status,
      'role', p_role,
      'work_seat', p_work_seat,
      'entitlement_lost', entitlement_lost
    )
  );
  RETURN member_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 管理只读聚合（token 配额、席位、策略）
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.assert_org_admin(p_org_id text, p_subject_id text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id
      AND m.subject_id = p_subject_id
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION work.admin_overview(
  p_org_id text,
  p_subject_id text,
  p_account_key text DEFAULT 'default',
  p_period_id text DEFAULT to_char(date_trunc('month', now()), 'YYYY-MM')
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  org_row work.org%ROWTYPE;
  account work.quota_account%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  seat_total bigint;
  seat_active bigint;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);

  SELECT * INTO org_row FROM work.org o WHERE o.id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) FILTER (WHERE m.status <> 'left'),
         count(*) FILTER (WHERE m.status = 'active' AND m.work_seat)
    INTO seat_total, seat_active
  FROM work.member m
  WHERE m.org_id = p_org_id;

  SELECT * INTO account
  FROM work.quota_account b
  WHERE b.org_id = p_org_id AND b.account_key = p_account_key AND b.period_id = p_period_id;

  SELECT * INTO policy_row FROM work.org_policy p WHERE p.org_id = p_org_id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'admin.overview_read', 'org', p_org_id,
    jsonb_build_object('account_key', p_account_key, 'period_id', p_period_id)
  );

  RETURN jsonb_build_object(
    'org_id', org_row.id,
    'name', org_row.name,
    'status', org_row.status,
    'execution_enabled', org_row.execution_enabled AND NOT org_row.operator_suspended,
    'seats', jsonb_build_object('total', seat_total, 'active', seat_active),
    'quota', jsonb_build_object(
      'limit_tokens', COALESCE(account.limit_tokens, 0),
      'reserved_tokens', COALESCE(account.reserved_tokens, 0),
      'settled_tokens', COALESCE(account.settled_tokens, 0),
      'enforcement', COALESCE(account.enforcement, 'soft')
    ),
    'quota_period_id', p_period_id,
    'run_cap_tokens', COALESCE(policy_row.run_cap_tokens, 0),
    'org_revision', org_row.revision,
    'audit_retention_days',
      COALESCE(NULLIF(policy_row.policy->>'audit_retention_days', '')::int, 365)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- D-08 大模型接入配置与用量：写权限只给组织 owner；配置与凭证按组织隔离。
-- 每组织每供应商只允许一条 active 凭证（函数内 EXISTS 检查之外的数据库兜底）。
CREATE UNIQUE INDEX IF NOT EXISTS work_provider_credential_one_active
  ON work.provider_credential(org_id, provider) WHERE state = 'active';
-- 托管 Key 的明文没有任何读取入口：接口只回指纹，网关经 resolve_* 在调用瞬间取密文。
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.assert_org_owner(p_org_id text, p_subject_id text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id
      AND m.subject_id = p_subject_id
      AND m.status = 'active'
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner_access_denied' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION work.create_provider_credential(
  p_org_id text,
  p_subject_id text,
  p_provider text,
  p_mode text,
  p_role_ref text,
  p_secret_ciphertext bytea,
  p_wrapped_dek bytea,
  p_kms_key_ref text,
  p_secret_fingerprint text
) RETURNS TABLE (credential_id uuid, key_version int)
LANGUAGE plpgsql AS $$
DECLARE
  new_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_secret_fingerprint IS NULL OR length(btrim(p_secret_fingerprint)) NOT BETWEEN 8 AND 64 THEN
    RAISE EXCEPTION 'invalid_request:fingerprint' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'managed_key' THEN
    IF p_secret_ciphertext IS NULL OR p_role_ref IS NOT NULL
       OR (p_wrapped_dek IS NULL) <> (p_kms_key_ref IS NULL)
       OR (p_kms_key_ref IS NOT NULL AND length(btrim(p_kms_key_ref)) = 0) THEN
      RAISE EXCEPTION 'invalid_request:credential' USING ERRCODE = '22023';
    END IF;
  ELSIF p_mode = 'sts_role' THEN
    IF p_role_ref IS NULL OR length(btrim(p_role_ref)) = 0
       OR p_secret_ciphertext IS NOT NULL OR p_wrapped_dek IS NOT NULL OR p_kms_key_ref IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_request:credential' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_request:credential_mode' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.provider_credential pc
    WHERE pc.org_id = p_org_id AND pc.provider = p_provider AND pc.state = 'active'
  ) THEN
    RAISE EXCEPTION 'provider_credential_exists' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO work.provider_credential
    (id, org_id, provider, mode, role_ref, secret_ciphertext, wrapped_dek, kms_key_ref,
     secret_fingerprint, created_by)
  VALUES
    (new_id, p_org_id, p_provider, p_mode, p_role_ref, p_secret_ciphertext, p_wrapped_dek,
     p_kms_key_ref, btrim(p_secret_fingerprint), p_subject_id);
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.credential_created', 'provider_credential', new_id::text,
    jsonb_build_object(
      'provider', p_provider, 'mode', p_mode,
      'fingerprint', btrim(p_secret_fingerprint), 'key_version', 1
    )
  );
  RETURN QUERY SELECT new_id, 1;
END;
$$;

CREATE FUNCTION work.rotate_provider_credential(
  p_org_id text,
  p_subject_id text,
  p_credential_id uuid,
  p_secret_ciphertext bytea,
  p_wrapped_dek bytea,
  p_kms_key_ref text,
  p_secret_fingerprint text
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  credential work.provider_credential%ROWTYPE;
  new_version int;
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  SELECT * INTO credential FROM work.provider_credential
    WHERE id = p_credential_id AND org_id = p_org_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state <> 'active' THEN
    RAISE EXCEPTION 'provider_credential_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF credential.mode <> 'managed_key' THEN
    RAISE EXCEPTION 'invalid_request:credential_mode' USING ERRCODE = '22023';
  END IF;
  IF p_secret_ciphertext IS NULL OR p_secret_fingerprint IS NULL
     OR length(btrim(p_secret_fingerprint)) NOT BETWEEN 8 AND 64
     OR (p_wrapped_dek IS NULL) <> (p_kms_key_ref IS NULL)
     OR (p_kms_key_ref IS NOT NULL AND length(btrim(p_kms_key_ref)) = 0) THEN
    RAISE EXCEPTION 'invalid_request:credential' USING ERRCODE = '22023';
  END IF;
  new_version := credential.key_version + 1;
  UPDATE work.provider_credential
  SET secret_ciphertext = p_secret_ciphertext,
      wrapped_dek = p_wrapped_dek,
      kms_key_ref = p_kms_key_ref,
      secret_fingerprint = btrim(p_secret_fingerprint),
      key_version = new_version,
      rotated_at = now()
  WHERE id = credential.id;
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.credential_rotated', 'provider_credential', credential.id::text,
    jsonb_build_object('provider', credential.provider, 'key_version', new_version,
                       'fingerprint', btrim(p_secret_fingerprint))
  );
  RETURN new_version;
END;
$$;

CREATE FUNCTION work.revoke_provider_credential(
  p_org_id text,
  p_subject_id text,
  p_credential_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  credential work.provider_credential%ROWTYPE;
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO credential FROM work.provider_credential
    WHERE id = p_credential_id AND org_id = p_org_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state = 'revoked' THEN
    RETURN;
  END IF;
  UPDATE work.provider_credential
  SET state = 'revoked', revoked_at = now(), revoked_by = p_subject_id
  WHERE id = credential.id;
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.credential_revoked', 'provider_credential', credential.id::text,
    jsonb_build_object('provider', credential.provider, 'reason', p_reason)
  );
END;
$$;

CREATE FUNCTION work.set_provider_config(
  p_org_id text,
  p_subject_id text,
  p_provider text,
  p_model text,
  p_region text,
  p_endpoint text,
  p_credential_mode text,
  p_credential_id uuid,
  p_expected_revision bigint DEFAULT NULL
) RETURNS TABLE (config_id uuid, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  credential work.provider_credential%ROWTYPE;
  current_revision bigint;
  next_revision bigint;
  new_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120
     OR p_region IS NULL OR length(btrim(p_region)) = 0
     OR p_endpoint IS NULL OR p_endpoint !~ '^https://' THEN
    RAISE EXCEPTION 'invalid_request:provider_config' USING ERRCODE = '22023';
  END IF;
  IF p_credential_mode NOT IN ('sts_role', 'managed_key') THEN
    RAISE EXCEPTION 'invalid_request:credential_mode' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO credential FROM work.provider_credential
    WHERE id = p_credential_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state <> 'active' THEN
    RAISE EXCEPTION 'provider_credential_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF credential.provider <> p_provider OR credential.mode <> p_credential_mode THEN
    RAISE EXCEPTION 'provider_credential_mismatch' USING ERRCODE = '22023';
  END IF;
  -- 组织行锁序列化配置写入，保证同一时刻只有一条 active。
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR UPDATE;
  SELECT c.revision INTO current_revision
  FROM work.provider_access_config c
  WHERE c.org_id = p_org_id AND c.state = 'active';
  IF p_expected_revision IS NOT NULL
     AND p_expected_revision <> COALESCE(current_revision, 0) THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE work.provider_access_config
  SET state = 'superseded', superseded_at = now()
  WHERE org_id = p_org_id AND state = 'active';
  SELECT COALESCE(MAX(c.revision), 0) + 1 INTO next_revision
  FROM work.provider_access_config c WHERE c.org_id = p_org_id;
  INSERT INTO work.provider_access_config
    (id, org_id, revision, provider, model, region, endpoint, credential_mode, credential_id, created_by)
  VALUES
    (new_id, p_org_id, next_revision, p_provider, btrim(p_model), btrim(p_region),
     btrim(p_endpoint), p_credential_mode, p_credential_id, p_subject_id);
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.config_changed', 'provider_access_config', new_id::text,
    jsonb_build_object('provider', p_provider, 'model', btrim(p_model), 'region', btrim(p_region),
                       'credential_mode', p_credential_mode, 'revision', next_revision)
  );
  RETURN QUERY SELECT new_id, next_revision;
END;
$$;

CREATE FUNCTION work.revoke_provider_config(
  p_org_id text,
  p_subject_id text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  config work.provider_access_config%ROWTYPE;
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO config FROM work.provider_access_config
    WHERE org_id = p_org_id AND state = 'active'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE work.provider_access_config
  SET state = 'revoked', revoked_at = now()
  WHERE id = config.id;
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.config_revoked', 'provider_access_config', config.id::text,
    jsonb_build_object('provider', config.provider, 'model', config.model, 'reason', p_reason)
  );
END;
$$;

-- 管理台读取接入配置（脱敏）：owner 可查看本组织 active 配置，不返回密文字段（P1-4）。
CREATE FUNCTION work.get_provider_config(
  p_org_id text,
  p_subject_id text
) RETURNS TABLE (
  config_id uuid,
  revision bigint,
  provider text,
  model text,
  region text,
  endpoint text,
  credential_mode text,
  credential_id uuid,
  credential_fingerprint text,
  state text,
  created_by text,
  created_at timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  RETURN QUERY SELECT c.id, c.revision, c.provider, c.model, c.region, c.endpoint,
                      c.credential_mode, c.credential_id, pc.secret_fingerprint,
                      c.state, c.created_by, c.created_at
  FROM work.provider_access_config c
  JOIN work.provider_credential pc ON pc.id = c.credential_id
  WHERE c.org_id = p_org_id AND c.state = 'active';
END;
$$;

-- 管理台读取凭证元数据（脱敏）：owner 可读 key_version/时间戳，不返回密文。
CREATE FUNCTION work.get_provider_credential_view(
  p_org_id text,
  p_subject_id text,
  p_credential_id uuid
) RETURNS TABLE (
  credential_id uuid,
  provider text,
  mode text,
  fingerprint text,
  key_version int,
  state text,
  created_at timestamptz,
  rotated_at timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  RETURN QUERY
  SELECT pc.id, pc.provider, pc.mode, pc.secret_fingerprint, pc.key_version,
         pc.state, pc.created_at, pc.rotated_at
  FROM work.provider_credential pc
  WHERE pc.org_id = p_org_id AND pc.id = p_credential_id;
END;
$$;

-- 网关/运行时取凭证的唯一入口：只能取本组织的 active 配置与 active 凭证。
-- wrapped_dek/kms_key_ref 为 NULL 表示静态单层加密；两者都有值表示预留的 KMS 信封。
CREATE FUNCTION work.resolve_provider_context(p_org_id text)
RETURNS TABLE (
  config_id uuid,
  provider text,
  model text,
  region text,
  endpoint text,
  credential_mode text,
  role_ref text,
  secret_ciphertext bytea,
  wrapped_dek bytea,
  kms_key_ref text
)
LANGUAGE plpgsql AS $$
DECLARE
  config work.provider_access_config%ROWTYPE;
  credential work.provider_credential%ROWTYPE;
BEGIN
  SELECT * INTO config FROM work.provider_access_config c
    WHERE c.org_id = p_org_id AND c.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider_not_configured' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO credential FROM work.provider_credential pc
    WHERE pc.id = config.credential_id AND pc.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider_not_configured' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state <> 'active' THEN
    RAISE EXCEPTION 'provider_credential_revoked' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT config.id, config.provider, config.model, config.region, config.endpoint,
                      config.credential_mode, credential.role_ref, credential.secret_ciphertext,
                      credential.wrapped_dek, credential.kms_key_ref;
END;
$$;

CREATE FUNCTION work.record_usage(
  p_org_id text,
  p_subject_id text,
  p_operation_id uuid,
  p_provider text,
  p_model text,
  p_usage_date date,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_runs int DEFAULT 1
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) = 0 THEN
    RAISE EXCEPTION 'invalid_request:model' USING ERRCODE = '22023';
  END IF;
  IF p_usage_date IS NULL OR p_input_tokens < 0 OR p_output_tokens < 0
     OR p_cached_input_tokens < 0 OR p_runs < 0 THEN
    RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
  END IF;
  -- 幂等检查：同一 operation 的用量只记录一次（P1-3）。
  IF EXISTS (
    SELECT 1 FROM work.quota_entry qe
    WHERE qe.operation_id = p_operation_id AND qe.org_id = p_org_id
      AND qe.kind = 'settle' AND qe.settlement_revision = 1
  ) THEN
    RETURN;
  END IF;
  INSERT INTO work.usage_daily AS u
    (org_id, subject_id, provider, model, usage_date,
     input_tokens, output_tokens, cached_input_tokens, run_count, revision)
  VALUES
    (p_org_id, p_subject_id, p_provider, btrim(p_model), p_usage_date,
     p_input_tokens, p_output_tokens, p_cached_input_tokens, p_runs, 1)
  ON CONFLICT (org_id, subject_id, provider, model, usage_date) DO UPDATE
  SET input_tokens = u.input_tokens + EXCLUDED.input_tokens,
      output_tokens = u.output_tokens + EXCLUDED.output_tokens,
      cached_input_tokens = u.cached_input_tokens + EXCLUDED.cached_input_tokens,
      run_count = u.run_count + EXCLUDED.run_count,
      revision = u.revision + 1,
      updated_at = now();
END;
$$;

-- C 端只读本人用量：会话主体必须与查询主体一致，跨用户读取直接拒绝。
CREATE FUNCTION work.get_user_usage(
  p_org_id text,
  p_subject_id text,
  p_from date,
  p_to date
) RETURNS TABLE (
  provider text,
  model text,
  usage_date date,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  run_count int
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  IF p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid_request:usage_range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT u.provider, u.model, u.usage_date, u.input_tokens, u.output_tokens,
           u.cached_input_tokens, u.run_count
    FROM work.usage_daily u
    WHERE u.org_id = p_org_id AND u.subject_id = p_subject_id
      AND u.usage_date BETWEEN p_from AND p_to
    ORDER BY u.usage_date, u.provider, u.model;
END;
$$;

-- 组织按模型汇总：只对 owner/admin 开放。
CREATE FUNCTION work.get_org_usage_by_model(
  p_org_id text,
  p_subject_id text,
  p_from date,
  p_to date
) RETURNS TABLE (
  provider text,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  run_count bigint
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid_request:usage_range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT u.provider, u.model,
           sum(u.input_tokens)::bigint, sum(u.output_tokens)::bigint,
           sum(u.cached_input_tokens)::bigint, sum(u.run_count)::bigint
    FROM work.usage_daily u
    WHERE u.org_id = p_org_id AND u.usage_date BETWEEN p_from AND p_to
    GROUP BY u.provider, u.model
    ORDER BY u.provider, u.model;
END;
$$;

CREATE FUNCTION work.list_seats(
  p_org_id text,
  p_subject_id text,
  p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS TABLE (
  subject_id text,
  role text,
  work_seat boolean,
  status text,
  revision bigint
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND p_cursor = '' THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'admin.seats_read', 'org', p_org_id,
    jsonb_build_object('limit', p_limit, 'has_cursor', p_cursor IS NOT NULL)
  );

  RETURN QUERY
  SELECT m.subject_id, m.role, m.work_seat, m.status, m.revision
  FROM work.member m
  WHERE m.org_id = p_org_id
    AND m.status <> 'left'
    AND (p_cursor IS NULL OR m.subject_id > p_cursor)
  ORDER BY m.subject_id
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 异步审计导出作业（queued -> running -> ready -> expired / failed）
-- 只导出审计元数据，不含任务/成果正文；下载令牌一次性、短期、按组织绑定。
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.audit_export_view(p_row work.audit_export) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'status', p_row.status,
    'format', p_row.format,
    'range_from', p_row.range_from,
    'range_to', p_row.range_to,
    'requested_by', p_row.requested_by,
    'requested_at', p_row.created_at,
    'ready_at', p_row.ready_at,
    'expires_at', p_row.expires_at,
    'row_count', p_row.row_count,
    'bytes', p_row.bytes,
    'error_code', p_row.error_code,
    'download_available', p_row.status = 'ready' AND p_row.downloaded_at IS NULL
      AND p_row.expires_at > now(),
    'downloaded_at', p_row.downloaded_at
  );
$$;

CREATE FUNCTION work.create_audit_export(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_range_from timestamptz,
  p_range_to timestamptz,
  p_format text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
  retention int;
  req_hash text;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_client_request_id IS NULL OR char_length(btrim(p_client_request_id)) < 8
     OR char_length(p_client_request_id) > 128 THEN
    RAISE EXCEPTION 'invalid_request:client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_format IS NULL OR p_format NOT IN ('csv', 'json') THEN
    RAISE EXCEPTION 'invalid_request:export_format' USING ERRCODE = '22023';
  END IF;
  IF p_range_from IS NULL OR p_range_to IS NULL OR p_range_from >= p_range_to THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to > now() THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(NULLIF(op.policy->>'audit_retention_days', '')::int, 365)
    INTO retention
  FROM work.org_policy op WHERE op.org_id = p_org_id;
  IF retention IS NULL THEN
    retention := 365;
  END IF;
  IF p_range_from < now() - make_interval(days => retention) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to - p_range_from > make_interval(days => 92) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  req_hash := work.sha256_text(jsonb_build_object(
    'client_request_id', p_client_request_id,
    'range_from', p_range_from,
    'range_to', p_range_to,
    'format', p_format
  )::text);

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.client_request_id = p_client_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF export_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN work.audit_export_view(export_row);
  END IF;

  INSERT INTO work.audit_export
    (org_id, requested_by, client_request_id, request_hash, range_from, range_to, format, status)
  VALUES
    (p_org_id, p_subject_id, p_client_request_id, req_hash, p_range_from, p_range_to, p_format, 'queued')
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.requested', 'audit_export', export_row.id::text,
    jsonb_build_object('format', p_format, 'range_from', p_range_from, 'range_to', p_range_to)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.get_audit_export(
  p_org_id text,
  p_subject_id text,
  p_export_id uuid
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'ready' AND export_row.expires_at <= now() THEN
    UPDATE work.audit_export e
      SET status = 'expired', expires_at = NULL, updated_at = now()
    WHERE e.id = export_row.id
    RETURNING * INTO export_row;
    PERFORM work.append_audit(
      p_org_id, NULL, 'audit_export.expired', 'audit_export', export_row.id::text, '{}'::jsonb
    );
  END IF;
  RETURN work.audit_export_view(export_row);
END;
$$;

-- worker 发现入口：只返回本组织 queued 作业 ID，audit_export 表本身仍不对 worker 开放。
CREATE FUNCTION work.list_pending_audit_exports(p_org_id text)
RETURNS TABLE (export_id uuid)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.status = 'queued'
  ORDER BY e.created_at;
END;
$$;

CREATE FUNCTION work.claim_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 600
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'invalid_request:worker_id' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_request:lease_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'running' AND export_row.lease_until > now() THEN
    RAISE EXCEPTION 'audit_export_not_claimable' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'audit_export_not_claimable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'running',
        lease_owner = p_worker_id,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        error_code = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.claimed', 'audit_export', export_row.id::text,
    jsonb_build_object('worker_id', p_worker_id)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.complete_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_row_count bigint,
  p_ttl_seconds integer DEFAULT 86400
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  IF p_content_ref IS NULL OR p_content_ref !~ '^content://' THEN
    RAISE EXCEPTION 'invalid_request:content_ref' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^sha256:[0-9a-f]{8,}$' THEN
    RAISE EXCEPTION 'invalid_request:content_hash' USING ERRCODE = '22023';
  END IF;
  IF p_bytes IS NULL OR p_bytes < 0 OR p_row_count IS NULL OR p_row_count < 0 THEN
    RAISE EXCEPTION 'invalid_request:export_size' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 300 OR p_ttl_seconds > 604800 THEN
    RAISE EXCEPTION 'invalid_request:ttl_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status <> 'running'
     OR export_row.lease_owner IS DISTINCT FROM p_worker_id
     OR export_row.lease_until <= now() THEN
    RAISE EXCEPTION 'audit_export_lease_lost' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'ready',
        content_ref = p_content_ref,
        content_hash = p_content_hash,
        bytes = p_bytes,
        row_count = p_row_count,
        ready_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds),
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.completed', 'audit_export', export_row.id::text,
    jsonb_build_object('row_count', p_row_count, 'bytes', p_bytes, 'content_hash', p_content_hash)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.fail_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.reason_code(p_error_code);
  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status <> 'running'
     OR export_row.lease_owner IS DISTINCT FROM p_worker_id
     OR export_row.lease_until <= now() THEN
    RAISE EXCEPTION 'audit_export_lease_lost' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'failed',
        error_code = p_error_code,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.failed', 'audit_export', export_row.id::text,
    jsonb_build_object('error_code', p_error_code)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.issue_audit_export_download(
  p_org_id text,
  p_subject_id text,
  p_export_id uuid,
  p_token_hash text,
  p_ttl_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:token_hash' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'invalid_request:ttl_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'expired' THEN
    RAISE EXCEPTION 'audit_export_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.status <> 'ready' THEN
    RAISE EXCEPTION 'audit_export_not_ready' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.expires_at <= now() THEN
    RAISE EXCEPTION 'audit_export_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.downloaded_at IS NOT NULL THEN
    RAISE EXCEPTION 'audit_export_already_downloaded' USING ERRCODE = 'P0001';
  END IF;

  -- 下载令牌有效期不得超过文件留存截止时间（P1-2）。
  UPDATE work.audit_export e
    SET download_token_hash = p_token_hash,
        download_expires_at = LEAST(
          now() + make_interval(secs => p_ttl_seconds),
          export_row.expires_at
        ),
        updated_at = now()
  WHERE e.id = export_row.id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.ticket_issued', 'audit_export', export_row.id::text,
    jsonb_build_object('expires_at', LEAST(
      now() + make_interval(secs => p_ttl_seconds),
      export_row.expires_at
    ))
  );
  RETURN jsonb_build_object(
    'export_id', export_row.id,
    'expires_at', LEAST(
      now() + make_interval(secs => p_ttl_seconds),
      export_row.expires_at
    ),
    'bytes', export_row.bytes,
    'row_count', export_row.row_count,
    'format', export_row.format
  );
END;
$$;

CREATE FUNCTION work.redeem_audit_export_download(
  p_org_id text,
  p_subject_id text,
  p_token_hash text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.org_id = p_org_id
    AND e.download_token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;
  -- 文件级过期与状态检查（P1-2）：令牌有效但文件已过期/已下载/非 ready 时拒绝。
  IF export_row.status = 'expired' OR export_row.expires_at <= now() THEN
    RAISE EXCEPTION 'audit_export_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.status <> 'ready' THEN
    RAISE EXCEPTION 'audit_export_not_ready' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.download_expires_at <= now() THEN
    UPDATE work.audit_export e
      SET download_token_hash = NULL, download_expires_at = NULL, updated_at = now()
    WHERE e.id = export_row.id;
    RAISE EXCEPTION 'download_token_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.downloaded_at IS NOT NULL THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;

  UPDATE work.audit_export e
    SET downloaded_at = now(), updated_at = now()
  WHERE e.id = export_row.id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.downloaded', 'audit_export', export_row.id::text,
    jsonb_build_object('bytes', export_row.bytes, 'row_count', export_row.row_count)
  );
  RETURN jsonb_build_object(
    'export_id', export_row.id,
    'content_ref', export_row.content_ref,
    'content_hash', export_row.content_hash,
    'bytes', export_row.bytes,
    'row_count', export_row.row_count,
    'format', export_row.format,
    'expires_at', export_row.expires_at
  );
END;
$$;

CREATE FUNCTION work.expire_due_audit_exports(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  affected int;
BEGIN
  UPDATE work.audit_export e
    SET status = 'expired', expires_at = NULL, updated_at = now()
  WHERE e.status = 'ready' AND e.expires_at <= p_now;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- ---------------------------------------------------------------------------
-- 留存清扫作业（D3 §11 非 Run 后台作业的数据库入口）
--
-- 与 relay 不同：这些作业**按组织逐个事务**运行（app.org_id 绑定目标组织），
-- 不需要也不允许跨组织可见性；租户公平由调度层逐轮访问组织保证。
-- 正文只进 Content Store；本库只留引用，清扫的产物是 content_shred outbox 行。
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.input_ttl_hours() RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(1, COALESCE(NULLIF(current_setting('work.input_ttl_hours', true), ''), '24')::int);
$$;

-- 未绑定任务的输入到期：状态落 expired，并按引用投递粉碎请求。
-- 同一 content_ref 若仍被其他未删除输入或成果引用，则只过期不粉碎（与删除路径同一规则）。
CREATE FUNCTION work.expire_due_inputs(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  swept int := 0;
  input_row work.input_object%ROWTYPE;
  shared boolean;
BEGIN
  FOR input_row IN
    SELECT * FROM work.input_object i
    WHERE i.status = 'active'
      AND i.task_id IS NULL
      AND i.expires_at IS NOT NULL
      AND i.expires_at <= p_now
    ORDER BY i.expires_at, i.id
    FOR UPDATE
  LOOP
    UPDATE work.input_object i
      SET status = 'expired', deleted_at = now()
    WHERE i.id = input_row.id;
    swept := swept + 1;

    SELECT EXISTS (
      SELECT 1 FROM work.input_object other
      WHERE other.org_id = input_row.org_id
        AND other.content_ref = input_row.content_ref
        AND other.deleted_at IS NULL
        AND other.id <> input_row.id
    ) OR EXISTS (
      SELECT 1 FROM work.artifact_version v
      JOIN work.artifact a ON a.id = v.artifact_id AND a.org_id = v.org_id
      WHERE v.org_id = input_row.org_id
        AND v.content_ref = input_row.content_ref
        AND a.deleted_at IS NULL
    ) INTO shared;

    IF NOT shared THEN
      INSERT INTO work.outbox
        (org_id, aggregate_type, aggregate_id, event_id, payload)
      VALUES
        (input_row.org_id, 'content', input_row.id, gen_random_uuid(),
         jsonb_build_object('kind', 'content_shred', 'input_id', input_row.id,
                            'content_refs', jsonb_build_array(input_row.content_ref)));
    END IF;
  END LOOP;

  IF swept > 0 THEN
    PERFORM work.append_audit(
      current_setting('app.org_id', true), NULL, 'input.expiry_swept', 'org',
      current_setting('app.org_id', true),
      jsonb_build_object('count', swept, 'ttl_hours', work.input_ttl_hours())
    );
  END IF;
  RETURN swept;
END;
$$;

-- 审计导出文件到期后的正文清理：作业行保留（元数据是审计事实），只投递引用粉碎。
CREATE FUNCTION work.shred_due_audit_exports(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  swept int := 0;
  export_row work.audit_export%ROWTYPE;
BEGIN
  FOR export_row IN
    SELECT * FROM work.audit_export e
    WHERE e.status = 'expired'
      AND e.content_ref IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM work.outbox o
        WHERE o.org_id = e.org_id
          AND o.aggregate_type = 'content'
          AND o.aggregate_id = e.id
          AND o.payload->>'kind' = 'content_shred'
      )
    ORDER BY e.updated_at, e.id
    FOR UPDATE
  LOOP
    INSERT INTO work.outbox
      (org_id, aggregate_type, aggregate_id, event_id, payload)
    VALUES
      (export_row.org_id, 'content', export_row.id, gen_random_uuid(),
       jsonb_build_object('kind', 'content_shred', 'audit_export_id', export_row.id,
                          'content_refs', jsonb_build_array(export_row.content_ref)));
    UPDATE work.audit_export e
      SET content_ref = NULL, content_hash = NULL, updated_at = now()
    WHERE e.id = export_row.id;
    swept := swept + 1;
  END LOOP;
  IF swept > 0 THEN
    PERFORM work.append_audit(
      current_setting('app.org_id', true), NULL, 'audit_export.shredded', 'org',
      current_setting('app.org_id', true), jsonb_build_object('count', swept)
    );
  END IF;
  RETURN swept;
END;
$$;

-- R0a RLS、函数所有权与最小权限
-- 应用每事务 SET LOCAL app.org_id；FORCE 让表 owner 也受策略约束。

ALTER TABLE work.org ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.org FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON work.org
  USING (id = current_setting('app.org_id', true))
  WITH CHECK (id = current_setting('app.org_id', true));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'member', 'org_policy', 'capability_snapshot', 'input_object',
    'task', 'run', 'operation', 'approval', 'approval_operation',
    'submission_dedup', 'quota_account', 'quota_reservation',
    'provider_credential', 'provider_access_config', 'usage_daily',
    'artifact', 'artifact_version', 'upload_session', 'acceptance',
    'outbox', 'audit_export'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE work.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON work.%I USING (org_id = current_setting(''app.org_id'', true)) WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      table_name
    );
  END LOOP;
END;
$$;

-- Relay 跨组织：仅 work_owner 身份（领域函数内）且函数临时打开 app.outbox_relay 时可见全部组织的 outbox。
CREATE POLICY outbox_relay ON work.outbox
  USING (current_user = 'work_owner' AND current_setting('app.outbox_relay', true) = 'on')
  WITH CHECK (current_user = 'work_owner' AND current_setting('app.outbox_relay', true) = 'on');

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'approval_decision', 'quota_entry', 'task_event', 'audit_event', 'artifact_tombstone'
  ]::text[]
  LOOP
    EXECUTE format('ALTER TABLE work.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE work.%I FORCE ROW LEVEL SECURITY', table_name);
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

-- 所有函数由 work_owner 拥有，作为领域命令执行；只给应用 EXECUTE，不给直接 DML。
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'work'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', fn.signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path = work, pg_catalog', fn.signature);
  END LOOP;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA work FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA work FROM PUBLIC;

GRANT USAGE ON SCHEMA work TO work_api, work_worker, work_ledger, work_ops, work_directory;
GRANT SELECT ON ALL TABLES IN SCHEMA work TO work_api, work_worker;
-- API 不读 outbox/幂等表（避免跨用户请求元数据可见）；relay 走 claim_outbox。
-- 审计导出作业元数据（内容引用、行数、下载状态）只对管理员函数可见，走领域函数。
REVOKE SELECT ON work.outbox, work.submission_dedup, work.audit_export FROM work_api;
REVOKE SELECT ON work.audit_export FROM work_worker;
-- 接入配置与凭证只经领域函数出入：API 与 worker 都没有直接读表路径，
-- 凭证密文列对应用身份不可见（resolve_provider_context 是唯一取用入口）。
REVOKE SELECT ON work.provider_credential, work.provider_access_config FROM work_api;
REVOKE SELECT ON work.provider_credential, work.provider_access_config FROM work_worker;
REVOKE SELECT ON work.usage_daily FROM work_api, work_worker;
GRANT SELECT ON work.task_summary TO work_api, work_worker;

-- 账本/审计角色只读：所有账本写入必须经领域函数（reserve/settle/adjust/release），不允许直接 INSERT。
GRANT SELECT ON work.quota_entry, work.quota_reservation, work.quota_account, work.audit_event TO work_ledger;

GRANT EXECUTE ON FUNCTION work.create_input(text, text, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_input_idempotent(text, text, text, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.submit_task(text, text, text, uuid, text, text, text, jsonb, text[], jsonb, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.retry_task(text, uuid, text, text, bigint, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_cancel(text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.update_task_title(text, uuid, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.record_artifact_export(text, uuid, int, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_user_artifact_version(text, uuid, text, text, int, text, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.publish_artifact(text, uuid, uuid, text, text, text, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.accept_task(text, uuid, text, text, bigint, uuid, int, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.request_approval(text, uuid, text, jsonb, text, timestamptz, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.decide_approval(text, uuid, text, text, bigint, text) TO work_api;

GRANT EXECUTE ON FUNCTION work.acquire_run(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.create_operation(uuid, text, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.authorize_operation(text, uuid, bigint, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_operation(text, uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.cancel_operation(text, uuid, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.reserve_quota(text, text, text, uuid, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_dispatch(uuid, text, text, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.settle_quota(uuid, bigint, jsonb, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.adjust_quota(uuid, bigint, text, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.release_quota(uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_run(uuid, text, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_outbox(text, int, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_delivered(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_outbox_failed(uuid, text, text, boolean) TO work_worker;
GRANT EXECUTE ON FUNCTION work.requeue_outbox_dead_letter(uuid, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.skip_outbox_dead_letter(uuid, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.delete_task(text, uuid, text, bigint, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.ops_delete_task(text, uuid, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.ops_cancel_run(text, uuid, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.transfer_task_ownership(text, uuid, text, text, text, text) TO work_ops;
GRANT EXECUTE ON FUNCTION work.wait_run(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.resume_run(text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.mark_operation_unknown(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.reconcile_operation(text, uuid, text, text, bigint, text) TO work_worker;

-- Host 目录投影（ADR-0021）：只有 work_directory 服务身份能写 org/member 投影，
-- 且必须经 sync_* 领域命令；应用与 worker 角色没有直接 DML，也不能调用这两个函数。
GRANT EXECUTE ON FUNCTION work.sync_org_projection(text, text, text, boolean, text, bigint) TO work_directory;
GRANT EXECUTE ON FUNCTION work.sync_member_projection(text, text, text, text, boolean, bigint) TO work_directory;

-- 管理只读（U2 方案 B）：role/revision/席位/token 配额与审计导出作业由 R0a 领域函数给出。
GRANT EXECUTE ON FUNCTION work.admin_overview(text, text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.list_seats(text, text, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.create_audit_export(text, text, text, timestamptz, timestamptz, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_audit_export(text, text, uuid) TO work_api;
GRANT EXECUTE ON FUNCTION work.issue_audit_export_download(text, text, uuid, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.redeem_audit_export_download(text, text, text) TO work_api;
-- 导出 worker：只领取与收尾作业，正文进 Content Store，库内只留引用与哈希。
GRANT EXECUTE ON FUNCTION work.list_pending_audit_exports(text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_audit_export(uuid, text, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.complete_audit_export(uuid, text, text, text, bigint, bigint, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.fail_audit_export(uuid, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.expire_due_audit_exports(timestamptz) TO work_worker;
GRANT EXECUTE ON FUNCTION work.expire_due_inputs(timestamptz) TO work_worker;
GRANT EXECUTE ON FUNCTION work.shred_due_audit_exports(timestamptz) TO work_worker;

-- D-08 大模型接入与用量：配置写只给 owner（函数内断言）；网关取凭证只给 worker。
GRANT EXECUTE ON FUNCTION work.create_provider_credential(text, text, text, text, text, bytea, bytea, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.rotate_provider_credential(text, text, uuid, bytea, bytea, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_provider_credential(text, text, uuid, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.set_provider_config(text, text, text, text, text, text, text, uuid, bigint) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_provider_config(text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_user_usage(text, text, date, date) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_org_usage_by_model(text, text, date, date) TO work_api;
GRANT EXECUTE ON FUNCTION work.resolve_provider_context(text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.get_provider_config(text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.get_provider_credential_view(text, text, uuid) TO work_api;
GRANT EXECUTE ON FUNCTION work.record_usage(text, text, uuid, text, text, date, bigint, bigint, bigint, int) TO work_worker;

RESET ROLE;

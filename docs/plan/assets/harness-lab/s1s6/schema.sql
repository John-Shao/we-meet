DROP SCHEMA IF EXISTS s1s6 CASCADE;
CREATE SCHEMA s1s6;
SET search_path TO s1s6;

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  state text NOT NULL,
  active_run_id uuid,
  revision int NOT NULL DEFAULT 0,
  snapshot_id text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  attempt_no int NOT NULL,
  state text NOT NULL,
  wait_reason text,
  fence bigint NOT NULL,
  snapshot_id text NOT NULL,
  UNIQUE (task_id, attempt_no),
  UNIQUE (id, org_id),
  FOREIGN KEY (task_id, org_id) REFERENCES tasks(id, org_id)
);
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_active_run FOREIGN KEY (active_run_id, org_id) REFERENCES runs(id, org_id);

CREATE TABLE workflow_starts (
  workflow_id text PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  logical_key text NOT NULL,
  kind text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  dispatch_attempt_id uuid,
  consumer_id text,
  provider_request_id text,
  receipt_ref text,
  UNIQUE (org_id, run_id, logical_key),
  FOREIGN KEY (run_id, org_id) REFERENCES runs(id, org_id)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  operation_key text NOT NULL,
  params_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  decision text,
  policy_epoch int NOT NULL,
  revision int NOT NULL DEFAULT 0
);

CREATE TABLE submissions (
  org_id text NOT NULL,
  subject_id text NOT NULL,
  operation_type text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  task_id uuid,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, subject_id, operation_type, client_request_id)
);

CREATE TABLE budgets (
  org_id text NOT NULL,
  account text NOT NULL,
  period_id text NOT NULL,
  limit_cents bigint NOT NULL CHECK (limit_cents >= 0),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  version int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, account, period_id)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  period_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id) REFERENCES operations(id)
);

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  state text NOT NULL,
  content_hash text NOT NULL,
  artifact_id uuid
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  logical_name text NOT NULL,
  state text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);

CREATE TABLE artifact_versions (
  artifact_id uuid NOT NULL,
  version_no int NOT NULL,
  content_ref text NOT NULL,
  content_hash text NOT NULL,
  state text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (artifact_id, version_no),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

CREATE TABLE acceptances (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  artifact_id uuid,
  version_no int,
  revision int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sse_events (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE TABLE artifact_tombstones (
  artifact_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dr_state (
  id int PRIMARY KEY CHECK (id = 1),
  durable boolean NOT NULL,
  wal_lsn text
);
INSERT INTO dr_state (id, durable, wal_lsn) VALUES (1, true, 'LSN-1');

CREATE TABLE journal_release (
  device_id text PRIMARY KEY,
  session_id text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now()
);

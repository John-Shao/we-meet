-- 0009: F0-R2/F0-R3 execution-fragment ownership, send de-duplication gate,
-- canonical checkpoint head and the usage de-duplication fact.
--
-- Authority: D1 §5.4 "F0-R2 片段所有权与发送去重增量" (objects, lock order
-- Task -> Run -> Operation -> runtime_execution -> dispatch_delivery ->
-- checkpoint head, send boundary/ACK loss rules, 原子收尾 usage dedup),
-- D4 §8.1 (canonical documents, receipt slot rules, usage
-- provider/gateway_estimate/unavailable with NULL tokens, late receipts),
-- D3 §5.0/§5.0.1 RR01-10 recovery matrix.
--
-- Node/egress get no database login and no table-level DML: every write goes
-- through a SECURITY DEFINER command granted to work_worker only (the control
-- plane's internal execution-authorization module identity).
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Short lease for an active fragment (D1 §5.4: lease_until = min(db_now + 30s,
-- hard_deadline), heartbeat suggested every 10s).
CREATE FUNCTION work.runtime_lease_seconds() RETURNS int
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
  SELECT LEAST(120, GREATEST(5,
    COALESCE(NULLIF(current_setting('work.runtime_lease_seconds', true), ''), '30')::int));
$$;

-- Bounded hard deadline for a registered fragment that is still queued.
CREATE FUNCTION work.runtime_hard_deadline_max_seconds() RETURNS int
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
  SELECT LEAST(86400, GREATEST(60,
    COALESCE(NULLIF(current_setting('work.runtime_hard_deadline_max_seconds', true), ''), '3600')::int));
$$;

-- Every runtime command runs under an explicit tenant context. A missing
-- app.org_id is a rejection, not an empty result set.
CREATE FUNCTION work.assert_runtime_context(p_org_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR NULLIF(current_setting('app.org_id', true), '') IS NULL
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'runtime_org_context_mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION work.assert_runtime_identifier(p_label text, p_value text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid_request:%', p_label USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Content Store document hashes are domain-prefixed sha256 (D4 §8.1).
CREATE FUNCTION work.assert_document_hash(p_label text, p_hash text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:%', p_label USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE FUNCTION work.assert_content_ref(p_label text, p_ref text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_ref IS NULL OR length(btrim(p_ref)) = 0 OR length(p_ref) > 512 THEN
    RAISE EXCEPTION 'invalid_request:%', p_label USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Unified lock order head: Task -> Run. Callers continue with
-- Operation -> runtime_execution -> dispatch_delivery -> checkpoint head.
CREATE FUNCTION work.lock_runtime_run(p_org_id text, p_run_id uuid)
RETURNS work.run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task_id uuid;
  run_row work.run%ROWTYPE;
BEGIN
  SELECT r.task_id INTO v_task_id
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO run_row
  FROM work.run r
  WHERE r.id = p_run_id AND r.org_id = p_org_id
  FOR UPDATE;
  RETURN run_row;
END;
$$;

CREATE FUNCTION work.assert_org_execution_enabled(p_org_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  org_row work.org%ROWTYPE;
BEGIN
  SELECT * INTO org_row FROM work.org o WHERE o.id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF org_row.status <> 'active' OR NOT org_row.execution_enabled OR org_row.operator_suspended THEN
    RAISE EXCEPTION 'org_execution_disabled' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Persistent objects
-- ---------------------------------------------------------------------------

-- One execution fragment. holder_id is the parent-process start instance, not
-- a reusable pod name. Binding columns are immutable; expiry is an explicit
-- state change made by the lock-holding command using the database clock read
-- after the lock was acquired, so the partial unique index contains no now().
CREATE TABLE work.runtime_execution (
  execution_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('plan', 'execute')),
  run_fence bigint NOT NULL CHECK (run_fence > 0),
  runtime_version text NOT NULL,
  input_checkpoint_ref text,
  input_checkpoint_hash text,
  intent_ref text,
  intent_hash text,
  request_hash text,
  operation_id uuid,
  dispatch_attempt_id uuid,
  state text NOT NULL CHECK (state IN ('registered', 'active', 'completed', 'revoked', 'expired')),
  holder_id text,
  lease_until timestamptz,
  hard_deadline timestamptz NOT NULL,
  heartbeat_seq bigint NOT NULL DEFAULT 0 CHECK (heartbeat_seq >= 0),
  revision bigint NOT NULL DEFAULT 0,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, org_id),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (run_id, task_id, org_id) REFERENCES work.run(id, task_id, org_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT runtime_execution_execute_binding CHECK (
    mode <> 'execute' OR (
      operation_id IS NOT NULL AND dispatch_attempt_id IS NOT NULL
      AND request_hash IS NOT NULL AND intent_ref IS NOT NULL AND intent_hash IS NOT NULL
    )
  ),
  CONSTRAINT runtime_execution_plan_binding CHECK (
    mode <> 'plan' OR (
      operation_id IS NULL AND dispatch_attempt_id IS NULL AND request_hash IS NULL
      AND intent_ref IS NULL AND intent_hash IS NULL
    )
  ),
  CONSTRAINT runtime_execution_checkpoint_pair CHECK (
    (input_checkpoint_ref IS NULL) = (input_checkpoint_hash IS NULL)
  ),
  CONSTRAINT runtime_execution_registered_unclaimed CHECK (
    state <> 'registered' OR (holder_id IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT runtime_execution_active_lease CHECK (
    state <> 'active' OR (holder_id IS NOT NULL AND lease_until IS NOT NULL)
  )
);

-- No now() in the predicate: liveness is a stored state, not a clock read.
CREATE UNIQUE INDEX work_runtime_execution_one_live_per_run
  ON work.runtime_execution(org_id, run_id)
  WHERE state IN ('registered', 'active');
CREATE INDEX work_runtime_execution_run ON work.runtime_execution(org_id, run_id, state);
CREATE INDEX work_runtime_execution_operation
  ON work.runtime_execution(org_id, operation_id)
  WHERE operation_id IS NOT NULL;

-- Exactly one gate per Operation for its whole life. A consumed gate never
-- reopens on lease expiry, holder restart or receipt loss; the absence of a
-- row is not proof of not_sent, only a seal that wins the same-lock race is.
CREATE TABLE work.dispatch_delivery (
  org_id text NOT NULL,
  operation_id uuid NOT NULL,
  gate_state text NOT NULL CHECK (gate_state IN ('sealed_not_sent', 'consumed', 'receipt_recorded')),
  execution_id uuid,
  holder_id text,
  attempt_id uuid,
  request_hash text,
  gateway_invocation_id text,
  receipt_slot_id uuid,
  receipt_ref text,
  receipt_hash text,
  receipt_result text CHECK (receipt_result IN ('success', 'rejected_not_executed')),
  provider_request_id text,
  seal_reason text,
  sealed_at timestamptz,
  consumed_at timestamptz,
  receipt_recorded_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id),
  UNIQUE (org_id, receipt_slot_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  FOREIGN KEY (execution_id, org_id) REFERENCES work.runtime_execution(execution_id, org_id),
  CONSTRAINT dispatch_delivery_sealed_shape CHECK (
    gate_state <> 'sealed_not_sent' OR (
      sealed_at IS NOT NULL AND consumed_at IS NULL AND receipt_slot_id IS NULL
      AND holder_id IS NULL AND attempt_id IS NULL AND receipt_ref IS NULL
      AND receipt_hash IS NULL AND receipt_result IS NULL
    )
  ),
  CONSTRAINT dispatch_delivery_consumed_shape CHECK (
    gate_state = 'sealed_not_sent' OR (
      execution_id IS NOT NULL AND holder_id IS NOT NULL AND attempt_id IS NOT NULL
      AND request_hash IS NOT NULL AND receipt_slot_id IS NOT NULL
      AND consumed_at IS NOT NULL AND sealed_at IS NULL
    )
  ),
  CONSTRAINT dispatch_delivery_receipt_shape CHECK (
    gate_state <> 'receipt_recorded' OR (
      receipt_ref IS NOT NULL AND receipt_hash IS NOT NULL
      AND receipt_result IS NOT NULL AND receipt_recorded_at IS NOT NULL
    )
  )
);

CREATE INDEX work_dispatch_delivery_state ON work.dispatch_delivery(org_id, gate_state);
CREATE INDEX work_dispatch_delivery_execution
  ON work.dispatch_delivery(org_id, execution_id)
  WHERE execution_id IS NOT NULL;

-- Only verified, recoverable canonical heads. Advanced by CAS on expected
-- revision/ref/hash; the first head is inserted as revision 0 under the
-- Task/Run lock. Never an unconditional upsert and never "newest file wins".
CREATE TABLE work.runtime_checkpoint_head (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  checkpoint_revision bigint NOT NULL CHECK (checkpoint_revision >= 0),
  checkpoint_ref text NOT NULL,
  checkpoint_hash text NOT NULL,
  runtime_version text NOT NULL,
  committed_execution_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (run_id, task_id, org_id) REFERENCES work.run(id, task_id, org_id),
  FOREIGN KEY (committed_execution_id, org_id)
    REFERENCES work.runtime_execution(execution_id, org_id)
);

-- Usage de-duplication fact (D1 §5.4 原子收尾). A settle entry is never used to
-- guess whether usage was counted. unavailable means NULL tokens, never 0.
-- origin = 'legacy_marker_backfill' rows carry no values: they only record
-- that the pre-0009 timestamp marker had already counted the operation.
CREATE TABLE work.operation_usage_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  operation_id uuid NOT NULL,
  usage_revision int NOT NULL CHECK (usage_revision >= 1),
  origin text NOT NULL DEFAULT 'command'
    CHECK (origin IN ('command', 'legacy_marker_backfill')),
  usage_source text CHECK (usage_source IN ('provider', 'gateway_estimate', 'unavailable')),
  source_receipt_hash text,
  subject_id text,
  provider text,
  model text,
  usage_date date,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  counted_in_usage_daily boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, operation_id, usage_revision),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT operation_usage_fact_command_shape CHECK (
    origin <> 'command' OR (
      usage_source IS NOT NULL AND subject_id IS NOT NULL
      AND provider IS NOT NULL AND model IS NOT NULL AND usage_date IS NOT NULL
    )
  ),
  CONSTRAINT operation_usage_fact_legacy_shape CHECK (
    origin <> 'legacy_marker_backfill' OR (
      usage_revision = 1 AND usage_source IS NULL AND source_receipt_hash IS NULL
      AND subject_id IS NULL AND provider IS NULL AND model IS NULL
      AND usage_date IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
      AND cached_input_tokens IS NULL
    )
  ),
  CONSTRAINT operation_usage_fact_unavailable_is_null CHECK (
    usage_source IS DISTINCT FROM 'unavailable' OR (
      input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL
    )
  ),
  CONSTRAINT operation_usage_fact_known_tokens CHECK (
    usage_source IS NULL OR usage_source = 'unavailable' OR (
      input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND cached_input_tokens IS NOT NULL
    )
  )
);

CREATE INDEX work_operation_usage_fact_operation
  ON work.operation_usage_fact(org_id, operation_id, usage_revision DESC);

-- ---------------------------------------------------------------------------
-- Backfill: operations already counted by 0008's timestamp marker get a dedup
-- fact so that a replay through the new commands cannot double count
-- usage_daily. FORCE RLS is lifted for this transaction only and restored
-- immediately, exactly as published migration 0007 does for work.org.
-- ---------------------------------------------------------------------------
ALTER TABLE work.operation NO FORCE ROW LEVEL SECURITY;
INSERT INTO work.operation_usage_fact
  (org_id, operation_id, usage_revision, origin, counted_in_usage_daily, recorded_at)
SELECT o.org_id, o.id, 1, 'legacy_marker_backfill', true, o.usage_recorded_at
FROM work.operation o
WHERE o.usage_recorded_at IS NOT NULL
ON CONFLICT (org_id, operation_id, usage_revision) DO NOTHING;
ALTER TABLE work.operation FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runtime_execution', 'dispatch_delivery', 'runtime_checkpoint_head'
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

ALTER TABLE work.operation_usage_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.operation_usage_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON work.operation_usage_fact
  FOR SELECT USING (org_id = current_setting('app.org_id', true));
CREATE POLICY tenant_insert ON work.operation_usage_fact
  FOR INSERT WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---------------------------------------------------------------------------
-- Immutability and state guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.runtime_execution_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.run_fence IS DISTINCT FROM OLD.run_fence
     OR NEW.runtime_version IS DISTINCT FROM OLD.runtime_version
     OR NEW.input_checkpoint_ref IS DISTINCT FROM OLD.input_checkpoint_ref
     OR NEW.input_checkpoint_hash IS DISTINCT FROM OLD.input_checkpoint_hash
     OR NEW.intent_ref IS DISTINCT FROM OLD.intent_ref
     OR NEW.intent_hash IS DISTINCT FROM OLD.intent_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.dispatch_attempt_id IS DISTINCT FROM OLD.dispatch_attempt_id
     OR NEW.hard_deadline IS DISTINCT FROM OLD.hard_deadline THEN
    RAISE EXCEPTION 'runtime_execution_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.holder_id IS NOT NULL AND NEW.holder_id IS DISTINCT FROM OLD.holder_id THEN
    RAISE EXCEPTION 'runtime_execution_holder_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.heartbeat_seq < OLD.heartbeat_seq THEN
    RAISE EXCEPTION 'runtime_execution_heartbeat_not_monotonic' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state IN ('completed', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_terminal' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'registered' AND NEW.state NOT IN ('active', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_invalid_transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'active' AND NEW.state NOT IN ('completed', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_invalid_transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runtime_execution_guard BEFORE UPDATE ON work.runtime_execution
  FOR EACH ROW EXECUTE FUNCTION work.runtime_execution_guard();
CREATE TRIGGER runtime_execution_no_delete BEFORE DELETE ON work.runtime_execution
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE FUNCTION work.dispatch_delivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.holder_id IS DISTINCT FROM OLD.holder_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.receipt_slot_id IS DISTINCT FROM OLD.receipt_slot_id
     OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
     OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
    RAISE EXCEPTION 'dispatch_gate_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.gate_state = 'sealed_not_sent' THEN
    RAISE EXCEPTION 'dispatch_gate_sealed_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.gate_state IS DISTINCT FROM OLD.gate_state
     AND NOT (OLD.gate_state = 'consumed' AND NEW.gate_state = 'receipt_recorded') THEN
    RAISE EXCEPTION 'dispatch_gate_state_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.gate_state = 'receipt_recorded'
     AND (NEW.receipt_ref IS DISTINCT FROM OLD.receipt_ref
          OR NEW.receipt_hash IS DISTINCT FROM OLD.receipt_hash
          OR NEW.receipt_result IS DISTINCT FROM OLD.receipt_result
          OR NEW.receipt_recorded_at IS DISTINCT FROM OLD.receipt_recorded_at) THEN
    RAISE EXCEPTION 'dispatch_receipt_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispatch_delivery_guard BEFORE UPDATE ON work.dispatch_delivery
  FOR EACH ROW EXECUTE FUNCTION work.dispatch_delivery_guard();
-- The gate/dedup tombstone outlives content deletion (D1 §5.4 retention).
CREATE TRIGGER dispatch_delivery_no_delete BEFORE DELETE ON work.dispatch_delivery
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE FUNCTION work.runtime_checkpoint_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id THEN
    RAISE EXCEPTION 'runtime_checkpoint_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.checkpoint_revision <> OLD.checkpoint_revision + 1 THEN
    RAISE EXCEPTION 'runtime_checkpoint_revision_not_monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runtime_checkpoint_head_guard BEFORE UPDATE ON work.runtime_checkpoint_head
  FOR EACH ROW EXECUTE FUNCTION work.runtime_checkpoint_head_guard();
CREATE TRIGGER runtime_checkpoint_head_no_delete BEFORE DELETE ON work.runtime_checkpoint_head
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE TRIGGER operation_usage_fact_append_only
  BEFORE UPDATE OR DELETE ON work.operation_usage_fact
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Fragment ownership commands
-- ---------------------------------------------------------------------------

-- Register a fragment for the current Run. Same execution_id with the same
-- binding is idempotent; a different binding is rejected. Expiry of an older
-- fragment is an explicit state change under this lock using the database
-- clock read after the lock.
CREATE FUNCTION work.register_runtime_execution(
  p_org_id text,
  p_execution_id uuid,
  p_run_id uuid,
  p_mode text,
  p_run_fence bigint,
  p_runtime_version text,
  p_hard_deadline timestamptz,
  p_input_checkpoint_ref text DEFAULT NULL,
  p_input_checkpoint_hash text DEFAULT NULL,
  p_intent_ref text DEFAULT NULL,
  p_intent_hash text DEFAULT NULL,
  p_request_hash text DEFAULT NULL,
  p_operation_id uuid DEFAULT NULL,
  p_attempt_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  head_row work.runtime_checkpoint_head%ROWTYPE;
  existing work.runtime_execution%ROWTYPE;
  expired_row work.runtime_execution%ROWTYPE;
  live_count int;
  v_now timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_execution_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_id' USING ERRCODE = '22023';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('plan', 'execute') THEN
    RAISE EXCEPTION 'invalid_request:mode' USING ERRCODE = '22023';
  END IF;
  IF p_run_fence IS NULL OR p_run_fence <= 0 THEN
    RAISE EXCEPTION 'invalid_request:run_fence' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_runtime_identifier('runtime_version', p_runtime_version);
  IF (p_input_checkpoint_ref IS NULL) <> (p_input_checkpoint_hash IS NULL) THEN
    RAISE EXCEPTION 'invalid_request:input_checkpoint' USING ERRCODE = '22023';
  END IF;
  IF p_input_checkpoint_hash IS NOT NULL THEN
    PERFORM work.assert_document_hash('input_checkpoint_hash', p_input_checkpoint_hash);
    PERFORM work.assert_content_ref('input_checkpoint_ref', p_input_checkpoint_ref);
  END IF;
  IF p_mode = 'execute' THEN
    IF p_operation_id IS NULL OR p_attempt_id IS NULL OR p_request_hash IS NULL
       OR p_input_checkpoint_ref IS NULL THEN
      RAISE EXCEPTION 'invalid_request:execute_binding' USING ERRCODE = '22023';
    END IF;
    PERFORM work.assert_document_hash('intent_hash', p_intent_hash);
    PERFORM work.assert_content_ref('intent_ref', p_intent_ref);
  ELSIF p_operation_id IS NOT NULL OR p_attempt_id IS NOT NULL OR p_request_hash IS NOT NULL
        OR p_intent_ref IS NOT NULL OR p_intent_hash IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_request:plan_binding' USING ERRCODE = '22023';
  END IF;

  run_row := work.lock_runtime_run(p_org_id, p_run_id);
  v_now := clock_timestamp();
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;

  -- Idempotent replay of the same execution_id.
  SELECT * INTO existing
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.run_id IS DISTINCT FROM p_run_id
       OR existing.mode IS DISTINCT FROM p_mode
       OR existing.run_fence IS DISTINCT FROM p_run_fence
       OR existing.runtime_version IS DISTINCT FROM p_runtime_version
       OR existing.hard_deadline IS DISTINCT FROM p_hard_deadline
       OR existing.input_checkpoint_ref IS DISTINCT FROM p_input_checkpoint_ref
       OR existing.input_checkpoint_hash IS DISTINCT FROM p_input_checkpoint_hash
       OR existing.intent_ref IS DISTINCT FROM p_intent_ref
       OR existing.intent_hash IS DISTINCT FROM p_intent_hash
       OR existing.request_hash IS DISTINCT FROM p_request_hash
       OR existing.operation_id IS DISTINCT FROM p_operation_id
       OR existing.dispatch_attempt_id IS DISTINCT FROM p_attempt_id THEN
      RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN existing.state;
  END IF;

  IF p_hard_deadline IS NULL
     OR p_hard_deadline <= v_now
     OR p_hard_deadline > v_now + make_interval(secs => work.runtime_hard_deadline_max_seconds()) THEN
    RAISE EXCEPTION 'invalid_request:hard_deadline' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_org_execution_enabled(p_org_id);
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state <> 'active' OR run_row.fence <> p_run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;

  -- Explicit expiry of stale fragments, then the live-fragment check. This is
  -- the command that is allowed to commit an expiry: claim/consume/commit only
  -- refuse, so the elapsed row stays visible until a registration replaces it.
  FOR expired_row IN
    UPDATE work.runtime_execution e
    SET state = 'expired',
        lease_until = NULL,
        terminal_reason = 'deadline_elapsed',
        revision = e.revision + 1,
        updated_at = now()
    WHERE e.org_id = p_org_id AND e.run_id = p_run_id
      AND e.state IN ('registered', 'active')
      AND (e.hard_deadline <= v_now OR (e.state = 'active' AND e.lease_until <= v_now))
    RETURNING e.*
  LOOP
    PERFORM work.append_audit(
      p_org_id, NULL, 'runtime.execution_expired', 'runtime_execution',
      expired_row.execution_id::text,
      jsonb_build_object('run_id', p_run_id, 'holder_id', expired_row.holder_id,
                         'reason', 'deadline_elapsed')
    );
  END LOOP;
  SELECT count(*) INTO live_count
  FROM work.runtime_execution e
  WHERE e.org_id = p_org_id AND e.run_id = p_run_id AND e.state IN ('registered', 'active');
  IF live_count > 0 THEN
    RAISE EXCEPTION 'runtime_execution_already_live' USING ERRCODE = 'P0001';
  END IF;

  -- The declared base must be the committed head; no candidate may skip it.
  SELECT * INTO head_row
  FROM work.runtime_checkpoint_head h
  WHERE h.org_id = p_org_id AND h.run_id = p_run_id
  FOR UPDATE;
  IF FOUND THEN
    IF p_input_checkpoint_ref IS DISTINCT FROM head_row.checkpoint_ref
       OR p_input_checkpoint_hash IS DISTINCT FROM head_row.checkpoint_hash THEN
      RAISE EXCEPTION 'runtime_checkpoint_base_mismatch' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_input_checkpoint_ref IS NOT NULL THEN
    RAISE EXCEPTION 'runtime_checkpoint_base_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'execute' THEN
    SELECT * INTO operation_row
    FROM work.operation o
    WHERE o.id = p_operation_id AND o.org_id = p_org_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF operation_row.run_id IS DISTINCT FROM p_run_id
       OR operation_row.state <> 'dispatching'
       OR operation_row.dispatch_attempt_id IS DISTINCT FROM p_attempt_id
       OR operation_row.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'runtime_execution_intent_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM work.dispatch_delivery d
      WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id
    ) THEN
      RAISE EXCEPTION 'dispatch_gate_exists' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO work.runtime_execution
    (execution_id, org_id, task_id, run_id, mode, run_fence, runtime_version,
     input_checkpoint_ref, input_checkpoint_hash, intent_ref, intent_hash,
     request_hash, operation_id, dispatch_attempt_id, state, hard_deadline)
  VALUES
    (p_execution_id, p_org_id, run_row.task_id, p_run_id, p_mode, p_run_fence,
     p_runtime_version, p_input_checkpoint_ref, p_input_checkpoint_hash,
     p_intent_ref, p_intent_hash, p_request_hash, p_operation_id, p_attempt_id,
     'registered', p_hard_deadline);
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.execution_registered', 'runtime_execution', p_execution_id::text,
    jsonb_build_object(
      'run_id', p_run_id, 'mode', p_mode, 'run_fence', p_run_fence::text,
      'operation_id', p_operation_id, 'intent_hash', p_intent_hash,
      'input_checkpoint_hash', p_input_checkpoint_hash
    )
  );
  RETURN 'registered';
END;
$$;

-- registered -> active with a fixed holder and a short lease. A replay by the
-- same holder is a query only and must not start a second child process; a
-- different holder is refused. Lease/deadline comparisons use the database
-- clock read after the lock.
CREATE FUNCTION work.claim_runtime_execution(
  p_org_id text,
  p_execution_id uuid,
  p_holder_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_now timestamptz;
  v_lease timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('holder_id', p_holder_id);
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF execution_row.state IN ('completed', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'runtime_execution_not_claimable' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.hard_deadline <= v_now
     OR (execution_row.state = 'active' AND execution_row.lease_until <= v_now) THEN
    -- Refuse only: the elapsed row stays until register_runtime_execution
    -- commits the explicit expiry and replaces it.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.state = 'active' THEN
    IF execution_row.holder_id IS DISTINCT FROM p_holder_id THEN
      RAISE EXCEPTION 'runtime_execution_holder_mismatch' USING ERRCODE = '42501';
    END IF;
    -- Same holder: state query only, never a second fork.
    RETURN 'already_claimed';
  END IF;

  PERFORM work.assert_org_execution_enabled(p_org_id);
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  v_lease := LEAST(v_now + make_interval(secs => work.runtime_lease_seconds()),
                   execution_row.hard_deadline);
  UPDATE work.runtime_execution e
  SET state = 'active', holder_id = p_holder_id, lease_until = v_lease,
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.execution_claimed', 'runtime_execution', p_execution_id::text,
    jsonb_build_object('holder_id', p_holder_id, 'lease_until', v_lease)
  );
  RETURN 'claimed';
END;
$$;

-- Only the current holder renews. A duplicate or older sequence does not
-- extend the lease, and a late heartbeat never revives an expired fragment: it
-- commits the expiry and returns NULL, which is not a lease. The hard deadline
-- is never moved.
CREATE FUNCTION work.renew_runtime_execution(
  p_org_id text,
  p_execution_id uuid,
  p_holder_id text,
  p_heartbeat_seq bigint
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_now timestamptz;
  v_lease timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('holder_id', p_holder_id);
  IF p_heartbeat_seq IS NULL OR p_heartbeat_seq < 0 THEN
    RAISE EXCEPTION 'invalid_request:heartbeat_seq' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.holder_id IS DISTINCT FROM p_holder_id THEN
    RAISE EXCEPTION 'runtime_execution_holder_mismatch' USING ERRCODE = '42501';
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- A late heartbeat terminates the fragment instead of reviving it. This
    -- expiry is committed and NULL tells the holder it has no lease left.
    UPDATE work.runtime_execution e
    SET state = 'expired', lease_until = NULL, terminal_reason = 'deadline_elapsed',
        revision = e.revision + 1, updated_at = now()
    WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
    PERFORM work.append_audit(
      p_org_id, NULL, 'runtime.execution_expired', 'runtime_execution', p_execution_id::text,
      jsonb_build_object('run_id', execution_row.run_id, 'holder_id', p_holder_id,
                         'reason', 'late_heartbeat')
    );
    RETURN NULL;
  END IF;
  IF p_heartbeat_seq <= execution_row.heartbeat_seq THEN
    RETURN execution_row.lease_until;
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  v_lease := LEAST(v_now + make_interval(secs => work.runtime_lease_seconds()),
                   execution_row.hard_deadline);
  UPDATE work.runtime_execution e
  SET lease_until = v_lease, heartbeat_seq = p_heartbeat_seq,
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  RETURN v_lease;
END;
$$;

-- Stop future content writes, head commits and gate consumption. Terminal
-- states are idempotent. Revocation says nothing about the gate: a consumed
-- gate can never be read as not_sent because of a revocation.
CREATE FUNCTION work.revoke_runtime_execution(
  p_org_id text,
  p_execution_id uuid,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  reason text := work.reason_code(p_reason);
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF reason IS NULL THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF execution_row.state IN ('completed', 'revoked', 'expired') THEN
    RETURN execution_row.state;
  END IF;
  UPDATE work.runtime_execution e
  SET state = 'revoked', lease_until = NULL, terminal_reason = reason,
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.execution_revoked', 'runtime_execution', p_execution_id::text,
    jsonb_build_object('reason', reason, 'previous_state', execution_row.state)
  );
  RETURN 'revoked';
END;
$$;

-- ---------------------------------------------------------------------------
-- Send boundary
-- ---------------------------------------------------------------------------

-- Atomically verify Run/policy/reservation, the active lease, holder, fence,
-- execution/operation/attempt/hash, then insert the consumed gate with its
-- fixed receipt slot. Only this single successful inserter is told "won";
-- every conflict, retry or query is answered "observed" and carries no send
-- permission.
CREATE FUNCTION work.consume_dispatch_delivery(
  p_org_id text,
  p_operation_id uuid,
  p_execution_id uuid,
  p_holder_id text,
  p_attempt_id uuid,
  p_request_hash text,
  p_run_fence bigint,
  p_gateway_invocation_id text,
  p_receipt_slot_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  execution_row work.runtime_execution%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  v_run_id uuid;
  v_now timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('holder_id', p_holder_id);
  PERFORM work.assert_runtime_identifier('gateway_invocation_id', p_gateway_invocation_id);
  IF p_operation_id IS NULL OR p_execution_id IS NULL OR p_attempt_id IS NULL
     OR p_receipt_slot_id IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'invalid_request:consume_binding' USING ERRCODE = '22023';
  END IF;
  IF p_run_fence IS NULL OR p_run_fence <= 0 THEN
    RAISE EXCEPTION 'invalid_request:run_fence' USING ERRCODE = '22023';
  END IF;

  SELECT o.run_id INTO v_run_id
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, v_run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO gate_row
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id
  FOR UPDATE;
  v_now := clock_timestamp();

  -- A gate that already exists ends the decision: observed, never won again.
  IF gate_row.operation_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'observed',
      'gate_state', gate_row.gate_state,
      'receipt_slot_id', gate_row.receipt_slot_id,
      'gateway_invocation_id', gate_row.gateway_invocation_id
    );
  END IF;

  IF execution_row.execution_id IS NULL THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.holder_id IS DISTINCT FROM p_holder_id THEN
    RAISE EXCEPTION 'runtime_execution_holder_mismatch' USING ERRCODE = '42501';
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- Refuse only; the expiry is committed by renew/register.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.mode <> 'execute'
     OR execution_row.run_id IS DISTINCT FROM v_run_id
     OR execution_row.run_fence IS DISTINCT FROM p_run_fence
     OR execution_row.operation_id IS DISTINCT FROM p_operation_id
     OR execution_row.dispatch_attempt_id IS DISTINCT FROM p_attempt_id
     OR execution_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'runtime_execution_intent_mismatch' USING ERRCODE = 'P0001';
  END IF;

  PERFORM work.assert_org_execution_enabled(p_org_id);
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> p_run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state <> 'dispatching'
     OR operation_row.dispatch_attempt_id IS DISTINCT FROM p_attempt_id
     OR operation_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'operation_not_dispatchable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.quota_reservation br
    WHERE br.org_id = p_org_id AND br.operation_id = p_operation_id
      AND br.state IN ('held', 'unknown')
  ) THEN
    RAISE EXCEPTION 'operation_reservation_missing' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO work.dispatch_delivery
      (org_id, operation_id, gate_state, execution_id, holder_id, attempt_id,
       request_hash, gateway_invocation_id, receipt_slot_id, consumed_at)
    VALUES
      (p_org_id, p_operation_id, 'consumed', p_execution_id, p_holder_id, p_attempt_id,
       p_request_hash, p_gateway_invocation_id, p_receipt_slot_id, v_now);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO gate_row
    FROM work.dispatch_delivery d
    WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id;
    RETURN jsonb_build_object(
      'outcome', 'observed',
      'gate_state', COALESCE(gate_row.gate_state, 'receipt_slot_taken'),
      'receipt_slot_id', gate_row.receipt_slot_id,
      'gateway_invocation_id', gate_row.gateway_invocation_id
    );
  END;
  PERFORM work.append_audit(
    p_org_id, NULL, 'dispatch.gate_consumed', 'operation', p_operation_id::text,
    jsonb_build_object(
      'execution_id', p_execution_id, 'holder_id', p_holder_id,
      'attempt_id', p_attempt_id, 'gateway_invocation_id', p_gateway_invocation_id,
      'receipt_slot_id', p_receipt_slot_id
    )
  );
  RETURN jsonb_build_object(
    'outcome', 'won',
    'gate_state', 'consumed',
    'receipt_slot_id', p_receipt_slot_id,
    'gateway_invocation_id', p_gateway_invocation_id
  );
END;
$$;

-- Terminate the fragment and, only if the gate does not exist yet, insert the
-- sealed_not_sent row. not_sent is proven by winning this race, never by the
-- absence of a gate. An already consumed gate returns not_sent_proven = false.
CREATE FUNCTION work.seal_dispatch_not_sent(
  p_org_id text,
  p_operation_id uuid,
  p_reason text,
  p_execution_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  v_run_id uuid;
  v_now timestamptz;
  reason text := work.reason_code(p_reason);
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF reason IS NULL THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT o.run_id INTO v_run_id
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, v_run_id);
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO gate_row
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF gate_row.operation_id IS NOT NULL AND gate_row.gate_state <> 'sealed_not_sent' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_consumed',
      'gate_state', gate_row.gate_state,
      'not_sent_proven', false
    );
  END IF;

  -- The fragment loses write/consume rights first, under the same lock order.
  UPDATE work.runtime_execution e
  SET state = 'revoked', lease_until = NULL, terminal_reason = reason,
      revision = e.revision + 1, updated_at = now()
  WHERE e.org_id = p_org_id AND e.run_id = v_run_id
    AND e.state IN ('registered', 'active')
    AND (e.operation_id = p_operation_id
         OR (p_execution_id IS NOT NULL AND e.execution_id = p_execution_id));

  IF gate_row.operation_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'already_sealed',
      'gate_state', gate_row.gate_state,
      'not_sent_proven', true
    );
  END IF;
  IF operation_row.state NOT IN ('authorized', 'dispatching', 'unknown', 'unresolved') THEN
    RAISE EXCEPTION 'operation_not_sealable' USING ERRCODE = 'P0001',
      DETAIL = operation_row.state;
  END IF;
  INSERT INTO work.dispatch_delivery
    (org_id, operation_id, gate_state, seal_reason, sealed_at)
  VALUES
    (p_org_id, p_operation_id, 'sealed_not_sent', reason, v_now);
  PERFORM work.append_audit(
    p_org_id, NULL, 'dispatch.gate_sealed', 'operation', p_operation_id::text,
    jsonb_build_object('reason', reason, 'execution_id', p_execution_id,
                       'operation_state', operation_row.state)
  );
  RETURN jsonb_build_object(
    'outcome', 'sealed',
    'gate_state', 'sealed_not_sent',
    'not_sent_proven', true
  );
END;
$$;

-- Bind trusted external evidence to the pre-allocated receipt slot. The first
-- terminal version is immutable: the same hash is idempotent, different
-- content conflicts. Late receipts may attach to a revoked fragment or a
-- canceled Run as metering/evidence; they never restore execution rights.
CREATE FUNCTION work.attach_dispatch_receipt(
  p_org_id text,
  p_operation_id uuid,
  p_receipt_slot_id uuid,
  p_receipt_ref text,
  p_receipt_hash text,
  p_receipt_result text,
  p_provider_request_id text DEFAULT NULL,
  p_gateway_invocation_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  gate_row work.dispatch_delivery%ROWTYPE;
  v_run_id uuid;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_content_ref('receipt_ref', p_receipt_ref);
  PERFORM work.assert_document_hash('receipt_hash', p_receipt_hash);
  IF p_receipt_result IS NULL OR p_receipt_result NOT IN ('success', 'rejected_not_executed') THEN
    RAISE EXCEPTION 'invalid_request:receipt_result' USING ERRCODE = '22023';
  END IF;
  IF p_receipt_slot_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:receipt_slot_id' USING ERRCODE = '22023';
  END IF;
  SELECT o.run_id INTO v_run_id
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM work.lock_runtime_run(p_org_id, v_run_id);
  SELECT * INTO gate_row
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id
  FOR UPDATE;
  IF gate_row.operation_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_gate_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF gate_row.gate_state = 'sealed_not_sent' THEN
    RAISE EXCEPTION 'dispatch_gate_sealed_not_sent' USING ERRCODE = 'P0001';
  END IF;
  IF gate_row.receipt_slot_id IS DISTINCT FROM p_receipt_slot_id THEN
    RAISE EXCEPTION 'receipt_slot_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF gate_row.gate_state = 'receipt_recorded' THEN
    IF gate_row.receipt_hash = p_receipt_hash
       AND gate_row.receipt_ref = p_receipt_ref
       AND gate_row.receipt_result = p_receipt_result THEN
      RETURN jsonb_build_object(
        'outcome', 'idempotent',
        'gate_state', gate_row.gate_state,
        'receipt_hash', gate_row.receipt_hash
      );
    END IF;
    RAISE EXCEPTION 'receipt_content_conflict' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.dispatch_delivery d
  SET gate_state = 'receipt_recorded',
      receipt_ref = p_receipt_ref,
      receipt_hash = p_receipt_hash,
      receipt_result = p_receipt_result,
      provider_request_id = p_provider_request_id,
      gateway_invocation_id = COALESCE(p_gateway_invocation_id, d.gateway_invocation_id),
      receipt_recorded_at = now(),
      revision = d.revision + 1,
      updated_at = now()
  WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'dispatch.receipt_attached', 'operation', p_operation_id::text,
    jsonb_build_object(
      'receipt_slot_id', p_receipt_slot_id, 'receipt_hash', p_receipt_hash,
      'receipt_result', p_receipt_result, 'provider_request_id', p_provider_request_id
    )
  );
  RETURN jsonb_build_object(
    'outcome', 'recorded',
    'gate_state', 'receipt_recorded',
    'receipt_hash', p_receipt_hash
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Canonical checkpoint head
-- ---------------------------------------------------------------------------

-- CAS on expected revision/ref/hash. The first head inserts revision 0 under
-- the Task/Run lock with an empty expected base. A revoked or expired
-- fragment's candidate is refused even when otherwise valid, and a replay of
-- an already committed (execution, hash) returns the historical revision
-- instead of overwriting a newer head.
CREATE FUNCTION work.commit_runtime_checkpoint(
  p_org_id text,
  p_run_id uuid,
  p_execution_id uuid,
  p_expected_revision bigint,
  p_expected_ref text,
  p_expected_hash text,
  p_checkpoint_ref text,
  p_checkpoint_hash text,
  p_runtime_version text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  execution_row work.runtime_execution%ROWTYPE;
  head_row work.runtime_checkpoint_head%ROWTYPE;
  v_now timestamptz;
  v_revision bigint;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_content_ref('checkpoint_ref', p_checkpoint_ref);
  PERFORM work.assert_document_hash('checkpoint_hash', p_checkpoint_hash);
  PERFORM work.assert_runtime_identifier('runtime_version', p_runtime_version);
  IF (p_expected_ref IS NULL) <> (p_expected_hash IS NULL)
     OR (p_expected_revision IS NULL) <> (p_expected_hash IS NULL) THEN
    RAISE EXCEPTION 'invalid_request:expected_base' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision < 0 THEN
    RAISE EXCEPTION 'invalid_request:expected_revision' USING ERRCODE = '22023';
  END IF;

  run_row := work.lock_runtime_run(p_org_id, p_run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF execution_row.execution_id IS NULL OR execution_row.run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO head_row
  FROM work.runtime_checkpoint_head h
  WHERE h.org_id = p_org_id AND h.run_id = p_run_id
  FOR UPDATE;
  v_now := clock_timestamp();

  -- Replay of an already committed candidate: historical answer, no overwrite.
  IF head_row.run_id IS NOT NULL
     AND head_row.committed_execution_id = p_execution_id
     AND head_row.checkpoint_hash = p_checkpoint_hash
     AND head_row.checkpoint_ref = p_checkpoint_ref THEN
    RETURN head_row.checkpoint_revision;
  END IF;

  IF execution_row.state IN ('revoked', 'expired') THEN
    RAISE EXCEPTION 'runtime_execution_revoked' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- Refuse only; the expiry is committed by renew/register.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.input_checkpoint_hash IS DISTINCT FROM p_expected_hash
     OR execution_row.input_checkpoint_ref IS DISTINCT FROM p_expected_ref THEN
    RAISE EXCEPTION 'runtime_checkpoint_base_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF head_row.run_id IS NULL THEN
    IF p_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION 'runtime_checkpoint_head_missing' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO work.runtime_checkpoint_head
      (org_id, run_id, task_id, checkpoint_revision, checkpoint_ref, checkpoint_hash,
       runtime_version, committed_execution_id)
    VALUES
      (p_org_id, p_run_id, run_row.task_id, 0, p_checkpoint_ref, p_checkpoint_hash,
       p_runtime_version, p_execution_id);
    v_revision := 0;
  ELSE
    IF p_expected_revision IS NULL
       OR head_row.checkpoint_revision <> p_expected_revision
       OR head_row.checkpoint_ref <> p_expected_ref
       OR head_row.checkpoint_hash <> p_expected_hash THEN
      RAISE EXCEPTION 'runtime_checkpoint_cas_conflict' USING ERRCODE = 'P0001',
        DETAIL = head_row.checkpoint_revision::text;
    END IF;
    v_revision := head_row.checkpoint_revision + 1;
    UPDATE work.runtime_checkpoint_head h
    SET checkpoint_revision = v_revision,
        checkpoint_ref = p_checkpoint_ref,
        checkpoint_hash = p_checkpoint_hash,
        runtime_version = p_runtime_version,
        committed_execution_id = p_execution_id,
        updated_at = now()
    WHERE h.org_id = p_org_id AND h.run_id = p_run_id;
  END IF;

  UPDATE work.runtime_execution e
  SET state = 'completed', lease_until = NULL, terminal_reason = 'checkpoint_committed',
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.checkpoint_committed', 'run', p_run_id::text,
    jsonb_build_object(
      'execution_id', p_execution_id, 'checkpoint_revision', v_revision::text,
      'checkpoint_hash', p_checkpoint_hash, 'expected_revision',
      CASE WHEN p_expected_revision IS NULL THEN NULL ELSE p_expected_revision::text END
    )
  );
  RETURN v_revision;
END;
$$;

-- ---------------------------------------------------------------------------
-- Usage de-duplication and receipt-driven internal finishing
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.accumulate_usage_daily(
  p_org_id text,
  p_subject_id text,
  p_provider text,
  p_model text,
  p_usage_date date,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_runs int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  INSERT INTO work.usage_daily AS u
    (org_id, subject_id, provider, model, usage_date,
     input_tokens, output_tokens, cached_input_tokens, run_count, revision)
  VALUES
    (p_org_id, p_subject_id, p_provider, btrim(p_model), p_usage_date,
     GREATEST(0, p_input_tokens), GREATEST(0, p_output_tokens),
     GREATEST(0, p_cached_input_tokens), GREATEST(0, p_runs), 1)
  ON CONFLICT (org_id, subject_id, provider, model, usage_date) DO UPDATE
  SET input_tokens = GREATEST(0, u.input_tokens + p_input_tokens),
      output_tokens = GREATEST(0, u.output_tokens + p_output_tokens),
      cached_input_tokens = GREATEST(0, u.cached_input_tokens + p_cached_input_tokens),
      run_count = GREATEST(0, u.run_count + p_runs),
      revision = u.revision + 1,
      updated_at = now();
END;
$$;

-- 0008 recorded usage idempotency in a timestamp marker on work.operation.
-- The marker cannot carry the revision, the source receipt or the recorded
-- values, so it is replaced by the dedup fact. The signature is unchanged so
-- that the existing gateway path keeps working; the first fact for an
-- operation is what decides whether usage_daily may be touched.
CREATE OR REPLACE FUNCTION work.record_usage(
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  inserted int;
BEGIN
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) = 0 THEN
    RAISE EXCEPTION 'invalid_request:model' USING ERRCODE = '22023';
  END IF;
  IF p_usage_date IS NULL OR p_input_tokens IS NULL OR p_output_tokens IS NULL
     OR p_cached_input_tokens IS NULL
     OR p_input_tokens < 0 OR p_output_tokens < 0
     OR p_cached_input_tokens < 0 OR p_runs < 0 THEN
    RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.id = p_operation_id AND o.org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO work.operation_usage_fact
    (org_id, operation_id, usage_revision, origin, usage_source, subject_id,
     provider, model, usage_date, input_tokens, output_tokens,
     cached_input_tokens, counted_in_usage_daily)
  VALUES
    (p_org_id, p_operation_id, 1, 'command', 'provider', p_subject_id,
     p_provider, btrim(p_model), p_usage_date, p_input_tokens, p_output_tokens,
     p_cached_input_tokens, true)
  ON CONFLICT (org_id, operation_id, usage_revision) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    -- Already counted (including by the pre-0009 marker backfill).
    RETURN;
  END IF;
  UPDATE work.operation o
  SET usage_recorded_at = COALESCE(o.usage_recorded_at, now()), updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  PERFORM work.accumulate_usage_daily(
    p_org_id, p_subject_id, p_provider, p_model, p_usage_date,
    p_input_tokens, p_output_tokens, p_cached_input_tokens, p_runs
  );
END;
$$;

-- Receipt-driven internal finishing (D1 §5.4 回执与用量的原子收尾). The receipt
-- reference/hash is the idempotency input: the gate's terminal receipt is
-- verified under the Operation lock, usage is recorded through the dedup fact
-- first, then the Operation is confirmed and the reservation settled.
-- A confirmed success is never reversed to unknown: an already succeeded or
-- reconciled Operation only gets its missing internal steps recovered.
-- usage_source = 'unavailable' keeps NULL tokens, records no usage_daily and
-- does not settle; the reservation stays for usage reconciliation.
CREATE FUNCTION work.finish_operation_from_receipt(
  p_org_id text,
  p_operation_id uuid,
  p_receipt_hash text,
  p_usage_source text,
  p_provider text,
  p_model text,
  p_usage_date date,
  p_input_tokens bigint DEFAULT NULL,
  p_output_tokens bigint DEFAULT NULL,
  p_cached_input_tokens bigint DEFAULT NULL,
  p_settlement_tokens bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  fact_row work.operation_usage_fact%ROWTYPE;
  reservation work.quota_reservation%ROWTYPE;
  v_run_id uuid;
  v_subject_id text;
  v_usage_known boolean;
  v_usage_revision int;
  v_usage_note text := 'already_counted';
  v_counted boolean := false;
  v_settled boolean := false;
  v_settlement_tokens bigint;
  v_delta_input bigint;
  v_delta_output bigint;
  v_delta_cached bigint;
  v_outcome text;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_document_hash('receipt_hash', p_receipt_hash);
  IF p_usage_source IS NULL
     OR p_usage_source NOT IN ('provider', 'gateway_estimate', 'unavailable') THEN
    RAISE EXCEPTION 'invalid_request:usage_source' USING ERRCODE = '22023';
  END IF;
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) = 0 OR p_usage_date IS NULL THEN
    RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
  END IF;
  v_usage_known := p_usage_source IN ('provider', 'gateway_estimate');
  IF v_usage_known THEN
    IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_cached_input_tokens IS NULL
       OR p_input_tokens < 0 OR p_output_tokens < 0 OR p_cached_input_tokens < 0 THEN
      RAISE EXCEPTION 'invalid_request:usage_tokens' USING ERRCODE = '22023';
    END IF;
  ELSIF p_input_tokens IS NOT NULL OR p_output_tokens IS NOT NULL
        OR p_cached_input_tokens IS NOT NULL OR p_settlement_tokens IS NOT NULL THEN
    -- unavailable means unknown, never 0.
    RAISE EXCEPTION 'usage_unavailable_requires_null_tokens' USING ERRCODE = '22023';
  END IF;

  SELECT o.run_id INTO v_run_id
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, v_run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  v_subject_id := task_row.owner_subject_id;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO gate_row
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.operation_id = p_operation_id
  FOR UPDATE;

  IF gate_row.operation_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_gate_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF gate_row.gate_state <> 'receipt_recorded' THEN
    RAISE EXCEPTION 'dispatch_receipt_not_bound' USING ERRCODE = 'P0001',
      DETAIL = gate_row.gate_state;
  END IF;
  IF gate_row.receipt_hash IS DISTINCT FROM p_receipt_hash THEN
    RAISE EXCEPTION 'receipt_hash_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF gate_row.receipt_result <> 'success' THEN
    RAISE EXCEPTION 'receipt_not_successful' USING ERRCODE = 'P0001',
      DETAIL = gate_row.receipt_result;
  END IF;

  -- Usage first: the ledger must never be asked whether usage was counted.
  SELECT * INTO fact_row
  FROM work.operation_usage_fact f
  WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
  ORDER BY f.usage_revision DESC
  LIMIT 1;
  IF fact_row.id IS NULL THEN
    v_usage_revision := 1;
    INSERT INTO work.operation_usage_fact
      (org_id, operation_id, usage_revision, origin, usage_source, source_receipt_hash,
       subject_id, provider, model, usage_date, input_tokens, output_tokens,
       cached_input_tokens, counted_in_usage_daily)
    VALUES
      (p_org_id, p_operation_id, 1, 'command', p_usage_source, p_receipt_hash,
       v_subject_id, p_provider, btrim(p_model), p_usage_date,
       p_input_tokens, p_output_tokens, p_cached_input_tokens, v_usage_known);
    IF v_usage_known THEN
      PERFORM work.accumulate_usage_daily(
        p_org_id, v_subject_id, p_provider, p_model, p_usage_date,
        p_input_tokens, p_output_tokens, p_cached_input_tokens, 1
      );
      v_counted := true;
      v_usage_note := 'recorded';
    ELSE
      v_usage_note := 'unavailable_pending_reconciliation';
    END IF;
    UPDATE work.operation o
    SET usage_recorded_at = COALESCE(o.usage_recorded_at, now()), updated_at = now()
    WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  ELSIF fact_row.origin = 'legacy_marker_backfill' OR fact_row.source_receipt_hash IS NULL THEN
    -- Counted before this migration (or by the legacy gateway path): a replay
    -- must not add a second contribution to usage_daily.
    v_usage_revision := fact_row.usage_revision;
    v_usage_note := 'legacy_counted';
  ELSIF fact_row.source_receipt_hash IS DISTINCT FROM p_receipt_hash THEN
    RAISE EXCEPTION 'usage_receipt_conflict' USING ERRCODE = 'P0001';
  ELSIF fact_row.usage_source = p_usage_source
        AND fact_row.input_tokens IS NOT DISTINCT FROM p_input_tokens
        AND fact_row.output_tokens IS NOT DISTINCT FROM p_output_tokens
        AND fact_row.cached_input_tokens IS NOT DISTINCT FROM p_cached_input_tokens THEN
    v_usage_revision := fact_row.usage_revision;
    v_usage_note := 'already_counted';
  ELSIF NOT v_usage_known THEN
    RAISE EXCEPTION 'usage_source_downgrade' USING ERRCODE = 'P0001';
  ELSE
    -- Versioned correction: a new revision applies only the difference.
    v_usage_revision := fact_row.usage_revision + 1;
    v_delta_input := p_input_tokens - COALESCE(fact_row.input_tokens, 0);
    v_delta_output := p_output_tokens - COALESCE(fact_row.output_tokens, 0);
    v_delta_cached := p_cached_input_tokens - COALESCE(fact_row.cached_input_tokens, 0);
    INSERT INTO work.operation_usage_fact
      (org_id, operation_id, usage_revision, origin, usage_source, source_receipt_hash,
       subject_id, provider, model, usage_date, input_tokens, output_tokens,
       cached_input_tokens, counted_in_usage_daily)
    VALUES
      (p_org_id, p_operation_id, v_usage_revision, 'command', p_usage_source, p_receipt_hash,
       v_subject_id, p_provider, btrim(p_model), p_usage_date,
       p_input_tokens, p_output_tokens, p_cached_input_tokens, true);
    PERFORM work.accumulate_usage_daily(
      p_org_id, v_subject_id, p_provider, p_model, p_usage_date,
      v_delta_input, v_delta_output, v_delta_cached,
      CASE WHEN fact_row.counted_in_usage_daily THEN 0 ELSE 1 END
    );
    v_counted := true;
    v_usage_note := 'revised';
  END IF;

  -- Confirm the Operation. A confirmed success is only ever recovered forward.
  IF operation_row.state = 'dispatching' THEN
    PERFORM work.finish_operation(
      p_org_id, p_operation_id, 'succeeded',
      gate_row.provider_request_id, gate_row.receipt_ref
    );
    v_outcome := 'confirmed';
  ELSIF operation_row.state IN ('unknown', 'unresolved') THEN
    IF NOT v_usage_known THEN
      RAISE EXCEPTION 'usage_required_for_reconcile' USING ERRCODE = 'P0001';
    END IF;
    v_settlement_tokens := COALESCE(p_settlement_tokens, p_input_tokens + p_output_tokens);
    PERFORM work.reconcile_operation(
      p_org_id, p_operation_id, 'sent_succeeded',
      gate_row.provider_request_id, v_settlement_tokens, gate_row.receipt_ref
    );
    v_settled := true;
    v_outcome := 'confirmed';
  ELSIF operation_row.state IN ('succeeded', 'reconciled') THEN
    v_outcome := 'already_confirmed';
  ELSE
    RAISE EXCEPTION 'operation_not_confirmable' USING ERRCODE = 'P0001',
      DETAIL = operation_row.state;
  END IF;

  -- Settlement recovery: held/unknown reservations settle once usage is known.
  IF NOT v_settled AND v_usage_known THEN
    SELECT * INTO reservation
    FROM work.quota_reservation br
    WHERE br.org_id = p_org_id AND br.operation_id = p_operation_id
    ORDER BY br.reservation_seq DESC
    LIMIT 1
    FOR UPDATE;
    IF reservation.id IS NOT NULL AND reservation.state IN ('held', 'unknown') THEN
      v_settlement_tokens := COALESCE(p_settlement_tokens, p_input_tokens + p_output_tokens);
      PERFORM work.settle_quota(
        reservation.id, v_settlement_tokens,
        jsonb_build_object(
          'resolution', 'receipt_confirmed',
          'receipt_hash', p_receipt_hash,
          'usage_source', p_usage_source,
          'usage_revision', v_usage_revision
        ),
        reservation.settlement_revision + 1
      );
      v_settled := true;
    END IF;
  END IF;

  PERFORM work.append_audit(
    p_org_id, NULL, 'operation.finish_from_receipt', 'operation', p_operation_id::text,
    jsonb_build_object(
      'outcome', v_outcome,
      'receipt_hash', p_receipt_hash,
      'usage_source', p_usage_source,
      'usage_revision', v_usage_revision,
      'usage', v_usage_note,
      'settled', v_settled
    )
  );
  RETURN jsonb_build_object(
    'outcome', v_outcome,
    'usage', v_usage_note,
    'usage_revision', v_usage_revision,
    'usage_counted', v_counted,
    'settled', v_settled
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: only work_worker, the control plane's internal execution
-- authorization module identity. No new roles, no table-level DML, and
-- nothing for work_api/work_directory.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.runtime_lease_seconds() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.runtime_hard_deadline_max_seconds() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.assert_runtime_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.assert_runtime_identifier(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.assert_document_hash(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.assert_content_ref(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.lock_runtime_run(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.assert_org_execution_enabled(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.runtime_execution_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.dispatch_delivery_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.runtime_checkpoint_head_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.accumulate_usage_daily(text, text, text, text, date, bigint, bigint, bigint, int) FROM PUBLIC;

REVOKE ALL ON FUNCTION work.register_runtime_execution(
  text, uuid, uuid, text, bigint, text, timestamptz, text, text, text, text, text, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.claim_runtime_execution(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.renew_runtime_execution(text, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.revoke_runtime_execution(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_dispatch_delivery(
  text, uuid, uuid, text, uuid, text, bigint, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.seal_dispatch_not_sent(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.attach_dispatch_receipt(
  text, uuid, uuid, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.commit_runtime_checkpoint(
  text, uuid, uuid, bigint, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.finish_operation_from_receipt(
  text, uuid, text, text, text, text, date, bigint, bigint, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_usage(
  text, text, uuid, text, text, date, bigint, bigint, bigint, int
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.register_runtime_execution(
  text, uuid, uuid, text, bigint, text, timestamptz, text, text, text, text, text, uuid, uuid
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.claim_runtime_execution(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.renew_runtime_execution(text, uuid, text, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.revoke_runtime_execution(text, uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_dispatch_delivery(
  text, uuid, uuid, text, uuid, text, bigint, text, uuid
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.seal_dispatch_not_sent(text, uuid, text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.attach_dispatch_receipt(
  text, uuid, uuid, text, text, text, text, text
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.commit_runtime_checkpoint(
  text, uuid, uuid, bigint, text, text, text, text, text
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_operation_from_receipt(
  text, uuid, text, text, text, text, date, bigint, bigint, bigint, bigint
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.record_usage(
  text, text, uuid, text, text, date, bigint, bigint, bigint, int
) TO work_worker;

-- Receipt-driven finishing reads the gate and the bound fragment under the
-- worker's own role. Table SELECT matches how the existing activities read
-- run/operation facts; FORCE RLS and the org context still apply.
GRANT SELECT ON work.dispatch_delivery TO work_worker;
GRANT SELECT ON work.runtime_execution TO work_worker;

RESET ROLE;
